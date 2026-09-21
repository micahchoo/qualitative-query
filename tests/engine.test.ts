import "fake-indexeddb/auto";
import { parseMarkdown } from "../src/markdown";
import { describe, expect, it, vi } from "vitest";
import { QueryEngine } from "../src/engine";
import type { Block, QuerySpec } from "../src/types";

const block = (id: string, path: string, text: string): Block => ({ id, path, lineStart: 1, lineEnd: 1, text, searchText: text, kind: "paragraph", headingPath: [] });
const spec: QuerySpec = { question: "What defines conflict?", folder: "Queries", contextPaths: ["context.md"], criteria: { mode: "default" } };

describe("query engine", () => {
  it("keeps the corpus vault-wide while passing explicit context to Jev", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { definition: { noul: 0.8 }, condition: { noul: 0.2 }, distinction: { noul: 0.1 }, contribution: { choice: "definition" } } });
    const client = { rank } as any;
    const corpus = [block("a", "a.md", "A conflict is a disagreement."), block("b", "b.md", "Conflict has conditions.")];
    const engine = new QueryEngine(client, () => corpus, (path) => path === "context.md" ? [block("ctx", path, "In this project conflict means a design disagreement.")] : []);
    const progress = vi.fn();
    const result = await engine.run(spec, 10, 10, 0.4, progress);
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(result.status).toBe("ready");
    expect(rank).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.anything(), expect.stringContaining("design disagreement"), expect.objectContaining({ onThrottle: expect.any(Function), onRequest: expect.any(Function) }), expect.any(AbortSignal));
    expect(rank).toHaveBeenCalledTimes(2);
  });

  it("reports API failures instead of presenting an empty qualitative view", async () => {
    const client = { rank: vi.fn().mockRejectedValue(new Error("Jev request failed (401).")) } as any;
    const engine = new QueryEngine(client, () => [block("a", "a.md", "A conflict is a disagreement.")]);
    await expect(engine.run({ ...spec, contextPaths: [] }, 10, 10, 0.4)).rejects.toThrow("401");
  });

  it("shares scores for identical text while preserving different source locations", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.8 } } });
    const engine = new QueryEngine({ rank } as any, () => [block("a", "a.md", "same conflict passage"), block("b", "b.md", "same conflict passage")]);
    const result = await engine.run({ ...spec, criteria: { mode: "generic" }, contextPaths: [] }, 10, 10, 0.4);
    expect(result.judgements.map((item) => item.candidate.path).sort()).toEqual(["a.md", "b.md"]);
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it("invalidates judgement cache when context content changes", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.8 } } });
    let context = "The first meaning.";
    const engine = new QueryEngine({ rank } as any, () => [block("a", "a.md", "conflict definition")], () => [block("context", "context.md", context)]);
    const generic = { ...spec, criteria: { mode: "generic" as const }, contextPaths: ["context.md"] };
    await engine.run(generic, 10, 10, 0.4);
    context = "The edited meaning.";
    await engine.run(generic, 10, 10, 0.4);
    expect(rank).toHaveBeenCalledTimes(2);
    expect(rank.mock.calls[1][3]).toContain("edited meaning");
  });

  it("returns the current candidate when reusing a cached judgement", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.8 } } });
    let corpus = [block("a", "a.md", "conflict definition")];
    const engine = new QueryEngine({ rank } as any, () => corpus);
    const generic = { ...spec, criteria: { mode: "generic" as const }, contextPaths: [] };
    await engine.run(generic, 10, 10, 0.4);
    const replacement = block("a", "a.md", "conflict definition");
    corpus = [replacement];
    const result = await engine.run(generic, 10, 10, 0.4);
    expect(result.judgements[0].candidate.path).toBe(replacement.path);
    expect(result.judgements[0].candidate.text).toBe(replacement.text);
    expect(rank).toHaveBeenCalledTimes(1);
  });

  it("orders default contributions before score order", async () => {
    const rank = vi.fn().mockImplementation(async (_q: string, passage: string) => ({ answers: {
      definition: { noul: passage.includes("condition") ? 0.99 : 0.2 },
      condition: { noul: passage.includes("condition") ? 0.2 : 0.9 },
      distinction: { noul: 0.1 }, contribution: { choice: passage.includes("condition") ? "condition" : "definition" },
    } }));
    const engine = new QueryEngine({ rank } as any, () => [block("c", "c.md", "condition conflict"), block("d", "d.md", "definition conflict")]);
    const result = await engine.run(spec, 10, 10, 0.05);
    expect(result.judgements.map((item) => item.contribution)).toEqual(["definition", "condition"]);
  });

  it("rejects malformed model responses instead of returning empty", async () => {
    const engine = new QueryEngine({ rank: vi.fn().mockResolvedValue({ answers: {} }) } as any, () => [block("a", "a.md", "conflict definition")]);
    await expect(engine.run({ ...spec, contextPaths: [] }, 10, 10, 0.4)).rejects.toThrow(/invalid score/);
  });

  it("deduplicates overlapping parent and child ranges", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.8 } } });
    const parent = block("parent", "a.md", "conflict parent\nchild text"); parent.lineStart = 1; parent.lineEnd = 3;
    const child = block("child", "a.md", "conflict child"); child.lineStart = 2; child.lineEnd = 3;
    const result = await new QueryEngine({ rank } as any, () => [parent, child]).run({ ...spec, criteria: { mode: "generic" }, contextPaths: [] }, 10, 10, 0.4);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("child");
  });

  it("allows concurrent query views to complete independently", async () => {
    const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.8 } } });
    const engine = new QueryEngine({ rank } as any, () => [block("a", "a.md", "conflict definition")]);
    const one = engine.run({ ...spec, question: "conflict" , criteria: { mode: "generic" }, contextPaths: [] }, 10, 10, 0.4);
    const two = engine.run({ ...spec, question: "definition", criteria: { mode: "generic" }, contextPaths: [] }, 10, 10, 0.4);
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);
    expect(rank).toHaveBeenCalledTimes(2);
  });

  it("does not publish a request invalidated by a source refresh", async () => {
    let resolve!: (value: unknown) => void;
    const rank = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    const engine = new QueryEngine({ rank } as any, () => [block("a", "a.md", "conflict definition")]);
    const stale = engine.run({ ...spec, criteria: { mode: "generic" }, contextPaths: [] }, 10, 10, 0.4);
    await vi.waitFor(() => expect(rank).toHaveBeenCalled());
    engine.invalidate();
    resolve({ answers: { relevant: { noul: 0.9 } } });
    await expect(stale).rejects.toThrow(/superseded/);
  });
});

