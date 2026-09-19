import { EmbeddingIndex } from "./embeddings";
import { hybridShortlist, shortlistAsync } from "./search";
import type { Block, Candidate } from "./types";

export interface RetrievalResult { candidates: Candidate[]; warning?: string; }
type SemanticIndex = Pick<EmbeddingIndex, "search" | "dispose" | "status">;
const FALLBACK = "Using keyword search. For related wording, download the search model in settings.";

/** Owns one semantic index, explicit restoration, and per-search fallback. */
export class LocalRetrieval {
  private semantic?: SemanticIndex;
  private download?: Promise<void>;
  private stopped = false;
  constructor(private readonly createIndex: () => SemanticIndex, private readonly restoreAssets: () => Promise<void>) {}

  get status(): string { return this.semantic?.status ?? "About 31 MB from Hugging Face. Runs on your device."; }

  async search(question: string, blocks: Block[], limit: number): Promise<RetrievalResult> {
    if (this.stopped) throw new Error("Local search is closed.");
    const index = this.semantic ??= this.createIndex();
    const pool = Math.max(limit * 4, 32);
    const [keywords, hits] = await Promise.all([
      shortlistAsync(question, blocks, pool),
      index.search(question, blocks, pool).catch(() => null),
    ]);
    if (this.stopped) throw new Error("Local search is closed.");
    return hits
      ? { candidates: hybridShortlist(question, blocks, hits, limit, keywords) }
      : { candidates: keywords.slice(0, limit), warning: FALLBACK };
  }

  restore(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Local search is closed."));
    return this.download ??= this.restoreAssets().then(() => {
      this.semantic?.dispose();
      this.semantic = undefined;
    }).finally(() => { this.download = undefined; });
  }

  dispose(): void { this.stopped = true; this.semantic?.dispose(); this.semantic = undefined; }
}
