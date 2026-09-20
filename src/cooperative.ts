import { cancelled, checkSignal } from "./work";

interface Job { step: () => boolean; abort: () => void }
const jobs: Job[] = [];
const active: Job[] = [];
const finishing: Job[] = [];
let scheduled = false;

/** One renderer-wide budget, rather than a separate synchronous slice per view. */
function schedule(): void {
  if (scheduled || (!jobs.length && !active.length && !finishing.length)) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    const end = performance.now() + 6;
    while ((jobs.length || active.length || finishing.length) && performance.now() < end) {
      while (active.length < 2 && (finishing.length || jobs.length)) active.push((finishing.length ? finishing : jobs).shift()!);
      const job = active.shift()!;
      if (!job.step()) active.push(job);
    }
    schedule();
  }, 0);
}

export function cooperative<T>(work: Generator<void, T>, signal?: AbortSignal, completion = false): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { finished = true; signal?.removeEventListener("abort", job.abort); };
    const job: Job = {
      abort: () => {
        const index = jobs.indexOf(job);
        if (index >= 0) jobs.splice(index, 1);
        const ready = finishing.indexOf(job);
        if (ready >= 0) finishing.splice(ready, 1);
        const running = active.indexOf(job);
        if (running >= 0) active.splice(running, 1);
        cleanup();
        work.return(undefined as T);
        reject(cancelled());
      },
      step: () => {
        if (finished) return true;
        try {
          checkSignal(signal);
          const next = work.next();
          if (!next.done) return false;
          cleanup(); resolve(next.value);
        } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); }
        return true;
      },
    };
    signal?.addEventListener("abort", job.abort, { once: true });
    (completion ? finishing : jobs).push(job);
    schedule();
  });
}