it("reuses persisted scores after engine restart and invalidates changed passages", async () => {
  const { ScoreCache } = await import('../src/score-cache');
  let saved: string | null = null;
  const storage = { read: async () => saved, write: async (value: string) => { saved = value; } };
  const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.9 } } });
  let corpus = [block('a', 'a.md', 'collective conflict resolution')];
  const query = { ...spec, contextPaths: [], criteria: { mode: 'generic' as const } };
  const first = new QueryEngine({ rank }, () => corpus, () => [], 'jev-v1', new ScoreCache(storage));
  await first.run(query, 12, 8, 0.45); first.dispose();
  const second = new QueryEngine({ rank }, () => corpus, () => [], 'jev-v1', new ScoreCache(storage));
  expect((await second.run(query, 12, 8, 0.45)).judgements).toHaveLength(1);
  expect(rank).toHaveBeenCalledTimes(1);
  corpus = [block('a', 'a.md', 'collective conflict resolution revised')];
  await second.run(query, 12, 8, 0.45);
  expect(rank).toHaveBeenCalledTimes(2);
});

it("skips oversized model inputs without losing other results", async () => {
  const rank = vi.fn().mockImplementation(async (_q: string, passage: string) => {
    if (passage.includes('oversized')) throw Object.assign(new Error('too many tokens'), {code:'INPUT_TOO_LARGE'});
    return {answers:{relevant:{noul:0.9}}};
  });
  const engine = new QueryEngine({rank}, () => [block('a','a.md','conflict oversized'),block('b','b.md','conflict definition')]);
  const result = await engine.run({...spec,contextPaths:[],criteria:{mode:'generic'}},12,8,0.45);
  expect(result.judgements).toHaveLength(1);
  expect(result.warning).toContain('model input limit');
});

