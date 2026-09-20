import { expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { waitForBlockIds, IndexWaitTimeout } from "../src/index-wait";
it("waits for the exact IDs and removes the event listener on success", async () => {
 let check!: () => void; let blocks = {};
 const offref = vi.fn(); const reference = {};
 const app = { metadataCache: { on: (_: string, fn: () => void) => { check = fn; return reference; }, offref, getFileCache: () => ({ blocks }) } } as unknown as App;
 const progress = vi.fn();
 const waiting = waitForBlockIds(app, [{ file: {} as TFile, ids: ["chosen"] }], { onWait: progress });
 blocks = { other: {} }; check(); expect(offref).not.toHaveBeenCalled();
 blocks = { chosen: {} }; check(); await waiting;
 expect(progress).toHaveBeenCalled(); expect(offref).toHaveBeenCalledWith(reference);
});
it("cleans up on timeout and cancellation", async () => {
 const offref = vi.fn();
 const app = { metadataCache: { on: () => ({}), offref, getFileCache: () => ({ blocks: {} }) } } as unknown as App;
 const targets = [{ file: {} as TFile, ids: ["missing"] }];
 await expect(waitForBlockIds(app, targets, { timeoutMs: 0 })).rejects.toBeInstanceOf(IndexWaitTimeout);
 const controller = new AbortController();
 const waiting = waitForBlockIds(app, targets, { signal: controller.signal }); controller.abort();
 await expect(waiting).rejects.toThrow("cancelled"); expect(offref).toHaveBeenCalledTimes(2);
});
