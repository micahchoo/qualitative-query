import { describe, expect, it, vi } from "vitest";
import { QueryEngine } from "../src/engine";
import { JevClient } from "../src/jev";
import type { Block, QuerySpec } from "../src/types";

const spec: QuerySpec = { question: "conflict", folder: "Queries", contextPaths: [], criteria: { mode: "generic" } };
const blocks: Block[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), path: `${i}.md`, lineStart: 1, lineEnd: 1, text: `conflict ${i}`, searchText: `conflict ${i}`, headingPath: [], kind: "paragraph" }));
const response = { answers: { relevant: { noul: 0.9 } } };
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

describe("query lifetimes", () => {
  for (const failing of [1, 50, 100]) it(`stops requests and callbacks after failure ${failing}`, async () => {
    let calls = 0, late = 0, settled = false;
    const engine = new QueryEngine({ rank: async () => { const call = ++calls; await delay(); if (call === failing) throw new Error("provider failed"); return response; } }, () => blocks);
    await expect(engine.run(spec, 100, 6, 0.5, () => { if (settled) late++; }, () => { if (settled) late++; })).rejects.toThrow("provider failed");
    settled = true;
    const atSettlement = calls;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(atSettlement);
    expect(late).toBe(0);
  });

  it("releases a closed view without cancelling a duplicate subscriber", async () => {
    const controller = new AbortController();
    let finish!: (value: typeof response) => void;
    let transportSignal!: AbortSignal;
    const rank = vi.fn(async (_q, _p, _c, _ctx, _hooks, signal) => {
      transportSignal = signal;
      return new Promise<typeof response>(resolve => { finish = resolve; });
    });
    const engine = new QueryEngine({ rank }, () => blocks.slice(0, 1));
    const closed = engine.run(spec, 1, 1, 0.5, undefined, undefined, controller.signal);
    const survivor = engine.run(spec, 1, 1, 0.5);
    await vi.waitFor(() => expect(rank).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(closed).rejects.toThrow(/cancelled/);
    expect(transportSignal.aborted).toBe(false);
    finish(response);
    expect((await survivor).judgements).toHaveLength(1);
  });

  it("cancels active transport when its last consumer closes and never starts its queue", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const rank = vi.fn(async (_q, _p, _c, _ctx, _hooks, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<typeof response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const engine = new QueryEngine({ rank }, () => blocks);
    const run = engine.run(spec, 100, 6, 0.5, undefined, undefined, controller.signal);
    await vi.waitFor(() => expect(rank).toHaveBeenCalledTimes(16));
    controller.abort();
    await expect(run).rejects.toThrow(/cancelled/);
    await delay();
    expect(rank).toHaveBeenCalledTimes(16);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("does not retry a non-abortable request after its consumer closes", async () => {
    const controller = new AbortController();
    let finish!: (value: { status: number; json: unknown }) => void;
    const post = vi.fn(() => new Promise<{ status: number; json: unknown }>(resolve => { finish = resolve; }));
    const client = new JevClient("key", "model", { post });
    const run = client.rank("q", "p", { mode: "generic" }, "", undefined, controller.signal);
    controller.abort(); finish({ status: 429, json: {} });
    await expect(run).rejects.toThrow(/cancelled/);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

it("many cancelled subscribers leave one survivor and do not consume its result", async () => {
  const { SharedWork } = await import("../src/work");
  let finish!: (value: number) => void;
  const retired = vi.fn();
  const task = new SharedWork<number>(async () => new Promise(resolve => { finish = resolve; }), retired);
  const survivor = task.join();
  await Promise.resolve();
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController();
    const closed = task.join(controller.signal);
    controller.abort();
    await expect(closed).rejects.toThrow(/cancelled/);
  }
  expect(retired).not.toHaveBeenCalled();
  finish(7);
  expect(await survivor).toBe(7);
  expect(retired).toHaveBeenCalledTimes(1);
});
