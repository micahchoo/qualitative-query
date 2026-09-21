/**
 * Does carrying several passages in one request change the score?
 *
 * The baseline is a pipeline capture: passages already scored one per request. This re-scores
 * the same passages at each batch size through the shipped client, and reports what moved.
 * Nothing here writes to the plugin's score cache or to the vault.
 *
 *   TYPESAFE_API_KEY=… npm run probe:batching -- <capture.json> [--sizes 1,10,25] [--sample 200]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { JevClient } from "../src/jev";
import { PassageBatcher } from "../src/batch";
import type { QueryCriteria } from "../src/types";

// The batcher schedules its flush on the window timer that Obsidian provides.
((globalThis as { window?: unknown }).window ??= globalThis);

interface CapturedCandidate { id: string; rank: number; path: string; text: string }
interface CapturedJudgement { score: number; contribution: string; candidate: { id: string } }
interface Capture { model: string; spec: { question: string; criteria: QueryCriteria; threshold?: number; limit?: number }; candidates: CapturedCandidate[]; judgements: CapturedJudgement[] }

const args = process.argv.slice(2);
const capturePath = args.find(argument => !argument.startsWith("--"));
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (!capturePath) throw new Error("Usage: probe-batching <capture.json> [--sizes 1,10,25] [--sample 200]");
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY. The probe sends captured passages to api.typesafe.ai.");

const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Capture;
const sizes = option("sizes", "1,10,25").split(",").map(Number).filter(size => size >= 1);
const sample = Number(option("sample", "200"));
const threshold = capture.spec.threshold ?? 0.5;
const limit = capture.spec.limit ?? 6;

const baseline = new Map(capture.judgements.map(judgement => [judgement.candidate.id, judgement.score]));
const passages = capture.candidates.filter(candidate => baseline.has(candidate.id)).slice(0, sample);
if (!passages.length) throw new Error("The capture holds no scored candidates.");

const score = (answers: { answers: Record<string, { noul?: number; choice?: string }> }): number => {
  const values = capture.spec.criteria.mode === "generic"
    ? [answers.answers.relevant?.noul]
    : [answers.answers.definition?.noul, answers.answers.condition?.noul, answers.answers.distinction?.noul];
  const numbers = values.filter((value): value is number => typeof value === "number");
  if (!numbers.length) throw new Error(`Jev returned no usable score: ${JSON.stringify(answers).slice(0, 200)}`);
  return Math.max(...numbers);
};

const spearman = (pairs: Array<[number, number]>): number => {
  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
    const ranks = new Array<number>(values.length);
    order.forEach((entry, position) => { ranks[entry.index] = position + 1; });
    return ranks;
  };
  const left = rank(pairs.map(pair => pair[0])), right = rank(pairs.map(pair => pair[1]));
  const n = pairs.length;
  const sum = left.reduce((total, value, index) => total + (value - right[index]) ** 2, 0);
  return 1 - (6 * sum) / (n * (n * n - 1));
};

const topIds = (scores: Map<string, number>): string[] =>
  [...scores].filter(([, value]) => value >= threshold).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);

const baselineTop = topIds(new Map(passages.map(passage => [passage.id, baseline.get(passage.id)!])));
const report: Record<string, unknown>[] = [];

for (const size of sizes) {
  const client = new JevClient(apiKey, capture.model);
  const batcher = new PassageBatcher(client, size);
  const scores = new Map<string, number>();
  let requests = 0, inputTokens = 0;
  const hooks = { onRequest: (info: { inputTokens: number }) => { requests++; inputTokens += info.inputTokens; } };
  const started = Date.now();
  // Sixteen passages in flight per request slot, the same shape the plugin runs.
  const queue = [...passages];
  const workers = Array.from({ length: 16 * size }, async () => {
    while (queue.length) {
      const passage = queue.shift();
      if (!passage) return;
      scores.set(passage.id, score(await batcher.rank(capture.spec.question, passage.text, capture.spec.criteria, "", hooks)));
    }
  });
  await Promise.all(workers);
  const elapsed = (Date.now() - started) / 1000;
  batcher.dispose();

  const pairs = passages.map(passage => [baseline.get(passage.id)!, scores.get(passage.id)!] as [number, number]);
  const drift = pairs.map(([before, after]) => Math.abs(before - after));
  const crossings = pairs.filter(([before, after]) => (before >= threshold) !== (after >= threshold)).length;
  const kept = topIds(scores).filter(id => baselineTop.includes(id)).length;
  const row = {
    batch: size, passages: passages.length, requests, seconds: Number(elapsed.toFixed(1)), inputTokens,
    meanDrift: Number((drift.reduce((total, value) => total + value, 0) / drift.length).toFixed(3)),
    maxDrift: Number(Math.max(...drift).toFixed(3)),
    spearman: Number(spearman(pairs).toFixed(3)),
    thresholdCrossings: crossings,
    topKept: `${kept}/${baselineTop.length}`,
  };
  report.push(row);
  console.log(JSON.stringify(row));
}

const out = capturePath.replace(/\.json$/, "") + ".batching.json";
writeFileSync(out, JSON.stringify({ capture: capturePath, threshold, limit, rows: report }, null, 2));
console.log(`\nWrote ${out}`);
console.table(report);
