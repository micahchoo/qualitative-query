import { checkSignal, SharedWork } from "./work";
import type { RetrievalResult } from "./retrieval";
import type { ScoreCache } from "./score-cache";
import { MAX_CANDIDATES, MAX_CONTEXT_CHARS } from "./limits";
import type { JevRanker } from "./jev";
import { modelText, scoreKey } from "./score-identity";
import { displayText } from "./markdown";
import type { Block, Candidate, Contribution, Judgement, QueryResult, QuerySpec, QueryStats } from "./types";

const MAX_PASSAGE_CHARS = 24_000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CONCURRENCY = 16;


type ContextReader = (path: string) => Block[] | Promise<Block[]>;
/** Local retrieval: the shortlist a question is judged from. `LocalRetrieval.search` in production. */
export type Retrieval = (question: string, blocks: Block[], limit: number, signal?: AbortSignal) => RetrievalResult | Promise<RetrievalResult>;
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

/** Slots are passages. One request carries `step` of them, so the cap moves a request at a time. */
class ConcurrencyGate {
  private running = 0;
  private readonly maximum: number;
  private limit: number;
  private lastThrottle = -Infinity;
  private successes = 0;

  constructor(private readonly step = 1) {
    this.maximum = this.limit = MAX_CONCURRENCY * step;
  }

  throttle(): void {
    const now = Date.now();
    if (now - this.lastThrottle >= 1000) this.limit = Math.max(this.step, Math.floor(this.limit / 2));
    this.lastThrottle = now; this.successes = 0;
  }

