import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { MAX_SCORE_CACHE_ENTRIES, ScoreCache } from "../src/score-cache";

const score = (n: number) => ({ score: n, contribution: "definition" as const, scores: { definition: n, condition: 1 - n } });
const legacy = (text: string | null = null) => ({ read: vi.fn(async () => text), write: vi.fn(async (_text: string) => {}) });
async function hash(key: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))), byte => byte.toString(16).padStart(2, "0")).join(""); }
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));

describe("persistent score cache", () => {
  it("retains scores beyond the old 2,048-entry ceiling and across restarts", async () => {
    const entries = [{ hash: await hash("first-query"), value: score(0.9) }, ...Array.from({ length: 3000 }, (_, i) => ({ hash: i.toString(16).padStart(64, "0"), value: score(0.1) }))];
    const storage = legacy(JSON.stringify({ version: 1, entries }));
    const first = new ScoreCache(storage);
    await expect(first.get("first-query")).resolves.toEqual(score(0.9));
    await first.close();
    const second = new ScoreCache(storage);
    await expect(second.get("first-query")).resolves.toEqual(score(0.9));
    expect(MAX_SCORE_CACHE_ENTRIES).toBe(1_000_000);
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(storage.write).not.toHaveBeenCalled();
    await second.close();
  });

  it("commits concurrent scores and never rewrites the legacy JSON file", async () => {
    const storage = legacy(); const first = new ScoreCache(storage);
    await Promise.all([first.set("one",score(0.1)),first.set("two",score(0.2)),first.set("three",score(0.3))]);
    await first.close();
    const second = new ScoreCache(storage);
    for (const [key,n] of [["one",0.1],["two",0.2],["three",0.3]] as const) await expect(second.get(key)).resolves.toEqual(score(n));
    expect(storage.write).not.toHaveBeenCalled();
    await second.close();
  });

  it("enforces the cap with least-recently-used eviction and preserves updates", async () => {
    const storage = legacy(); const cache = new ScoreCache(storage,{maxEntries:2});
    await cache.set("first",score(0.1)); await cache.set("second",score(0.2));
    await cache.get("first"); await cache.set("third",score(0.3));
    await expect(cache.get("first")).resolves.toEqual(score(0.1));
    await expect(cache.get("second")).resolves.toBeUndefined();
    await cache.set("third",score(0.9));
    await cache.close();
    const reopened = new ScoreCache(storage,{maxEntries:2});
    await expect(reopened.get("first")).resolves.toEqual(score(0.1));
    await expect(reopened.get("third")).resolves.toEqual(score(0.9));
    await reopened.close();
  });

  it("migrates valid rows while retaining the old file and reporting corruption", async () => {
    const errors: unknown[]=[];
    const storage=legacy(JSON.stringify({version:1,entries:[{hash:await hash("kept"),value:score(0.7)},{hash:"invalid",value:score(0.2)}]}));
    const cache=new ScoreCache(storage,{onError:error=>errors.push(error)});
    await expect(cache.get("kept")).resolves.toEqual(score(0.7));
    expect(errors).toHaveLength(1); expect(storage.write).not.toHaveBeenCalled(); await cache.close();
  });

  it("does not overwrite newer scores when legacy migration is retried", async () => {
    const broken=legacy('{broken');const first=new ScoreCache(broken);
    await first.set("key",score(0.9));await first.close();
    const restored=legacy(JSON.stringify({version:1,entries:[{hash:await hash("key"),value:score(0.1)}]}));
    const next=new ScoreCache(restored);await expect(next.get("key")).resolves.toEqual(score(0.9));await next.close();
  });

  it("separates vault databases", async () => {
    const a=new ScoreCache(legacy(),{databaseName:"vault-a"});const b=new ScoreCache(legacy(),{databaseName:"vault-b"});
    await a.set("same",score(0.8));await expect(b.get("same")).resolves.toBeUndefined();await a.close();await b.close();
  });

  it("reports unavailable storage but keeps a bounded fallback for completed scores", async () => {
    vi.stubGlobal("indexedDB",undefined);const errors:unknown[]=[];
    const cache=new ScoreCache(legacy(),{onError:error=>errors.push(error)});
    await cache.set("key",score(0.9));await expect(cache.get("key")).resolves.toEqual(score(0.9));expect(errors.length).toBeGreaterThan(0);await cache.close();
  });
});

it("batch reads span transaction boundaries and survive restart", async () => {
  const cache = new ScoreCache({read:async()=>null},{databaseName:'batch-read-test'});
  const value={score:.8,contribution:'other' as const,scores:{relevant:.8}};
  for(let i=0;i<300;i++)await cache.set(`batch-${i}`,value);
  await cache.close();
  const restored=new ScoreCache({read:async()=>null},{databaseName:'batch-read-test'});
  const result=await restored.getMany([...Array.from({length:300},(_,i)=>`batch-${i}`),'missing','batch-0']);
  expect(result.size).toBe(300);expect(result.get('batch-299')).toEqual(value);
  expect(result.has('missing')).toBe(false);await restored.close();
});
