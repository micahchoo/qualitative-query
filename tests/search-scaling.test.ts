import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { shortlistAsync, prepareSearchBlocks, hybridShortlistAsync } from "../src/search";
import { TopK } from "../src/top-k";
import { SharedWork } from "../src/work";
import type { Block, Candidate } from "../src/types";

const block = (id: number, text: string): Block => ({ id: `${id % 3 === 0 ? "a" : "Z"}-${id}`, path: `${id}.md`, lineStart: 1, lineEnd: 1, text, searchText: text, kind: "paragraph", headingPath: [] });
/** Ranking captured 2026-09-21 from the reference full-scan BM25, before that implementation was deleted. */
const reference: Record<string, Array<[string, number]>> = JSON.parse(readFileSync(new URL("./fixtures/bm25-reference.json", import.meta.url), "utf8"));
const scored = (candidates: Candidate[], key: "lexicalScore" | "retrievalScore") => candidates.map(candidate => [candidate.id, candidate[key]]);

it("matches the reference BM25 ordering, exact scores and duplicate preference", async () => {
  let seed = 13;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const words = ["conflict", "mediation", "peace", "work", "art", "other"];
  const blocks = Array.from({ length: 600 }, (_, i) => block(i, Array.from({ length: 1 + random() % 30 }, () => words[random() % words.length]).join(" ")));
  blocks.push(block(601, blocks[5].text.replaceAll(" ", "  ")), block(602, blocks[5].text));
  prepareSearchBlocks(blocks);
  for (const question of ["conflict mediation art", "art conflict mediation", "peace peace", "missing", "the and"]) {
    for (const limit of [1, 6, 32, 1000]) {
      expect(scored(await shortlistAsync(question, blocks, limit), "lexicalScore")).toEqual(reference[`${question}|${limit}`]);
    }
  }
  const keywords = await shortlistAsync("conflict", blocks, 100);
  const hits = blocks.slice(30, 100).map((value, i) => ({ id: value.id, score: 0.8 - i / 1000 }));
  expect(scored(await hybridShortlistAsync("conflict", blocks, hits, 20, keywords), "retrievalScore")).toEqual(reference.hybrid);
});

it("builds postings once for concurrent questions and never rescans a warm corpus", async () => {
  const data = Array.from({ length: 1000 }, (_, i) => block(i, `conflict ${i}`));
  let traversals = 0;
  const corpus = new Proxy(data, { get(target, property, receiver) { if (property === Symbol.iterator) traversals++; return Reflect.get(target, property, receiver); } });
  await Promise.all(Array.from({ length: 10 }, (_, i) => shortlistAsync(`conflict ${i}`, corpus, 6)));
  expect(traversals).toBe(1);
  await shortlistAsync("999", corpus, 6);
  expect(traversals).toBe(1);
});

it("can cancel a cold corpus and immediately start a replacement", async () => {
  const blocks = Array.from({ length: 1000 }, (_, i) => block(i, `conflict ${i}`));
  const controller = new AbortController();
  const stale = shortlistAsync("conflict", blocks, 6, controller.signal);
  controller.abort();
  const current = shortlistAsync("conflict", blocks, 6);
  await expect(stale).rejects.toThrow(/cancelled/);
  // A fresh array is a fresh corpus: the same answer computed without the cancelled build.
  expect(await current).toEqual(await shortlistAsync("conflict", [...blocks], 6));
});

it("retains exact top-K ordering with logarithmic comparison count", () => {
  let comparisons = 0;
  const compare = (a: number, b: number) => { comparisons++; return b - a; };
  const count = 50_000, limit = 4000;
  const top = new TopK(limit, compare);
  for (let i = 0; i < count; i++) top.add(i);
  expect(top.sorted()).toEqual(Array.from({ length: limit }, (_, i) => count - i - 1));
  expect(comparisons).toBeLessThan(count * (2 * Math.ceil(Math.log2(limit)) + 3));
});

it("does not abort shared work when one of two consumers closes", async () => {
  let complete!: (value: number) => void;
  let signal!: AbortSignal;
  const retired = vi.fn();
  const work = new SharedWork<number>(async owned => { signal = owned; return new Promise(resolve => { complete = resolve; }); }, retired);
  const controller = new AbortController();
  const first = work.join(controller.signal), second = work.join();
  await Promise.resolve();
  controller.abort();
  await expect(first).rejects.toThrow(/cancelled/);
  expect(signal.aborted).toBe(false);
  complete(7);
  expect(await second).toBe(7);
  expect(retired).toHaveBeenCalledTimes(1);
});

it("retires cancelled shared work exactly once even if its operation settles later", async () => {
  let complete!: (value: number) => void;
  const retired = vi.fn();
  const work = new SharedWork<number>(async () => new Promise(resolve => { complete = resolve; }), retired);
  const controller = new AbortController();
  const result = work.join(controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toThrow(/cancelled/);
  complete(1);
  await Promise.resolve(); await Promise.resolve();
  expect(retired).toHaveBeenCalledTimes(1);
});

it("preserves deterministic text ties in a bounded heap", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), score: i % 13 }));
  const compare = (a: typeof rows[0], b: typeof rows[0]) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const top = new TopK<typeof rows[0]>(77, compare);
  for (const row of rows) top.add(row);
  expect(top.sorted()).toEqual(rows.sort(compare).slice(0, 77));
});

it("preserves best representatives and duplicate fill across many differently headed copies", async () => {
  const make = () => Array.from({ length: 2500 }, (_, i) => {
    const value = block(i, `Repeated conflict passage ${i % 173}`);
    value.searchText = `${value.text} ${i % 3 === 0 ? "mediation mediation" : "art"}`;
    return value;
  });
  const blocks = make();
  for (const question of ["conflict", "mediation art", "art 7", "mediation"]) {
    for (const limit of [6, 1000, 4000]) {
      const result = await shortlistAsync(question, blocks, limit);
      const texts = result.map(candidate => candidate.text);
      const firstRepeat = texts.findIndex((text, i) => texts.indexOf(text) < i);
      // Every distinct passage comes before any archived copy of one already listed.
      const distinctCount = new Set(texts).size;
      expect(firstRepeat === -1 ? texts.length : firstRepeat).toBe(distinctCount);
      expect(result.length).toBe(Math.min(limit, result.length));
      // The same answer from a cold corpus.
      expect(await shortlistAsync(question, make(), limit)).toEqual(result);
    }
  }
});