it("shows local retrieval without a key and does not apply Jev probability thresholds", async () => {
  const blocks = parseMarkdown("source.md", "Mediation resolves conflict.");
  const engine = new QueryEngine(null, () => blocks);
  const result = await engine.run({question:"conflict",folder:"Queries",contextPaths:[],criteria:{mode:"default"}},12,8,1);
  expect(result.status).toBe("ready");
  expect(result.selection).toBe("local");
  expect(result.judgements).toHaveLength(1);
  expect(result.judgements[0].contribution).toBe("other");
  expect(result.warning).toContain("Jev API key");
});

it("evaluates a thousand candidates without widening the displayed result limit", async () => {
  const corpus = Array.from({ length: 1000 }, (_, i) => block(`passage-${i}`, `note-${i}.md`, `Conflict evidence ${i}.`));
  const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.9 } } });
  const engine = new QueryEngine({ rank }, () => corpus);
  const progress = vi.fn();
  const result = await engine.run({ ...spec, contextPaths: [], criteria: { mode: "generic" }, limit: 6 }, 1000, 8, 0.5, progress);
  expect(result.candidates).toHaveLength(1000);
  expect(rank).toHaveBeenCalledTimes(1000);
  expect(result.judgements).toHaveLength(6);
  expect(progress).toHaveBeenLastCalledWith(1000, 1000);
});

it("revisits an earlier thousand-candidate query after other queries and a restart without rescoring", async () => {
  const { ScoreCache } = await import("../src/score-cache");
  const storage = { read: async () => null };
  const options = { databaseName: "navigation-thousand-candidates" };
  const corpus = Array.from({length:1000},(_,i)=>block(`retained-${i}`,`retained-${i}.md`,`Conflict evidence ${i}.`));
  const rank = vi.fn().mockResolvedValue({answers:{relevant:{noul:0.9}}});
  const firstCache = new ScoreCache(storage,options);
  const engine = new QueryEngine({rank},()=>corpus,()=>[],"cache-scale-test",firstCache);
  const query = {...spec,contextPaths:[],criteria:{mode:"generic" as const}};
  for (const question of ["Conflict first", "Conflict second", "Conflict third"]) await engine.run({...query,question},1000,6,0.5);
  expect(rank).toHaveBeenCalledTimes(3000);
  engine.dispose(); await firstCache.close();
  const restoredCache = new ScoreCache(storage,options);
  const restored = new QueryEngine({rank},()=>corpus,()=>[],"cache-scale-test",restoredCache);
  const result = await restored.run({...query,question:"Conflict first"},1000,6,0.5);
  expect(result.judgements).toHaveLength(6);
  expect(rank).toHaveBeenCalledTimes(3000);
  restored.dispose();await restoredCache.close();
});

