import { expect, it, vi } from "vitest";
import { EmbeddingIndex } from "../src/embeddings";

it("reports a worker crash as fallback and rejects later searches with the original failure", async () => {
  class WorkerAdapter {
    static instance: WorkerAdapter;
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    constructor() { WorkerAdapter.instance = this; }
    postMessage(message: { id: number }): void {
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result: null } }));
    }
    terminate(): void {}
  }
  const previous = window.Worker;
  vi.stubGlobal("Worker", WorkerAdapter);
  const index = new EmbeddingIndex({
    readWorker: async () => "",
    read: async () => new TextEncoder().encode("{}").buffer,
  });
  try {
    await index.load();
    expect(index.status).toContain("ready");
    WorkerAdapter.instance.onerror?.();
    expect(index.status).toContain("keyword search");
    await expect(index.search("question", [], 1)).rejects.toThrow("Embedding worker failed");
  } finally { index.dispose(); vi.stubGlobal("Worker", previous); }
});
