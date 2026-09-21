import { cancelled, checkSignal, SharedWork } from "./work";
import { EmbeddingIndex } from "./embeddings";
import { hybridShortlistAsync, shortlistAsync } from "./search";
import type { Block, Candidate } from "./types";

export interface RetrievalResult { candidates: Candidate[]; warning?: string; truncated?: boolean; }

/** Candidates are ranked from a pool wider than the limit, so duplicates can be pushed behind distinct passages. */
const pool = (limit: number): number => Math.max(limit * 4, 32);
/** The first `limit`, and whether more were available: asked once, at limit + 1, never by a second scan. */
function bounded(ranked: Candidate[], limit: number): RetrievalResult {
  return { candidates: ranked.slice(0, limit), truncated: ranked.length > limit };
}

/**
 * The shortlist by keyword alone. What ships when the semantic index is absent, and what
 * the engine's tests run on: retrieval is a required argument of the engine, so there is no
 * second implementation for a test to exercise instead of this one.
 */
export async function keywordRetrieval(question: string, blocks: Block[], limit: number, signal?: AbortSignal): Promise<RetrievalResult> {
  return bounded(await shortlistAsync(question, blocks, pool(limit), signal), limit);
}
type SemanticIndex = Pick<EmbeddingIndex, "search" | "dispose" | "status">;
const FALLBACK = "Using keyword search. Restart local search in settings to retry. If the model is missing, select Download search model.";

/** Owns one semantic index, explicit restoration, and per-search fallback. */
export class LocalRetrieval {
  private semantic?: SemanticIndex;
  private download?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private work = new Set<SharedWork<RetrievalResult>>();
  private corpus?: Block[];
  private cached = new Map<string, RetrievalResult>();
  private pending = new Map<string, SharedWork<RetrievalResult>>();
  constructor(private readonly createIndex: () => SemanticIndex, private readonly restoreAssets: () => Promise<void>) {}

  get status(): string { return this.semantic?.status ?? "About 31 MB from Hugging Face. Runs on your device."; }

  search(question: string, blocks: Block[], limit: number, signal?: AbortSignal): Promise<RetrievalResult> {
    if (this.stopped) return Promise.reject(new Error("Local search is closed."));
    checkSignal(signal);
    if (this.corpus !== blocks) { this.corpus = blocks; this.cached.clear(); this.pending = new Map(); }
    const key = JSON.stringify([question, limit]);
    const cached = this.cached.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending;
    const generation = this.generation;
    let task = pending.get(key);
    if (!task) {
      task = new SharedWork(async sharedSignal => {
        const result = await this.searchCurrent(question, blocks, limit, sharedSignal);
        if (generation !== this.generation) throw cancelled();
        if (this.corpus === blocks && !sharedSignal.aborted) {
          this.cached.set(key, result);
          while (this.cached.size > 64) this.cached.delete(this.cached.keys().next().value!);
        }
        return result;
      }, () => { if (pending.get(key) === task) pending.delete(key); this.work.delete(task!); });
      pending.set(key, task);
      this.work.add(task);
    }
    return task.join(signal);
  }

  private async searchCurrent(question: string, blocks: Block[], limit: number, signal: AbortSignal): Promise<RetrievalResult> {
    checkSignal(signal);
    const index = this.semantic ??= this.createIndex();
    const [keywords, hits] = await Promise.all([
      shortlistAsync(question, blocks, pool(limit), signal),
      index.search(question, blocks, pool(limit), signal).catch(() => { checkSignal(signal); return null; }),
    ]);
    checkSignal(signal);
    if (this.stopped) throw new Error("Local search is closed.");
    const ranked = hits ? await hybridShortlistAsync(question, blocks, hits, limit + 1, keywords, signal) : keywords;
    return { ...bounded(ranked, limit), ...(hits ? {} : { warning: FALLBACK }) };
  }

  private reset(): void {
    this.generation++;
    for (const task of this.work) task.cancel();
    this.work.clear();
    this.cached.clear(); this.pending = new Map();
  }

  restart(): void {
    if (this.stopped) throw new Error("Local search is closed.");
    this.semantic?.dispose(); this.semantic = undefined; this.reset();
  }

  restore(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Local search is closed."));
    return this.download ??= this.restoreAssets().then(() => {
      this.semantic?.dispose();
      this.semantic = undefined; this.reset();
    }).finally(() => { this.download = undefined; });
  }

  dispose(): void { this.stopped = true; this.semantic?.dispose(); this.semantic = undefined; this.reset(); this.corpus = undefined; }
}
