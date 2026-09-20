import { expect, it, vi } from "vitest";
import { LocalRetrieval } from "../src/retrieval";
import { parseMarkdown } from "../src/markdown";

const blocks = [...parseMarkdown("a.md", "Conflict needs mediation."), ...parseMarkdown("b.md", "Neighbours settle a dispute.")];

it("keeps concurrent fallback warnings attached to the search that failed", async () => {
  const retrieval = new LocalRetrieval(() => ({ status: "ready", dispose() {},
    search: async (question) => {
      if (question === "Conflict") throw new Error("worker failure");
      return [{ id: blocks[1].id, score: 0.9 }];
    },
  }), async () => {});
  const [fallback, semantic] = await Promise.all([
    retrieval.search("Conflict", blocks, 2), retrieval.search("dispute", blocks, 2),
  ]);
  expect(fallback.warning).toContain("keyword search");
  expect(fallback.candidates[0].path).toBe("a.md");
  expect(semantic.warning).toBeUndefined();
  expect(semantic.candidates.some(block => block.path === "b.md")).toBe(true);
});

it("deduplicates restoration and replaces the old semantic index", async () => {
  let complete!: () => void;
  const restore = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const dispose = vi.fn();
  const create = vi.fn(() => ({ status: "ready", dispose, search: async () => [] }));
  const retrieval = new LocalRetrieval(create, restore);
  await retrieval.search("Conflict", blocks, 2);
  const first = retrieval.restore(), second = retrieval.restore();
  expect(first).toBe(second);
  expect(restore).toHaveBeenCalledTimes(1);
  complete(); await first;
  expect(dispose).toHaveBeenCalledTimes(1);
  await retrieval.search("Conflict", blocks, 2);
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not revive search when disposed during restoration", async () => {
  let complete!: () => void;
  const create = vi.fn(() => ({ status: "ready", dispose() {}, search: async () => [] }));
  const retrieval = new LocalRetrieval(create, () => new Promise<void>(resolve => { complete = resolve; }));
  const restore = retrieval.restore();
  retrieval.dispose(); complete(); await restore;
  await expect(retrieval.search("Conflict", blocks, 2)).rejects.toThrow("closed");
  await expect(retrieval.restore()).rejects.toThrow("closed");
  expect(create).not.toHaveBeenCalled();
});

it("reports truncation only when another matching passage exists", async () => {
 const corpus = ["a", "b", "c"].map(name => parseMarkdown(`${name}.md`, "Conflict mediation helps.")[0]);
 const retrieval = new LocalRetrieval(() => ({ status: "failed", dispose() {}, search: async () => { throw new Error("failed"); } }), async () => {});
 expect((await retrieval.search("conflict", corpus, 2)).truncated).toBe(true);
 expect((await retrieval.search("conflict", corpus.slice(0, 2), 2)).truncated).toBe(false);
});
it("restarts from existing assets without downloading", async () => {
 const dispose = vi.fn(); const download = vi.fn();
 const create = vi.fn(() => ({ status: "ready", dispose, search: async () => [] }));
 const retrieval = new LocalRetrieval(create, download);
 await retrieval.search("conflict", blocks, 2); retrieval.restart();
 await retrieval.search("conflict", blocks, 2);
 expect(download).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(1);
});