  /** One extra request per window of successes: halving costs one window to undo, not sixteen. */
  success(): void {
    if (Date.now() - this.lastThrottle >= 5000 && ++this.successes >= this.limit) {
      this.limit = Math.min(this.maximum, this.limit + this.step); this.successes = 0;
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
      if (item.generation < generation || !item.current()) item.reject(new QueryRunSuperseded());
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

function span(block: Block): number { return Math.max(0, block.lineEnd - block.lineStart); }

/** Remove parent/child duplicates while retaining the most complete passage. */
function dedupeRanges<T extends Block>(blocks: T[]): T[] {
  const selected: T[] = [];
  const ordered = [...blocks].sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  for (const block of ordered) {
    // Source-order sorting means only the last selected range can overlap.
    const existing = selected[selected.length - 1];
    if (!existing || existing.path !== block.path || existing.lineEnd < block.lineStart) { selected.push(block); continue; }
    if (span(block) > span(existing)) selected[selected.length - 1] = block;
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart || a.id.localeCompare(b.id));
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  const ranges = new Map<string, Candidate[]>();
  // Score first so a broad ancestor cannot hide a better focused child.
  const ranked = [...candidates].sort((a, b) => (b.retrievalScore ?? b.lexicalScore) - (a.retrievalScore ?? a.lexicalScore) || span(a) - span(b) || a.id.localeCompare(b.id));
  for (const candidate of ranked) {
    const file = ranges.get(candidate.path) ?? [];
    let low = 0, high = file.length;
    while (low < high) { const mid = (low + high) >>> 1; if (file[mid].lineStart < candidate.lineStart) low = mid + 1; else high = mid; }
    if ((low > 0 && file[low - 1].lineEnd >= candidate.lineStart) || (low < file.length && file[low].lineStart <= candidate.lineEnd)) continue;
    file.splice(low, 0, candidate);
    ranges.set(candidate.path, file);
    selected.push(candidate);
  }
  return selected;
}

export class QueryEngine {
  private cache = new Map<string, Judgement>();
  private inFlight = new Map<string, SharedWork<Judgement>>();
  private runs = new Set<AbortController>();
  private generation = 0;
  private disposed = false;
  private readonly gate: ConcurrencyGate;

  constructor(
    private readonly client: JevRanker | null,
    private readonly getBlocks: () => Block[],
    private readonly retrieve: Retrieval,
    private readonly getSourceBlocks: ContextReader = () => [],
    /** Include provider/model identity when an engine is reused across clients. */
    private readonly cacheNamespace = "",
    private readonly persistentCache?: Pick<ScoreCache, "get" | "set"> & Partial<Pick<ScoreCache, "getMany">>,
  ) {
    // Hold enough passages in flight to fill the client's batches; requests stay near the cap.
    this.gate = new ConcurrencyGate(Math.max(1, client?.batchSize ?? 1));
  }

  invalidate(): void {
    this.generation++;
    for (const run of this.runs) run.abort();
    this.gate.cancelStale(this.generation);
  }

  dispose(): void { this.disposed = true; this.invalidate(); this.cache.clear(); this.inFlight.clear(); }

  async run(spec: QuerySpec, candidateLimit: number, limit: number, threshold: number, onProgress?: (completed: number, total: number) => void, onPartial?: (result: QueryResult) => void, signal?: AbortSignal): Promise<QueryResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.runs.add(controller);
    try { return await this.runOwned(spec, candidateLimit, limit, threshold, onProgress, onPartial, controller.signal); }
    finally { controller.abort(); this.runs.delete(controller); signal?.removeEventListener("abort", abort); }
  }

  private async runOwned(spec: QuerySpec, candidateLimit: number, limit: number, threshold: number, onProgress: ((completed: number, total: number) => void) | undefined, onPartial: ((result: QueryResult) => void) | undefined, signal: AbortSignal): Promise<QueryResult> {
    checkSignal(signal);
    if (this.disposed) return { status: "error", candidates: [], judgements: [], error: "The query engine is unavailable." };
    const generation = this.generation;
    const corpus = this.getBlocks();
    let context: string;
    try { context = await this.readContext(spec.contextPaths); }
    catch (error) { return { status: "error", candidates: [], judgements: [], error: error instanceof Error ? error.message : String(error) }; }
    this.assertCurrent(generation, signal);
    if (context.length > MAX_CONTEXT_CHARS) return { status: "error", candidates: [], judgements: [], error: `Selected context is ${context.length.toLocaleString()} characters; the limit is ${MAX_CONTEXT_CHARS.toLocaleString()}. Choose specific blocks or sections, or remove context notes.` };
    const retrieval = await this.retrieve(spec.question, corpus, Math.min(MAX_CANDIDATES, Math.max(1, candidateLimit)), signal);
    const candidates = dedupeCandidates(retrieval.candidates);
    const stats: QueryStats = { searchable: corpus.length, shortlisted: retrieval.candidates.length,
      overlapRemoved: retrieval.candidates.length - candidates.length, windowLimit: Math.min(MAX_CANDIDATES, Math.max(1, candidateLimit)),
      truncated: retrieval.truncated ?? false, checked: 0, cached: 0, shared: 0, requested: 0,
      requests: 0, inputTokens: 0, requestMs: 0, retries: 0,
      skipped: 0, passed: 0, contextChars: context.length, threshold };
    const warning = (message?: string) => [retrieval.warning, message].filter(Boolean).join(" ") || undefined;
    this.assertCurrent(generation, signal);
    if (!candidates.length) return { status: "empty", candidates, judgements: [], stats, selection: this.client ? "jev" : "local", warning: warning() };
    if (!this.client) {
      const ranked = [...candidates].sort((a, b) => (b.retrievalScore ?? b.lexicalScore) - (a.retrievalScore ?? a.lexicalScore) || a.id.localeCompare(b.id));
      return { status: "ready", selection: "local", candidates, stats,
        warning: warning("Local matches. Add a Jev API key in settings to select and order passages by how well they answer your question."),
        judgements: ranked.slice(0, spec.limit ?? limit).map(candidate => ({ candidate, score: candidate.retrievalScore ?? candidate.lexicalScore, contribution: "other", scores: {} })),
      };
    }

    const judgements: Judgement[] = [];
    const belowThreshold: Judgement[] = [];
    const accept = (value: Judgement) => { stats.checked++; if (value.score >= threshold) { judgements.push(value); stats.passed++; } else belowThreshold.push(value); };
    const rejected = () => [...belowThreshold].sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
    const skipped = candidates.filter((candidate) => displayText(candidate).length > MAX_PASSAGE_CHARS);
    stats.skipped = skipped.length;
    const judgeable = candidates.filter((candidate) => displayText(candidate).length <= MAX_PASSAGE_CHARS);
    const order: Record<Contribution, number> = { definition: 0, condition: 1, distinction: 2, other: 3 };
    const selection = () => [...judgements].sort((a, b) => spec.criteria.mode === "default"
      ? order[a.contribution] - order[b.contribution] || b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)
      : b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, spec.limit ?? limit);
    let completed = 0;
    onProgress?.(completed, judgeable.length);
    const keys = judgeable.map(candidate => this.scoreKey(spec, candidate, context));
    const persisted = await this.readScores(keys);
    this.assertCurrent(generation, signal);
    // Preserve existing location-based entries; promote them lazily without rescoring.
    const missing = judgeable.filter((_, i) => !persisted.has(keys[i]) && !this.cache.has(keys[i]));
    const legacy = await this.readScores(missing.map(candidate => this.scoreKey(spec, candidate, context, true)));
    this.assertCurrent(generation, signal);
    for (const candidate of missing) {
      const value = legacy.get(this.scoreKey(spec, candidate, context, true));
      if (value) {
        const key = this.scoreKey(spec, candidate, context);
        persisted.set(key, value);
        await this.persistentCache?.set(key, value);
      }
    }
    this.assertCurrent(generation, signal);
    let lastPartial = -Infinity;
    const publish = () => {
      if (Date.now() - lastPartial >= 250 || completed === judgeable.length) {
        lastPartial = Date.now();
        onPartial?.({ status: "ready", selection: "jev", candidates, judgements: selection(), belowThreshold: rejected(), stats: { ...stats }, warning: warning("Still checking passages. Results may change.") });
      }
    };
    const pending = judgeable.filter(candidate => {
      const key = this.scoreKey(spec, candidate, context);
      const value = this.cache.get(key) ?? persisted.get(key);
      if (!value) return true;
      stats.cached++; accept({ ...value, candidate });
      completed++; return false;
    });
    if (completed) { onProgress?.(completed, judgeable.length); publish(); }
    await Promise.all(pending.map(async (candidate) => {
      try {
        const value = await this.judge(spec, candidate, context, generation, stats, signal);
        this.assertCurrent(generation, signal);
        accept(value);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "INPUT_TOO_LARGE") { skipped.push(candidate); stats.skipped++; }
        else throw error;
      }
      this.assertCurrent(generation, signal);
      onProgress?.(++completed, judgeable.length);
      publish();
    }));
    this.assertCurrent(generation, signal);
    if (!judgements.length) {
      const result: WarningResult = { status: "empty", candidates, selection: "jev", judgements: [], belowThreshold: rejected(), stats: { ...stats }, error: skipped.length ? "No checked passages met the minimum score. Broaden the question or lower its threshold." : "No passages met the minimum score. Broaden the question or lower its threshold." };
      if (skipped.length) result.warning = `${skipped.length} passage${skipped.length === 1 ? " was" : "s were"} skipped because they exceed the model input limit.`;
      result.warning = warning(result.warning);
      return result;
    }
    const result: WarningResult = { status: "ready", selection: "jev", candidates, judgements: selection(), belowThreshold: rejected(), stats: { ...stats } };
    if (skipped.length) result.warning = `${skipped.length} passage${skipped.length === 1 ? " was" : "s were"} skipped because they exceed the model input limit.`;
    result.warning = warning(result.warning);
    return result;
  }

