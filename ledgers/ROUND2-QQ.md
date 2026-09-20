# Round 2 — Qualitative Query lifetimes and larger workloads

Status: done — 2026-09-20. Read prior QQ1–3 decisions and current source; this pass goes beyond those results. Root owns versions, release and commits. No real vault or API.

Contract: remove cancelled consumer retention; prevent delayed rename work from reintroducing non-Markdown sources; reduce full-match transient allocations without changing scores/order/dedup; deliver first completed questions without waiting behind the entire burst. Preserve shared survivors, cancellation, queue fairness, and exact reference ranking. Stress250k/500k passages with100/200 questions where memory permits. A synthetic1,500MB heap guard cancels a run rather than risking uncontrolled growth. Controls: log it, don't fix it yet; continue the ledger; classify only; the kill criterion stands.

| Case or stage | Expected | Actual before fix | Verdict / planned fix | Retest |
|---|---|---|---|---|
| Cancelled SharedWork subscribers while survivor remains | Cancelled consumers collectible before transport settles | 10,000 joins/cancels retain all10,000 AbortSignals after forced GC;27MB heap. Each join installs a non-removable reaction on the pending base promise (src/work.ts). | Replace per-join reactions with an explicit removable subscriber set and one base completion handler. | PASS:10,000 cancelled signals retained before→0 after;heap27→5MB. Shared survivor/retirement tests pass. |
| Markdown file renamed while index timer pending | Non-Markdown target excluded and current views refreshed | src/main.ts rename removes old path but scheduleIndex returns for txt without cancelling old timer/invalidating views; VaultIndex.indexFile(txt) accepts1 searchable block in executed probe. | Cancel old-path timer; invalidate/requery on extension-changing rename; guard indexFile itself. | PASS:txt indexes0 blocks;bundled smoke covers modify-timer→rename and clears both corpus and visible result. |
|250k passages /100 distinct broad questions | Bounded transient work and every live query completes | Cold1184ms; stress cancelled at16,271ms by1,505MB heap guard; all100 runs aborted. Retained heap309MB, disposal13MB. src/search.ts allocates a full match Set and representative Map for each query, plus per-block Map counts and Map postings. | Compact per-block counts/postings; precompute duplicate groups; stream matches with compact visited state and bounded heaps instead of full-match objects. | PASS:250k×100 finishes4354ms,first117ms,gap10ms,peak392MBheap+10MBbuffers;all100 succeed. |
| Completion stage scheduling | First question can finish while later questions are scanning | Cooperative scheduler fills active slots from a single FIFO; fusion gets appended behind the burst's expensive lexical jobs. Source trace explains why the stress run had no completed results before its guard. | Prioritize bounded completion/synchronization stages while keeping normal scan admission FIFO; measure first successful result. | PASS:priority regression completes an early question before final scan;500k×200 first380ms/all19,091ms. |
| Ranking/cancellation/restart compatibility | Exact scores, IDs, text dedup and shared-survivor behavior unchanged | Existing111 behavior +3 release tests passed prior round; exact-reference tests are present. | Retest/add duplicate-heavy, large-term and lifecycle cases. | PASS:118 behavior +3 release tests;duplicate-heavy exact reference ranking and previous cancellation/restart cases pass. |

Reproduction: `node --expose-gc ledgers/probes/qq-round2-lifecycle.cjs`; `node --expose-gc ledgers/probes/qq-round2-stress.cjs 250000 100`. Before stdout saved as `ledgers/measurements/qq-round2-lifecycle-before.txt` and `qq-round2-stress-before.txt`.

Lessons pending harvest: cancellation must detach retained callbacks as well as listeners; cap intermediate allocation, not just active jobs; completion work should not queue behind every newly admitted scan.

## Additional verified boundary findings (recorded before fixes)

