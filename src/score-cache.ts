import type { Contribution, Judgement } from "./types";

/** The old JSON file is read once for migration and left intact. */
export interface ScoreCacheStorage { read(): Promise<string | null>; write?(text: string): Promise<void>; }
export interface ScoreCacheOptions {
  maxEntries?: number;
  databaseName?: string;
  onError?: (error: unknown) => void;
}
type CachedScore = Omit<Judgement, "candidate">;
type SerializedEntry = { hash: string; value: CachedScore };
type SerializedCache = { version: 1; entries: SerializedEntry[] };
interface CacheState { count: number; clock: number; }
interface StoredScore extends SerializedEntry { accessed: number; }
export const MAX_SCORE_CACHE_ENTRIES = 1_000_000;
const SCHEMA_VERSION = 1 as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTRIBUTIONS = new Set<Contribution>(["definition", "condition", "distinction", "other"]);

/** Disk-backed LRU. Transactions touch individual scores, never a million-entry JSON snapshot. */
export class ScoreCache {
  private readonly maxEntries: number;
  private readonly onError?: (error: unknown) => void;
  private readonly ready: Promise<IDBDatabase | undefined>;
  private operations: Promise<void> = Promise.resolve();
  private closed = false;
  // Only failed writes need an in-memory fallback; normal scores remain in IndexedDB.
  private readonly fallback = new Map<string, CachedScore>();

  constructor(private readonly storage: ScoreCacheStorage, options: ScoreCacheOptions | number = {}) {
    const normalized = typeof options === "number" ? { maxEntries: options } : options;
    this.maxEntries = Number.isInteger(normalized.maxEntries) && normalized.maxEntries! > 0 ? normalized.maxEntries! : MAX_SCORE_CACHE_ENTRIES;
    this.onError = normalized.onError;
    this.ready = this.initialize(normalized.databaseName ?? "qualitative-query-scores-v2");
  }

  async get(key: string): Promise<CachedScore | undefined> { return (await this.getMany([key])).get(key); }

  getMany(keys: string[]): Promise<Map<string, CachedScore>> {
    return this.enqueue(async () => {
      const unique = [...new Set(keys)];
      const hashes = await Promise.all(unique.map(hashKey));
      const result = new Map<string, CachedScore>();
      const db = await this.ready;
      // Bound each transaction so cache hits do not monopolize the renderer.
      for (let offset = 0; offset < unique.length; offset += 256) {
        const batch = hashes.slice(offset, offset + 256);
        if (db) try {
          const tx = db.transaction(["scores", "meta"], "readwrite");
          const done = transactionDone(tx);
          const store = tx.objectStore("scores"), meta = tx.objectStore("meta");
          const stateRequest = request<CacheState>(meta.get("state"));
          const rows = await Promise.all(batch.map(hash => request<StoredScore | undefined>(store.get(hash))));
          const state = await stateRequest;
          rows.forEach((entry, i) => {
            const value = entry && validateScore(entry.value);
            if (entry && value) {
              result.set(unique[offset + i], value);
              entry.accessed = ++state.clock; store.put(entry);
            }
          });
          meta.put(state, "state"); await done;
        } catch (error) { this.report(error); }
        batch.forEach((hash, i) => {
          const value = this.fallback.get(hash);
          if (value) result.set(unique[offset + i], cloneScore(value));
        });
      }
      return result;
    });
  }

  set(key: string, value: CachedScore): Promise<void> {
    return this.enqueue(async () => {
      const hash = await hashKey(key);
      const checked = validateScore(value);
      if (!checked) throw new TypeError("Cannot persist an invalid score.");
      const db = await this.ready;
      try {
        if (!db) throw new Error("Persistent score cache is unavailable.");
        await this.writeRows(db, [{ hash, value: checked }]);
        this.fallback.delete(hash);
      } catch (error) {
        this.fallback.delete(hash); this.fallback.set(hash, checked);
        while (this.fallback.size > 512) this.fallback.delete(this.fallback.keys().next().value!);
        this.report(error);
      }
    });
  }

  /** Every set waits for its transaction to commit. */
  async flush(): Promise<void> { await this.ready; await this.operations; }
  async close(): Promise<void> { this.closed = true; await this.flush(); (await this.ready)?.close(); this.fallback.clear(); }