  private async readContext(paths: string[]): Promise<string> {
    const blocks: Block[] = [];
    for (const path of paths) {
      const pathBlocks = (await this.getSourceBlocks(path)).filter((block) => block.path === path.split("#")[0]);
      for (const block of dedupeRanges(pathBlocks)) blocks.push(block);
    }
    return blocks.map(modelText).join("\n\n");
  }

  private scoreKey(spec: QuerySpec, candidate: Candidate, context: string, legacy = false): string {
    return scoreKey(this.cacheNamespace, spec, candidate, context, legacy);
  }

  private async readScores(keys: string[]): Promise<Map<string, Omit<Judgement, "candidate">>> {
    if (!this.persistentCache || !keys.length) return new Map();
    if (this.persistentCache.getMany) return this.persistentCache.getMany(keys);
    const values = new Map<string, Omit<Judgement, "candidate">>();
    await Promise.all(keys.map(async key => { const value = await this.persistentCache!.get(key); if (value) values.set(key, value); }));
    return values;
  }

  private async judge(spec: QuerySpec, candidate: Candidate, context: string, generation: number, stats: QueryStats, signal: AbortSignal): Promise<Judgement> {
    this.assertCurrent(generation, signal);
    const passage = modelText(candidate);
    const key = this.scoreKey(spec, candidate, context);
    const cached = this.cache.get(key);
    if (cached) {
      stats.cached++;
      this.cache.delete(key); this.cache.set(key, cached);
      return { ...cached, candidate };
    }
    const existing = this.inFlight.get(key);
    if (existing) { stats.shared++; return { ...(await existing.join(signal)), candidate }; }
    const request = new SharedWork<Judgement>(async sharedSignal => {
      const prune = () => this.gate.cancelStale(this.generation);
      sharedSignal.addEventListener("abort", prune, { once: true });
      let release: (() => void) | undefined;
      try {
        release = await this.gate.acquire(generation, () => !this.disposed && generation === this.generation && !sharedSignal.aborted);
        this.assertCurrent(generation, sharedSignal);
        stats.requested++;
        const response = await this.client!.rank(spec.question, passage, spec.criteria, context, {
          onThrottle: () => this.gate.throttle(),
          onRetry: () => { stats.retries++; },
          onRequest: (report) => { stats.requests += report.requests; stats.inputTokens += report.inputTokens; stats.requestMs += report.elapsedMs; },
        }, sharedSignal);
        this.gate.success();
        release();
        this.assertCurrent(generation, sharedSignal);
        const judgement = this.validateResponse(response, spec, candidate);
        this.cache.set(key, judgement);
        if (this.persistentCache) {
          const { candidate: _candidate, ...score } = judgement;
          await this.persistentCache.set(key, score);
          this.assertCurrent(generation, sharedSignal);
        }
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        return judgement;
      } finally { release?.(); sharedSignal.removeEventListener("abort", prune); }
    }, () => { if (this.inFlight.get(key) === request) this.inFlight.delete(key); });
    this.inFlight.set(key, request);
    return { ...(await request.join(signal)), candidate };
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

  private assertCurrent(generation: number, signal?: AbortSignal): void {
    checkSignal(signal);
    if (this.disposed || generation !== this.generation) throw new QueryRunSuperseded();
  }
}
