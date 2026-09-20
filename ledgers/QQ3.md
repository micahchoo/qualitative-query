# QQ3 — many-query retrieval budgets

Status: done — 2026-09-20. Contract: preserve BM25, deterministic ties and text dedup; cooperative ~8ms slices and target <50ms event-loop gaps in synthetic probes; reusable corpus/postings; logarithmic worker top-K. No real API/vault. Controls: log it, don't fix it yet; continue the ledger; classify only; the kill criterion stands.

| Case or stage | Expected | Actual and measurement | Verdict | Fix commit | Retest |
|---|---|---|---|---|---|
| Warm lexical 10k, Q1/10/50 | Shared bounded work | 19/84/364ms; timer gaps13/76/347ms | fix | working tree; no commit requested | PASS:preserved lexical probe39/71/221ms;gaps11/8/8ms (first call cold postings) |
| Warm lexical 50k, Q1/10/50 | Shared bounded work |74/485/2372ms; timer gaps28/118/502ms | fix | working tree; no commit requested | PASS:preserved lexical probe164/376/1814ms;gaps12/10/17ms (first call cold postings) |
| Warm lexical100k,Q1 | Cooperative ranking |138ms,68ms max gap in second probe | fix | working tree; no commit requested | PASS:cold100k430ms,gap28ms;warm full engine138ms,gap8ms |
| Selective vs broad, cold/warm | Avoid per-query token census | Every query reads all metadata tokens regardless of selectivity; metadata warm only avoids tokenization | fix | working tree; no commit requested | PASS:full engine selective Q50 at10k/50k/100k=4/3/2ms;postings built once across10 concurrent queries |
| Edits | Reuse unchanged block extraction | index keeps Block objects for unchanged files; every retrieval discards corpus statistics | fix | working tree; no commit requested | PASS:100k one-block revision first query290ms,gap13ms;subsequentQ50=4561ms,gap31ms;unchanged per-block counts reused |
| Worker50k top32/top4000 | Bounded logarithmic top-K | Root isolated worker probe6/543ms median; findIndex scans up toK for every vector | fix | working tree; no commit requested | PASS:real-worker mocked-cosine50k top4000 median3ms;heap comparison bound and exact tie tests pass |
| Saved vs mounted | No work for unopened questions | Only views Set receives refresh, preserve this | preserve | working tree; no commit requested | PASS:refresh still iterates only mounted views;no saved-note query evaluation added |

Lesson: debounce does not bound work; candidate caps must also bound intermediate ranking work. Stored here. Real Obsidian/mobile timing remains an external manual check, not claimed by synthetic tests.

## Final measurements and limits

Preserved scripts: `ledgers/probes/qq-retrieval-matrix.cjs` (run with Node), `ledgers/probes/qq-memory.cjs` (run with `node --expose-gc`). Matching stdout is under `ledgers/measurements/`. They self-build current sources in a disposable scratch directory, use synthetic passages and mock semantic results; they require only the plugin's installed build dependency.

Full engine + retrieval,50k passages,Q1/10/50 distinct broad questions:76/434/2247ms and maximum timer gaps9/8/16ms. At100k:138/944/4651ms and gaps8/23/24ms. Warm identical Q50 uses zero new semantic calls and takes4–10ms. The cold corpus now builds reusable postings, so cold timings are not equivalent to the earlier warm-hash-only baseline.

The responsiveness target (<50ms observed event-loop gaps) passed this matrix; no claim that50 broad questions finish within100ms. Completion remains proportional to matching data and number of distinct questions. Postings rebuild once per corpus revision; they are not a fully incremental persistent index. The shared scheduler allows two active jobs under one6ms budget; large allocations/GC are runtime-dependent. Peak heap reached688MB transiently in the matrix. In a separate100k-passage/50-query/five-revision probe, forced-GC retained heap was138/138/139/138/138MB and fell to8MB after disposal. This establishes a synthetic plateau, not a mobile memory guarantee; real model vectors/DOM/Obsidian memory are excluded.

BM25 scores, term summation order, deterministic IDs, whitespace duplicate preference, and hybrid fusion match the original reference in regression tests. Worker top-K comparison count is bounded byO(N log K), corpus traversal occurs once for concurrent readers, and cancellation/restart tests remain green. `release:verify`:111 behavior +3 release tests, lint, TypeScript, bundled real-model smoke,14-file package round-trip all pass. No real vault, remote API, commit or publication. Device-specific UI/heap checks remain external.