  private async initialize(name: string): Promise<IDBDatabase | undefined> {
    let db: IDBDatabase;
    try {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore("scores", { keyPath: "hash" }).createIndex("accessed", "accessed");
          open.result.createObjectStore("meta").put({ count: 0, clock: 0 }, "state");
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error ?? new Error("Could not open score cache."));
        open.onblocked = () => this.report(new Error("Score cache upgrade is blocked by another Obsidian window."));
      });
      db.onversionchange = () => db.close();
    } catch (error) { this.report(error); return undefined; }
    try {
      const tx = db.transaction("meta", "readonly");
      const done = transactionDone(tx);
      const migrated = await request(tx.objectStore("meta").get("migrated-v1"));
      await done;
      if (!migrated) {
        const text = await this.storage.read();
        if (text !== null) {
          const parsed: unknown = JSON.parse(text);
          if (!isSerializedCache(parsed)) throw new Error("Ignoring invalid legacy score cache.");
          for (let offset = 0; offset < parsed.entries.length; offset += 256) {
            const batch = parsed.entries.slice(offset, offset + 256).filter(entry => {
              if (isSerializedEntry(entry)) return true;
              this.report(new Error("Ignoring invalid legacy score entry.")); return false;
            });
            await this.writeRows(db, batch, true);
          }
        }
        const mark = db.transaction("meta", "readwrite");
        const committed = transactionDone(mark);
        mark.objectStore("meta").put(true, "migrated-v1"); await committed;
      }
    } catch (error) { this.report(error); }
    return db;
  }

  private async writeRows(db: IDBDatabase, rows: SerializedEntry[], onlyMissing = false): Promise<void> {
    const tx = db.transaction(["scores", "meta"], "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("scores"), meta = tx.objectStore("meta");
    try {
      const state = await request<CacheState>(meta.get("state"));
      for (const row of rows) {
        const previous = await request<StoredScore | undefined>(store.get(row.hash));
        if (previous && onlyMissing) continue;
        if (!previous) state.count++;
        store.put({ hash: row.hash, value: cloneScore(row.value), accessed: ++state.clock } satisfies StoredScore);
      }
      const excess = state.count - this.maxEntries;
      if (excess > 0) {
        await new Promise<void>((resolve, reject) => {
          let removed = 0;
          const cursor = store.index("accessed").openCursor();
          cursor.onerror = () => reject(cursor.error ?? new Error("Score cache cursor failed."));
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row || removed >= excess) { state.count -= removed; resolve(); return; }
            row.delete(); removed++;
            if (removed >= excess) { state.count -= removed; resolve(); } else row.continue();
          };
        });
      }
      meta.put(state, "state");
      await done;
    } catch (error) { try { tx.abort(); } catch { /* Already completed or aborted. */ } await done.catch(() => undefined); throw error; }
  }

  private report(error: unknown): void { try { this.onError?.(error); } catch { /* Reporting cannot invalidate a score. */ } }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Score cache is closed."));
    const next = this.operations.then(work, work);
    this.operations = next.then(() => undefined, () => undefined);
    return next;
  }
}

function request<T = unknown>(value: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result as T); value.onerror = () => reject(value.error ?? new Error("Score cache request failed.")); });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Score cache transaction aborted."));
    tx.onerror = () => { /* onabort is the terminal failure event. */ };
  });
  // A request may reject before the caller reaches await done.
  void done.catch(() => undefined);
  return done;
}

async function hashKey(key: string): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable.");
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSerializedCache(value: unknown): value is SerializedCache {
  return typeof value === "object" && value !== null
    && (value as { version?: unknown }).version === SCHEMA_VERSION
    && Array.isArray((value as { entries?: unknown }).entries);
}

function isSerializedEntry(value: unknown): value is SerializedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { hash?: unknown; value?: unknown };
  return typeof entry.hash === "string" && HASH_PATTERN.test(entry.hash) && !!validateScore(entry.value);
}

function validateScore(value: unknown): CachedScore | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<CachedScore>;
  if (typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || typeof candidate.contribution !== "string" || !CONTRIBUTIONS.has(candidate.contribution)) return undefined;
  if (typeof candidate.scores !== "object" || candidate.scores === null || Array.isArray(candidate.scores)) return undefined;
  const scores: Record<string, number> = {};
  for (const [name, score] of Object.entries(candidate.scores)) {
    if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
    scores[name] = score;
  }
  return { score: candidate.score, contribution: candidate.contribution, scores };
}

function cloneScore(value: CachedScore): CachedScore {
  return { score: value.score, contribution: value.contribution, scores: { ...value.scores } };
}
