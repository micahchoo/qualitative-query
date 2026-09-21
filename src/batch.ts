import { cancelled, checkSignal } from "./work";
import type { JevClient, JevPassage, RankHooks } from "./jev";
import type { JevResponse, QueryCriteria } from "./types";

interface Member { passage: JevPassage; hooks: RankHooks; signal?: AbortSignal; resolve: (response: JevResponse) => void; reject: (error: unknown) => void }
interface Bucket { question: string; criteria: QueryCriteria; context: string; members: Member[]; timer?: number }

const FLUSH_MS = 15;

/**
 * Collects passages heading for the same question into one request.
 *
 * A question costs one round trip per passage otherwise, and its shared state — the question
 * and any explicit context — is re-sent with every one of them. Passages only share a request
 * when their question, criteria and context are identical, so no passage is ever judged
 * against another passage's instructions.
 *
 * It presents `rank`, so the engine keeps one promise, one cache entry and one cancellation
 * per passage exactly as before.
 */
export class PassageBatcher {
  private readonly buckets = new Map<string, Bucket>();
  /** Identity memo: one run hands over the same question, criteria and context every call. */
  private readonly recent: Array<{ question: string; criteria: QueryCriteria; context: string; key: string }> = [];
  private next = 0;
  private disposed = false;

  constructor(private readonly client: Pick<JevClient, "rankMany">, readonly batchSize: number, private readonly flushMs = FLUSH_MS) {}

  rank(question: string, candidate: string, criteria: QueryCriteria, context = "", hooks: RankHooks = {}, signal?: AbortSignal): Promise<JevResponse> {
    checkSignal(signal);
    if (this.disposed) return Promise.reject(cancelled());
    if (this.batchSize <= 1) return this.client.rankMany(question, [{ id: "p0", text: candidate }], criteria, context, hooks, signal).then(answers => take(answers, "p0"));
    const key = this.bucketKey(question, criteria, context);
    return new Promise<JevResponse>((resolve, reject) => {
      const bucket = this.buckets.get(key) ?? { question, criteria, context, members: [] };
      bucket.members.push({ passage: { id: `p${this.next++}`, text: candidate }, hooks, signal, resolve, reject });
      this.buckets.set(key, bucket);
      if (bucket.members.length >= this.batchSize) this.flush(key);
      // A part-filled bucket must still leave: the gate can release its last slot at any time.
      else bucket.timer ??= window.setTimeout(() => this.flush(key), this.flushMs);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const key of [...this.buckets.keys()]) {
      const bucket = this.buckets.get(key)!;
      this.buckets.delete(key);
      if (bucket.timer !== undefined) window.clearTimeout(bucket.timer);
      for (const member of bucket.members) member.reject(cancelled());
    }
    this.recent.length = 0;
  }

  private bucketKey(question: string, criteria: QueryCriteria, context: string): string {
    // Compare by identity first. Explicit context reaches 48,000 characters, and rebuilding a
    // key that long once per passage is the cost this class exists to remove.
    for (const entry of this.recent) if (entry.question === question && entry.criteria === criteria && entry.context === context) return entry.key;
    const key = `${question}\u0000${JSON.stringify(criteria)}\u0000${context}`;
    this.recent.unshift({ question, criteria, context, key });
    while (this.recent.length > 4) this.recent.pop();
    return key;
  }

  private flush(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.buckets.delete(key);
    if (bucket.timer !== undefined) window.clearTimeout(bucket.timer);
    const live: Member[] = [];
    for (const member of bucket.members) member.signal?.aborted ? member.reject(cancelled()) : live.push(member);
    if (live.length) void this.send(bucket, live);
  }

  private async send(bucket: Bucket, members: Member[]): Promise<void> {
    // Every member of a bucket belongs to one run, so its first member's hooks report the request.
    const lead = members[0];
    try {
      const answers = await this.client.rankMany(bucket.question, members.map(member => member.passage), bucket.criteria, bucket.context, lead.hooks, members.length === 1 ? lead.signal : undefined);
      for (const member of members) {
        if (member.signal?.aborted) { member.reject(cancelled()); continue; }
        try { member.resolve(take(answers, member.passage.id)); }
        catch (error) { member.reject(error); }
      }
    } catch (error) {
      for (const member of members) member.reject(error);
    }
  }
}

function take(answers: Map<string, JevResponse>, id: string): JevResponse {
  const response = answers.get(id);
  if (!response) throw new Error("Jev returned no answers for the passage.");
  return response;
}
