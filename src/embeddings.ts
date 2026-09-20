import { cooperative } from "./cooperative";
import { cancelled, checkSignal } from "./work";
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
  private queue: Array<{ run: () => Promise<void>; cancel: () => void }> = [];
  private running = false;
  private snapshot?: Block[];
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
    } catch (error) { this.status = "Using keyword search. Restart local search to retry, or download the model if it is missing."; this.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  search(question: string, blocks: Block[], limit: number, signal?: AbortSignal): Promise<SemanticHit[]> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(cancelled());
      };
      const job = {
        cancel: abort,
        run: async () => {
          try { resolve(await this.searchCurrent(question, blocks, limit, signal)); }
          catch (error) { reject(asError(error)); }
          finally { signal?.removeEventListener("abort", abort); }
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    void job.run().finally(() => { this.running = false; this.pump(); });
  }

  private async searchCurrent(question: string, blocks: Block[], limit: number, signal?: AbortSignal): Promise<SemanticHit[]> {
    checkSignal(signal);
    await this.load();
    checkSignal(signal);
    if (this.snapshot !== blocks) {
      // The immutable corpus identity lets all questions share this synchronization.
      this.snapshot = undefined;
      const indexed = this.indexed;
      const { removed, changed } = await cooperative((function* () {
        const current = new Set<string>(), changed: Block[] = [], removed: string[] = [];
        let visited = 0;
        for (const block of blocks) {
          current.add(block.id);
          if (indexed.get(block.id) !== block) changed.push(block);
          if (++visited % 128 === 0) yield;
        }
        for (const id of indexed.keys()) {
          if (!current.has(id)) removed.push(id);
          if (++visited % 128 === 0) yield;
        }
        return { removed, changed };
      })(), signal, true);
      if (removed.length) {
        await this.call("remove", { ids: removed });
        for (const id of removed) this.indexed.delete(id);
        checkSignal(signal);
      }
      for (let start = 0; start < changed.length; start += 128) {
        checkSignal(signal);
        const batch = changed.slice(start, start + 128);
        await this.call("update", { rows: batch.map(block => ({ id: block.id, text: block.searchText || block.text })) });
        // Track completed batches even if their original consumer was cancelled.
        for (const block of batch) this.indexed.set(block.id, block);
      }
      checkSignal(signal);
      this.snapshot = blocks;
    }
    checkSignal(signal);
    const result = await this.call("search", { question, limit });
    checkSignal(signal);
    if (!Array.isArray(result)) throw new Error("Invalid search results.");
    return (result as unknown[]).map(hit => {
      if (!record(hit) || typeof hit.id !== "string" || typeof hit.score !== "number" || !Number.isFinite(hit.score)) throw new Error("Invalid search result.");
      return { id: hit.id, score: hit.score };
    });
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
    this.status = "Using keyword search. Restart local search to retry, or download the model if it is missing.";
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) { window.clearTimeout(pending.timer); pending.reject(asError(error)); }
    this.pending.clear();
  }

  dispose(): void { this.stopped = true; this.fail(new Error("Embedding index closed.")); this.indexed.clear(); this.snapshot = undefined; for (const job of [...this.queue]) job.cancel(); }
}
