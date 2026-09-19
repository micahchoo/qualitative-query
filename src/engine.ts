import type { RetrievalResult } from "./retrieval";
import type { ScoreCache } from "./score-cache";
import { MAX_CANDIDATES } from "./limits";
import { shortlist } from "./search";
import { JevClient } from "./jev";
import type { Block, Candidate, Contribution, Judgement, QueryResult, QuerySpec } from "./types";

const MAX_PASSAGE_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 48_000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CONCURRENCY = 16;


type ContextReader = (path: string) => Block[] | Promise<Block[]>;
type WarningResult = QueryResult & { warning?: string };

class QueryRunSuperseded extends Error {
  constructor() { super("This query was superseded by a newer query."); }
}

interface QueueItem {
  generation: number;
  current: () => boolean;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

class ConcurrencyGate {
  private running = 0;
  private limit = MAX_CONCURRENCY;
  private lastThrottle = -Infinity;
  private successes = 0;

  throttle(): void {
    const now = Date.now();
    if (now - this.lastThrottle >= 1000) this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.lastThrottle = now; this.successes = 0;
  }

  success(): void {
    if (Date.now() - this.lastThrottle >= 5000 && ++this.successes >= 32) {
      this.limit = Math.min(MAX_CONCURRENCY, this.limit + 1); this.successes = 0;
      this.pump();
    }
  }
  private queue: QueueItem[] = [];

  acquire(generation: number, current: () => boolean): Promise<() => void> {
    if (!current()) return Promise.reject(new QueryRunSuperseded());
    return new Promise((resolve, reject) => {
      this.queue.push({ generation, current, resolve, reject });
      this.pump();
    });
  }

  cancelStale(generation: number): void {
    const retained: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.generation < generation) item.reject(new QueryRunSuperseded());
      else retained.push(item);
    }
    this.queue = retained;
  }

  private pump(): void {
    while (this.running < this.limit && this.queue.length) {
      const item = this.queue.shift()!;
      if (!item.current()) { item.reject(new QueryRunSuperseded()); continue; }
      this.running++;
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        this.pump();
      });
    }
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function span(block: Block): number { return Math.max(0, block.lineEnd - block.lineStart); }

/** Remove parent/child duplicates while retaining the most complete passage. */
function dedupeRanges<T extends Block>(blocks: T[]): T[] {
  const selected: T[] = [];
  const ordered = [...blocks].sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  for (const block of ordered) {
    const overlapping = selected.findIndex((other) => other.path === block.path && other.lineStart <= block.lineEnd && block.lineStart <= other.lineEnd);
    if (overlapping < 0) { selected.push(block); continue; }
    const existing = selected[overlapping];
    if (span(block) > span(existing)) selected[overlapping] = block;
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart || a.id.localeCompare(b.id));
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  // Score first so a broad ancestor cannot hide a better focused child.
  const ranked = [...candidates].sort((a, b) => (b.retrievalScore ?? b.lexicalScore) - (a.retrievalScore ?? a.lexicalScore) || span(a) - span(b) || a.id.localeCompare(b.id));
  for (const candidate of ranked) {
    if (selected.some((other) => other.path === candidate.path && other.lineStart <= candidate.lineEnd && candidate.lineStart <= other.lineEnd)) continue;
    selected.push(candidate);
  }
  return selected;
}

function displayText(block: Block): string { return block.renderText ?? block.text; }
function modelText(block: Block): string {
  const heading = block.headingPath.length ? `[Headings: ${block.headingPath.join(" > ")}]\n` : "";
  return `${heading}${displayText(block)}`;
}

export class QueryEngine {
  private cache = new Map<string, Judgement>();
  private inFlight = new Map<string, { generation: number; promise: Promise<Judgement> }>();
  private generation = 0;
  private disposed = false;
  private readonly gate = new ConcurrencyGate();

  constructor(
    private readonly client: Pick<JevClient, "rank"> | null,
    private readonly getBlocks: () => Block[],
    private readonly getSourceBlocks: ContextReader = () => [],
    /** Include provider/model identity when an engine is reused across clients. */
    private readonly cacheNamespace = "",
    private readonly persistentCache?: Pick<ScoreCache, "get" | "set"> & Partial<Pick<ScoreCache, "getMany">>,
    private readonly retrieve: (question: string, blocks: Block[], limit: number) => RetrievalResult | Promise<RetrievalResult> = (question, blocks, limit) => ({ candidates: shortlist(question, blocks, limit) }),
  ) {}

  clearCache(): void { this.cache.clear(); }

