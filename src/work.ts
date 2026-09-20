/** A cancelled consumer must release its share without cancelling other consumers. */
export function cancelled(): Error { return new Error("This query was superseded or cancelled."); }
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }

type Outcome<T> = { value: T } | { error: Error };
interface Subscriber<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
}

export class SharedWork<T> {
  private readonly controller = new AbortController();
  private readonly subscribers = new Set<Subscriber<T>>();
  private outcome?: Outcome<T>;
  private retired = false;

  constructor(work: (signal: AbortSignal) => Promise<T>, private readonly retire: () => void) {
    // One completion handler owns removable subscriptions. A Promise reaction per
    // consumer would retain every cancelled consumer until the operation settles.
    void Promise.resolve().then(() => { checkSignal(this.controller.signal); return work(this.controller.signal); }).then(
      value => this.finish({ value }),
      error => this.finish({ error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  private retireOnce(): void { if (!this.retired) { this.retired = true; this.retire(); } }

  private finish(outcome: Outcome<T>): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.retireOnce();
    for (const subscriber of this.subscribers) {
      subscriber.signal?.removeEventListener("abort", subscriber.abort);
      if ("error" in outcome) subscriber.reject(outcome.error); else subscriber.resolve(outcome.value);
    }
    this.subscribers.clear();
  }

  cancel(): void { this.finish({ error: cancelled() }); this.controller.abort(); }

  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted || this.controller.signal.aborted) return Promise.reject(cancelled());
    if (this.outcome) return "error" in this.outcome ? Promise.reject(this.outcome.error) : Promise.resolve(this.outcome.value);
    return new Promise<T>((resolve, reject) => {
      const subscriber: Subscriber<T> = {
        resolve, reject, signal,
        abort: () => {
          if (!this.subscribers.delete(subscriber)) return;
          signal?.removeEventListener("abort", subscriber.abort);
          reject(cancelled());
          if (!this.subscribers.size && !this.outcome) this.cancel();
        },
      };
      this.subscribers.add(subscriber);
      signal?.addEventListener("abort", subscriber.abort, { once: true });
    });
  }
}