it("starts 16 requests in retrieval order, reduces concurrency on throttling, and publishes before completion", async () => {
  const corpus = Array.from({length:40},(_,i)=>block(String(i),`${40-i}.md`,`conflict ${i}`));
  const pending: Array<() => void> = [];
  let active = 0, peak = 0;
  const rank = vi.fn((_q, _p, _c, _ctx, hooks: { onThrottle?: () => void }) => new Promise<any>(resolve => {
    active++; peak = Math.max(peak, active);
    pending.push(() => { active--; resolve({answers:{relevant:{noul:.8}}}); });
  }));
  const retrieval = () => ({ candidates: corpus.map((b,i)=>({...b,lexicalScore:40-i})) });
  const engine = new QueryEngine({rank},()=>corpus,()=>[],"",undefined,retrieval);
  const partial = vi.fn();
  const run = engine.run({...spec,contextPaths:[],criteria:{mode:"generic"}},1000,6,.5,undefined,partial);
  await vi.waitFor(()=>expect(rank).toHaveBeenCalledTimes(16));
  expect(rank.mock.calls.map(c=>c[1])).toEqual(corpus.slice(0,16).map(b=>b.text));
  rank.mock.calls[0][4].onThrottle!();
  pending.shift()!();
  await vi.waitFor(()=>expect(partial).toHaveBeenCalled());
  expect(rank).toHaveBeenCalledTimes(16);
  for(let i=0;i<7;i++) pending.shift()!();
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(rank).toHaveBeenCalledTimes(16); // eight remain; reduced cap is eight
  pending.shift()!();
  await vi.waitFor(()=>expect(rank).toHaveBeenCalledTimes(17));
  while(rank.mock.calls.length<40 || pending.length){
    pending.splice(0).forEach(done=>done());
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  const result = await run;
  expect(peak).toBe(16);
  expect(result.judgements).toHaveLength(6);
});

it("holds enough passages in flight to fill a batching client's requests", async () => {
  const corpus = Array.from({length:200},(_,i)=>block(String(i),`${200-i}.md`,`conflict ${i}`));
  let active = 0, peak = 0;
  const rank = vi.fn(() => new Promise<any>(resolve => {
    active++; peak = Math.max(peak, active);
    window.setTimeout(() => { active--; resolve({answers:{relevant:{noul:.8}}}); }, 0);
  }));
  const retrieval = () => ({ candidates: corpus.map((b,i)=>({...b,lexicalScore:200-i})) });
  const engine = new QueryEngine({rank, batchSize: 4},()=>corpus,()=>[],"",undefined,retrieval);
  await engine.run({...spec,contextPaths:[],criteria:{mode:"generic"}},200,6,.5);
  expect(peak).toBe(64); // sixteen requests of four passages
});

it("reuses persisted content after moves but rescoring follows heading, rubric, and model changes", async () => {
  const {ScoreCache}=await import('../src/score-cache');
  const cache = new ScoreCache({read:async()=>null},{databaseName:'content-moves'});
  const rank=vi.fn().mockResolvedValue({answers:{relevant:{noul:.9}}});
  let corpus=[block('old','old.md','conflict evidence')];
  const query={...spec,contextPaths:[],criteria:{mode:'generic' as const}};
  await new QueryEngine({rank},()=>corpus,()=>[],'model-a',cache).run(query,1000,6,.5);
  corpus=[{...block('new','new.md','conflict evidence'),lineStart:50,lineEnd:50}];
  const engine=new QueryEngine({rank},()=>corpus,()=>[],'model-a',cache);
  expect((await engine.run(query,1000,6,.5)).judgements[0].candidate.path).toBe('new.md');
  expect(rank).toHaveBeenCalledTimes(1);
  corpus[0].headingPath=['Changed meaning'];
  await engine.run(query,1000,6,.5);
  await engine.run({...query,criteria:{mode:'generic',instructions:'Different rubric'}},1000,6,.5);
  await new QueryEngine({rank},()=>corpus,()=>[],'model-b',cache).run(query,1000,6,.5);
  expect(rank).toHaveBeenCalledTimes(4);
  await cache.close();
});

it("promotes legacy location scores using batched lookups without API calls", async () => {
  const value={score:.9,contribution:'other' as const,scores:{relevant:.9}};
  const stored=new Map<string,typeof value>();
  const getMany=vi.fn(async(keys:string[])=>new Map(keys.flatMap(key=>{
    if(JSON.parse(key).candidate)return [[key,value] as const];
    return stored.has(key)?[[key,stored.get(key)!] as const]:[];
  })));
  const cache={get:vi.fn(),getMany,set:vi.fn(async(key:string,v:typeof value)=>{stored.set(key,v);})};
  const rank=vi.fn();
  const corpus=[block('a','a.md','conflict evidence')];
  const engine=new QueryEngine({rank},()=>corpus,()=>[],'old-namespace',cache);
  const result=await engine.run({...spec,contextPaths:[],criteria:{mode:'generic'}},1000,6,.5);
  expect(result.judgements).toHaveLength(1);
  expect(rank).not.toHaveBeenCalled();expect(cache.get).not.toHaveBeenCalled();
  expect(cache.set).toHaveBeenCalledTimes(1);
  expect(JSON.parse([...stored.keys()][0])).toMatchObject({keyVersion:2,passage:'conflict evidence'});
});

it("preserves retrieval warnings through partial and final Jev results", async () => {
  const corpus = [block("a", "a.md", "Conflict is a disagreement.")];
  const engine = new QueryEngine({ rank: async () => ({ answers: { relevant: { noul: 0.9 } } }) },
    () => corpus, () => [], "", undefined,
    () => ({ candidates: corpus.map(candidate => ({ ...candidate, lexicalScore: 1 })), warning: "Keyword fallback for this question." }));
  const partial = vi.fn();
  const result = await engine.run({ ...spec, contextPaths: [], criteria: { mode: "generic" } }, 10, 6, 0.5, undefined, partial);
  expect(result.warning).toBe("Keyword fallback for this question.");
  expect(partial.mock.calls[0][0].warning).toContain("Keyword fallback for this question.");
});

it("accounts for rejected scores and reuses them after lowering the threshold", async () => {
 const corpus = [block("a", "a.md", "Conflict one"), block("b", "b.md", "Conflict two")];
 const rank = vi.fn(async (_question: string, passage: string) => ({ answers: { relevant: { noul: passage.includes("one") ? 0.8 : 0.2 } } }));
 const engine = new QueryEngine({ rank }, () => corpus);
 const query = { ...spec, contextPaths: [], criteria: { mode: "generic" as const } };
 const first = await engine.run(query, 10, 6, 0.5);
 expect(first.stats).toMatchObject({ checked: 2, cached: 0, requested: 2, passed: 1, skipped: 0 });
 expect(first.belowThreshold?.map(j => j.score)).toEqual([0.2]); expect(first.judgements).toHaveLength(1);
 const second = await engine.run(query, 10, 6, 0.1);
 expect(second.stats).toMatchObject({ checked: 2, cached: 2, requested: 0, passed: 2 });
 expect(second.belowThreshold).toEqual([]); expect(rank).toHaveBeenCalledTimes(2);
});
it("counts shared requests separately and exposes all-rejected results", async () => {
 const corpus = [block("a", "a.md", "Conflict same"), block("b", "b.md", "Conflict same")];
 const rank = vi.fn(async () => ({ answers: { relevant: { noul: 0.1 } } }));
 const engine = new QueryEngine({ rank }, () => corpus);
 const result = await engine.run({ ...spec, contextPaths: [], criteria: { mode: "generic" } }, 10, 6, 0.5);
 expect(result.stats).toMatchObject({ checked: 2, requested: 1, shared: 1, passed: 0 });
 expect(result.status).toBe("empty"); expect(result.belowThreshold).toHaveLength(2);
});

it("deduplicates ordered context ranges with linear position work", async () => {
  let reads = 0;
  const context = Array.from({ length: 10_000 }, (_, i) => ({ ...block(String(i), "context.md", "x"), get lineStart() { reads++; return i * 2 + 1; }, lineEnd: i * 2 + 1 }));
  const engine = new QueryEngine(null, () => [], () => context);
  await engine.run({ ...spec, contextPaths: ["context.md"] }, 10, 10, 0.5);
  expect(reads).toBeLessThan(10_000 * 10);
});

it("keeps the original context overlap/span/tie behavior across disjoint ranges", async () => {
  const context = [
    { ...block("a", "context.md", "short"), lineStart: 1, lineEnd: 2 },
    { ...block("b", "context.md", "parent"), lineStart: 1, lineEnd: 5 },
    { ...block("c", "context.md", "child"), lineStart: 3, lineEnd: 4 },
    { ...block("d", "context.md", "next"), lineStart: 8, lineEnd: 9 },
    { ...block("e", "context.md", "equal-range duplicate"), lineStart: 8, lineEnd: 9 },
  ];
  const rank = vi.fn().mockResolvedValue({ answers: { relevant: { noul: 0.9 } } });
  const engine = new QueryEngine({ rank }, () => [block("source", "source.md", "conflict")], () => context);
  await engine.run({ ...spec, criteria: { mode: "generic" }, contextPaths: ["context.md"] }, 10, 10, 0.5);
  expect(rank.mock.calls[0][3]).toBe("parent\n\nnext");
});