  invalidate(): void {
    this.generation++;
    this.gate.cancelStale(this.generation);
  }

  dispose(): void { this.disposed = true; this.invalidate(); this.cache.clear(); this.inFlight.clear(); }

  async run(spec: QuerySpec, candidateLimit: number, limit: number, threshold: number, onProgress?: (completed: number, total: number) => void, onPartial?: (result: QueryResult) => void): Promise<QueryResult> {
    if (this.disposed) return { status: "error", candidates: [], judgements: [], error: "The query engine is unavailable." };
    const generation = this.generation;
    const corpus = this.getBlocks();
    let context: string;
    try { context = await this.readContext(spec.contextPaths); }
    catch (error) { return { status: "error", candidates: [], judgements: [], error: error instanceof Error ? error.message : String(error) }; }
    if (context.length > MAX_CONTEXT_CHARS) return { status: "error", candidates: [], judgements: [], error: "The selected context is too large for one evaluation. Remove some context notes or split the query." };
    const retrieval = await this.retrieve(spec.question, corpus, Math.min(MAX_CANDIDATES, Math.max(1, candidateLimit)));
    const candidates = dedupeCandidates(retrieval.candidates);
    const warning = (message?: string) => [retrieval.warning, message].filter(Boolean).join(" ") || undefined;
    this.assertCurrent(generation);
    if (!candidates.length) return { status: "empty", candidates, judgements: [], warning: warning() };
    if (!this.client) {
      const ranked = [...candidates].sort((a, b) => (b.retrievalScore ?? b.lexicalScore) - (a.retrievalScore ?? a.lexicalScore) || a.id.localeCompare(b.id));
      return { status: "ready", selection: "local", candidates,
        warning: warning("Local matches. Add a Jev API key in settings to select and order passages by how well they answer your question."),
        judgements: ranked.slice(0, spec.limit ?? limit).map(candidate => ({ candidate, score: candidate.retrievalScore ?? candidate.lexicalScore, contribution: "other", scores: {} })),
      };
    }

    const judgements: Judgement[] = [];
    const skipped = candidates.filter((candidate) => displayText(candidate).length > MAX_PASSAGE_CHARS);
    const judgeable = candidates.filter((candidate) => displayText(candidate).length <= MAX_PASSAGE_CHARS);
    const order: Record<Contribution, number> = { definition: 0, condition: 1, distinction: 2, other: 3 };
    const selection = () => [...judgements].sort((a, b) => spec.criteria.mode === "default"
      ? order[a.contribution] - order[b.contribution] || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)
      : b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, spec.limit ?? limit);
    let completed = 0;
    onProgress?.(completed, judgeable.length);
    const keys = judgeable.map(candidate => this.scoreKey(spec, candidate, context));
    const persisted = await this.readScores(keys);
    this.assertCurrent(generation);
    // Preserve existing location-based entries; promote them lazily without rescoring.
    const missing = judgeable.filter((_, i) => !persisted.has(keys[i]) && !this.cache.has(keys[i]));
    const legacy = await this.readScores(missing.map(candidate => this.scoreKey(spec, candidate, context, true)));
    this.assertCurrent(generation);
    for (const candidate of missing) {
      const value = legacy.get(this.scoreKey(spec, candidate, context, true));
      if (value) {
        const key = this.scoreKey(spec, candidate, context);
        persisted.set(key, value);
        await this.persistentCache?.set(key, value);
      }
    }
    this.assertCurrent(generation);
    let lastPartial = -Infinity;
    const publish = () => {
      if (Date.now() - lastPartial >= 250 || completed === judgeable.length) {
        lastPartial = Date.now();
        onPartial?.({ status: "ready", selection: "jev", candidates, judgements: selection(), warning: warning("Still checking passages. Results may change.") });
      }
    };
    const pending = judgeable.filter(candidate => {
      const key = this.scoreKey(spec, candidate, context);
      const value = this.cache.get(key) ?? persisted.get(key);
      if (!value) return true;
      if (value.score >= threshold) judgements.push({ ...value, candidate });
      completed++; return false;
    });
    if (completed) { onProgress?.(completed, judgeable.length); publish(); }
    await Promise.all(pending.map(async (candidate) => {
      try {
        const value = await this.judge(spec, candidate, context, generation);
        if (value.score >= threshold) judgements.push(value);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "INPUT_TOO_LARGE") skipped.push(candidate);
        else throw error;
      }
      this.assertCurrent(generation);
      onProgress?.(++completed, judgeable.length);
      publish();
    }));
    this.assertCurrent(generation);
    if (!judgements.length) {
      const result: WarningResult = { status: "empty", candidates, judgements: [], error: skipped.length ? "No checked passages met the minimum score. Broaden the question or lower its threshold." : "No passages met the minimum score. Broaden the question or lower its threshold." };
      if (skipped.length) result.warning = `${skipped.length} passage${skipped.length === 1 ? " was" : "s were"} skipped because they exceed the model input limit.`;
      result.warning = warning(result.warning);
      return result;
    }
    const result: WarningResult = { status: "ready", selection: "jev", candidates, judgements: selection() };
    if (skipped.length) result.warning = `${skipped.length} passage${skipped.length === 1 ? " was" : "s were"} skipped because they exceed the model input limit.`;
    result.warning = warning(result.warning);
    return result;
  }

  private async readContext(paths: string[]): Promise<string> {
    const blocks: Block[] = [];
    for (const path of paths) {
      const pathBlocks = (await this.getSourceBlocks(path)).filter((block) => block.path === path);
      blocks.push(...dedupeRanges(pathBlocks));
    }
    return blocks.map(modelText).join("\n\n");
  }

  private scoreKey(spec: QuerySpec, candidate: Candidate, context: string, legacy = false): string {
    const text = modelText(candidate);
    return stable({ namespace: this.cacheNamespace, question: spec.question, criteria: spec.criteria, context,
      ...(legacy ? { candidate: { id: candidate.id, path: candidate.path, lineStart: candidate.lineStart, lineEnd: candidate.lineEnd, headingPath: candidate.headingPath, text } }
        : { passage: text, keyVersion: 2 }) });
  }

  private async readScores(keys: string[]): Promise<Map<string, Omit<Judgement, "candidate">>> {
    if (!this.persistentCache || !keys.length) return new Map();
    if (this.persistentCache.getMany) return this.persistentCache.getMany(keys);
    const values = new Map<string, Omit<Judgement, "candidate">>();
    await Promise.all(keys.map(async key => { const value = await this.persistentCache!.get(key); if (value) values.set(key, value); }));
    return values;
  }

  private async judge(spec: QuerySpec, candidate: Candidate, context: string, generation: number): Promise<Judgement> {
    this.assertCurrent(generation);
    const passage = modelText(candidate);
    const key = this.scoreKey(spec, candidate, context);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return { ...cached, candidate };
    }
    const existing = this.inFlight.get(key);
    if (existing?.generation === generation) return { ...(await existing.promise), candidate };
    const request = (async () => {
      const release = await this.gate.acquire(generation, () => !this.disposed && generation === this.generation);
      try {
        this.assertCurrent(generation);
        const response = await this.client!.rank(spec.question, passage, spec.criteria, context, () => this.gate.throttle());
        this.gate.success();
        release();
        this.assertCurrent(generation);
        const judgement = this.validateResponse(response, spec, candidate);
        this.cache.set(key, judgement);
        if (this.persistentCache) {
          const { candidate: _candidate, ...score } = judgement;
          await this.persistentCache.set(key, score);
          this.assertCurrent(generation);
        }
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        return judgement;
      } finally { release(); }
    })();
    const entry = { generation, promise: request };
    this.inFlight.set(key, entry);
    try { return { ...(await request), candidate }; }
    finally { if (this.inFlight.get(key) === entry) this.inFlight.delete(key); }
  }

  private validateResponse(response: unknown, spec: QuerySpec, candidate: Candidate): Judgement {
    if (!response || typeof response !== "object" || !("answers" in response) || !response.answers || typeof response.answers !== "object") throw new Error("The decision model returned an invalid response: answers are missing.");
    const answers = response.answers as Record<string, { noul?: unknown; choice?: unknown }>;
    const scores: Record<string, number> = {};
    const score = (id: string): number => {
      const value = answers[id]?.noul;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`The decision model returned an invalid score for “${id}”.`);
      scores[id] = value;
      return value;
    };
    let resultScore: number;
    let contribution: Contribution = "other";
    if (spec.criteria.mode === "generic") resultScore = score("relevant");
    else {
      const values = [score("definition"), score("condition"), score("distinction")];
      const choice = answers.contribution?.choice;
      if (choice !== "definition" && choice !== "condition" && choice !== "distinction" && choice !== "other") throw new Error("The decision model returned an invalid contribution choice.");
      contribution = choice;
      resultScore = Math.max(...values);
    }
    return { candidate, score: resultScore, contribution, scores };
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new QueryRunSuperseded();
  }
}
