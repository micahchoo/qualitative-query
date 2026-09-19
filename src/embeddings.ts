import { asError, parseObject, record } from "./validation";
import type { Block } from "./types";

export interface SemanticHit { id: string; score: number; }
interface Assets { read(name: string): Promise<ArrayBuffer>; readWorker(): Promise<string>; }

/** One background worker owns the model and vector index. No GPU or inference runtime. */
export class EmbeddingIndex {
  private worker?: Worker;
  private ready?: Promise<void>;
  private stopped = false;
  private failure?: Error;
  private serial = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  private indexed = new Map<string, Block>();
  private queue: Promise<unknown> = Promise.resolve();
  status = "The search model loads when you open a question.";
  constructor(private readonly assets: Assets) {}

  load(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Embedding index is closed."));
    if (this.failure) return Promise.reject(this.failure);
    return this.ready ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    this.status = "Loading search model…";
    try {
      const [source, weights, tokenizer, config] = await Promise.all([
        this.assets.readWorker(), this.assets.read("model.safetensors"), this.assets.read("tokenizer.json"), this.assets.read("tokenizer_config.json"),
      ]);
      if (this.stopped) throw new Error("Embedding index is closed.");
      const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
      this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!record(data) || typeof data.id !== "number") { this.fail(new Error("Invalid search response.")); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        window.clearTimeout(pending.timer); this.pending.delete(data.id);
        if (typeof data.error === "string") pending.reject(new Error(data.error)); else pending.resolve(data.result);
      };
      this.worker.onerror = () => this.fail(new Error("Embedding worker failed. Keyword retrieval remains available."));
      await this.call("load", { weights, tokenizer: parseObject(new TextDecoder().decode(tokenizer)), config: parseObject(new TextDecoder().decode(config)) }, [weights]);
      this.status = "Search model ready. Runs on your device.";
    } catch (error) { this.status = "Using keyword search. Select Download search model to restore search by meaning."; this.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  search(question: string, blocks: Block[], limit: number): Promise<SemanticHit[]> {
    // Serial synchronization prevents concurrent queries from observing a partial index.
    const task = this.queue.then(async () => {
      await this.load();
      const current = new Map(blocks.map(block => [block.id, block]));
      const removed = [...this.indexed.keys()].filter(id => !current.has(id));
      if (removed.length) await this.call("remove", { ids: removed });
      const changed = blocks.filter(block => this.indexed.get(block.id) !== block);
      for (let start = 0; start < changed.length; start += 128) {
        const batch = changed.slice(start, start + 128);
        await this.call("update", { rows: batch.map(block => ({ id: block.id, text: block.searchText || block.text })) });
      }
      this.indexed = current;
      const result = await this.call("search", { question, limit });
      if (!Array.isArray(result)) throw new Error("Invalid search results.");
      return (result as unknown[]).map(hit => {
        if (!record(hit) || typeof hit.id !== "string" || typeof hit.score !== "number" || !Number.isFinite(hit.score)) throw new Error("Invalid search result.");
        return { id: hit.id, score: hit.score };
      });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private call(type: string, values: object, transfer: Transferable[] = []): Promise<unknown> {
    if (!this.worker || this.stopped) return Promise.reject(new Error("Embedding worker is unavailable."));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => this.fail(new Error("Embedding worker timed out; using keywords.")), 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ id, type, ...values }, transfer); }
      catch (error) { window.clearTimeout(timer); this.pending.delete(id); reject(asError(error)); }
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    this.status = "Using keyword search. Select Download search model to restore search by meaning.";
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(asError(error)); }
    this.pending.clear();
  }

  dispose(): void { this.stopped = true; this.fail(new Error("Embedding index closed.")); this.indexed.clear(); }
}