| Case or stage | Expected | Actual before fix | Fix | Retest |
|---|---|---|---|---|
|One150k-paragraph Markdown source | Corpus can be read after indexing | Actual VaultIndex.indexFile succeeds, then index.blocks throws Maximum call stack size exceeded from spreading one file's blocks into push. | Append iteratively; also remove the unbounded spread in context assembly. | PASS:actual150k-paragraph note yields150,000 indexed blocks;regression test passes. |
| Explicit context overlap removal | Work scales with ordered source ranges | Actual engine1000/5000/10000 contextblocks reads lineStart1,002,996/25,014,996/100,029,996 times, taking20/321/1274ms. Sorted intervals still compare against every earlier selection. | Compare only the last selected interval; preserve span/tie semantics and test operation counts. | PASS:1000/5000/10000 contextblocks now4,995/24,995/49,995 lineStart reads (5/1/8ms);nested/equal-range fixtures pass. |

Probe `ledgers/probes/qq-round2-boundaries.cjs`; before output `ledgers/measurements/qq-round2-boundaries-before.txt`. Large-note parsing itself is still synchronous; this fix removes the argument-limit correctness failure, not a universal per-file parsing latency claim.

## Final stress matrix

All rows use actual local QueryEngine/LocalRetrieval with synthetic passages, mocked empty semantic results, no network or DOM. Heap excludes ArrayBuffers; RSS includes runtime overhead. Timings are single-run observations, not device SLAs. The before250k×100 run hit the1,500MB guard and all100 runs aborted; every after run completed without errors.

| Passages | Questions | Cold build ms | First result ms | All warm ms | Max timer gap ms | Peak heap MB | Peak ArrayBuffers MB | Peak RSS MB | Retained/disposed heap MB |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|250000|100|1014|117|4354|10|392|10|543|210/13|
|250000|200|962|118|9242|11|542|13|702|211/13|
|500000|100|1898|378|9838|10|578|55|778|407/21|
|500000|200|1841|380|19091|15|675|73|890|407/21|

Per-query full-match Set/Map storage is gone. Immutable corpus data owns compact ordered term/count arrays, compact posting ordinals (singletons stored as numbers), and precomputed text-duplicate groups. Query state uses a document-visited byte array and compact duplicate-group representatives, with bounded top-K heaps and allocation only for competitive candidates. Two active cooperative jobs still share a6ms slice budget; bounded completion and synchronization stages are admitted ahead of waiting scans so first results do not wait for the entire burst. Scores retain original document token order. Memory continues to grow with actual corpus data and active result views; no unlimited-vault or mobile-memory claim.

Source-boundary limits:150k-paragraph source parsing is still synchronous; iterative flattening removes its correctness failure. Context overlap checks are now linear after ordering, with the original longest-span/tie behavior preserved. Remote network latency, real embedding vectors, DOM/rendering, and Obsidian memory are excluded from the large synthetic matrix. Obsidian requestUrl still cannot physically abort an already-issued request.

## Verification and reproducibility

`npm run release:verify` passed on0.3.13: lint, TypeScript,118 tests in21 files,3 release tests, bundled smoke with real pinned model weights/mocked transport (including rename recovery),14-file hash checks and ZIP round-trip. Full output: `ledgers/measurements/qq-round2-release-verify.txt`.

Portable copies included in the plugin repository: `scripts/probe-query-lifetimes.cjs`, `scripts/probe-query-scale.cjs`, `scripts/probe-query-boundaries.cjs`. Run lifetimes/scale with `node --expose-gc`; scale accepts passage and query counts. They self-build sources into a disposable temporary directory and require no workspace-specific path or prebuilt temporary artifact. Root ledger versions and before/after measurements remain under `ledgers/probes` and `ledgers/measurements`.

Harvest: retain lessons here—cancelled consumers must be detachable from pending shared work, intermediate storage must be bounded as well as active jobs, and completion work must not sit behind all newly admitted scans. Root owns cross-project instructions, commits and publication; this agent did not change versions, workflows or publish assets.
