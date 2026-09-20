import { expect, it, vi } from "vitest";
import { EmbeddingIndex } from "../src/embeddings";
import { LocalRetrieval } from "../src/retrieval";
import { parseMarkdown } from "../src/markdown";

const blocks = parseMarkdown("a.md", "Conflict needs mediation.");

for (const count of [1, 10, 50]) it(`discards ${count} obsolete queued consumers and syncs a shared snapshot once`, async () => {
  let finish!: () => void;
  const messages: string[] = [];
  class WorkerAdapter {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { id: number; type: string; question?: string }): void {
      messages.push(message.type);
      const done = () => this.onmessage?.({ data: { id: message.id, result: message.type === "search" ? [] : null } });
      if (message.question === "hold") finish = done;
      else queueMicrotask(done);
    }
    terminate(): void {}
  }
  const previousWorker = globalThis.Worker;
  vi.stubGlobal("Worker", WorkerAdapter);
  const index = new EmbeddingIndex({ readWorker: async () => "", read: async () => new TextEncoder().encode("{}").buffer });
  try {
    const active = index.search("hold", blocks, 10);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const controllers = Array.from({ length: count }, () => new AbortController());
    const obsolete = controllers.map((controller, i) => index.search(`old ${i}`, blocks, 10, controller.signal).catch(error => error));
    for (const controller of controllers) controller.abort();
    const current = index.search("current", blocks, 10);
    finish();
    await Promise.all([active, current, ...obsolete]);
    expect(messages.filter(type => type === "search")).toHaveLength(2);
    expect(messages.filter(type => type === "update")).toHaveLength(1);
  } finally { index.dispose(); vi.stubGlobal("Worker", previousWorker); }
});

it("coalesces identical live queries and retains a survivor when one view closes", async () => {
  let finish!: (hits: []) => void;
  let sharedSignal!: AbortSignal;
  const search = vi.fn(async (_question, _blocks, _limit, signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<[]>(resolve => { finish = resolve; });
  });
  const retrieval = new LocalRetrieval(() => ({ search, status: "ready", dispose() {} }), async () => {});
  const controller = new AbortController();
  const first = retrieval.search("conflict", blocks, 10, controller.signal);
  const survivor = retrieval.search("conflict", blocks, 10);
  await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(first).rejects.toThrow(/cancelled/);
  expect(sharedSignal.aborted).toBe(false);
  finish([]);
  await survivor;
  await retrieval.search("conflict", blocks, 10);
  expect(search).toHaveBeenCalledTimes(1);
});

it("does not reuse a retrieval result after the corpus changes", async () => {
  const search = vi.fn(async () => []);
  const retrieval = new LocalRetrieval(() => ({ search, status: "ready", dispose() {} }), async () => {});
  await retrieval.search("conflict", blocks, 10);
  const updated = [...blocks, ...parseMarkdown("b.md", "Conflict has a new solution.")];
  const result = await retrieval.search("conflict", updated, 10);
  expect(search).toHaveBeenCalledTimes(2);
  expect(result.candidates.map(candidate => candidate.path)).toContain("b.md");
});

for (const operation of ["restart", "restore"] as const) it(`does not let an old ${operation} generation populate the replacement cache`, async () => {
  let finish!: (hits: Array<{ id: string; score: number }>) => void;
  const oldSearch = vi.fn(() => new Promise<Array<{ id: string; score: number }>>(resolve => { finish = resolve; }));
  const newSearch = vi.fn(async () => []);
  let created = 0;
  const retrieval = new LocalRetrieval(() => ({ search: created++ ? newSearch : oldSearch, status: "ready", dispose() {} }), async () => {});
  const old = retrieval.search("conflict", blocks, 10).catch(error => error);
  await vi.waitFor(() => expect(oldSearch).toHaveBeenCalledTimes(1));
  if (operation === "restart") retrieval.restart(); else await retrieval.restore();
  const current = await retrieval.search("conflict", blocks, 10);
  finish([{ id: blocks[0].id, score: 0.99 }]);
  expect(await old).toBeInstanceOf(Error);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(await retrieval.search("conflict", blocks, 10)).toEqual(current);
  expect(newSearch).toHaveBeenCalledTimes(1);
});
