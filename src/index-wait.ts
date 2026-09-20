import type { App, TFile } from "obsidian";

export interface IndexWaitOptions {
  onWait?: (pending: number, remainingMs: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class IndexWaitTimeout extends Error {}

/** Events check exact IDs; a timer bounds the wait and updates visible progress. */
export function waitForBlockIds(app: App, targets: Array<{ file: TFile; ids: string[] }>, options: IndexWaitOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    let timer: number | undefined;
    let reference: ReturnType<App["metadataCache"]["on"]> | undefined;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; window.clearInterval(timer);
      if (reference) app.metadataCache.offref(reference);
      options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("Saving passages was cancelled."));
    const check = () => {
      if (done) return;
      if (options.signal?.aborted) { abort(); return; }
      try {
        const pending = targets.reduce((count, target) => {
          const blocks = app.metadataCache.getFileCache(target.file)?.blocks;
          return count + target.ids.filter(id => !blocks?.[id]).length;
        }, 0);
        if (!pending) { finish(); return; }
        const remaining = Math.max(0, deadline - Date.now());
        options.onWait?.(pending, remaining);
        if (!remaining) finish(new IndexWaitTimeout("Obsidian is still indexing source links. Retry when indexing finishes."));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (typeof app.metadataCache.on === "function") reference = app.metadataCache.on("changed", check);
    // Legacy test/storage adapters without events still get bounded readiness checks.
    timer = window.setInterval(check, reference ? 1000 : 50);
    check();
  });
}
