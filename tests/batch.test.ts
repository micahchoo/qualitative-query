import { describe, expect, it, vi } from "vitest";
import { PassageBatcher } from "../src/batch";
import type { JevResponse } from "../src/types";

const answersFor = (ids: string[], score = 0.8) => new Map<string, JevResponse>(ids.map(id => [id, { answers: { relevant: { noul: score } } }]));
const generic = { mode: "generic" as const };

describe("passage batcher", () => {
  it("carries a full bucket in one request and returns each passage its own answer", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 3);
    const scores = await Promise.all(["one", "two", "three"].map(text => batcher.rank("q", text, generic, "ctx")));
    expect(rankMany).toHaveBeenCalledTimes(1);
    expect(rankMany.mock.calls[0][1].map(p => p.text)).toEqual(["one", "two", "three"]);
    expect(scores.map(s => s.answers.relevant.noul)).toEqual([0.8, 0.8, 0.8]);
  });

  it("sends a part-filled bucket rather than waiting for passages that never arrive", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 10, 1);
    const score = await batcher.rank("q", "alone", generic, "");
    expect(rankMany).toHaveBeenCalledTimes(1);
    expect(rankMany.mock.calls[0][1]).toHaveLength(1);
    expect(score.answers.relevant.noul).toBe(0.8);
  });

  it("never mixes questions, criteria or context into one request", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 10, 1);
    await Promise.all([
      batcher.rank("first", "a", generic, "ctx"),
      batcher.rank("second", "b", generic, "ctx"),
      batcher.rank("first", "c", generic, "other context"),
      batcher.rank("first", "d", { mode: "default" }, "ctx"),
      batcher.rank("first", "e", generic, "ctx"),
    ]);
    expect(rankMany).toHaveBeenCalledTimes(4);
    const shared = rankMany.mock.calls.find(call => call[1].length === 2);
    expect(shared![1].map(p => p.text)).toEqual(["a", "e"]);
  });

  it("drops a cancelled passage without failing the rest of its request", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 3, 1);
    const controller = new AbortController();
    const cancelled = batcher.rank("q", "gone", generic, "", {}, controller.signal);
    const kept = batcher.rank("q", "kept", generic, "");
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect((await kept).answers.relevant.noul).toBe(0.8);
    expect(rankMany.mock.calls[0][1].map(p => p.text)).toEqual(["kept"]);
  });

  it("fails every passage in a request when the request fails", async () => {
    const rankMany = vi.fn().mockRejectedValue(new Error("Jev request failed (500)."));
    const batcher = new PassageBatcher({ rankMany }, 2);
    const both = Promise.allSettled([batcher.rank("q", "a", generic, ""), batcher.rank("q", "b", generic, "")]);
    expect((await both).map(result => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("releases waiting passages when the plugin drops the client", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 10, 1000);
    const waiting = batcher.rank("q", "a", generic, "");
    batcher.dispose();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(rankMany).not.toHaveBeenCalled();
    await expect(batcher.rank("q", "b", generic, "")).rejects.toThrow(/cancelled/);
  });

  it("asks one passage at a time when batching is turned off", async () => {
    const rankMany = vi.fn(async (_q: string, passages: Array<{ id: string; text: string }>) => answersFor(passages.map(p => p.id)));
    const batcher = new PassageBatcher({ rankMany }, 1);
    await Promise.all([batcher.rank("q", "a", generic, ""), batcher.rank("q", "b", generic, "")]);
    expect(rankMany).toHaveBeenCalledTimes(2);
    expect(rankMany.mock.calls.every(call => call[1].length === 1)).toBe(true);
  });
});
