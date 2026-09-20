# QQ2 — obsolete retrieval

Status: done — 2026-09-20. Contract: obsolete queued tasks execute no worker search; pending entries track live consumers; synchronize once per corpus revision. Fake worker only. No publication. Controls: log it, don't fix it yet; continue the ledger; classify only; the kill criterion stands.

| Case or stage | Expected | Actual and measurement | Verdict | Fix commit | Retest |
|---|---|---|---|---|---|
| 20 stale searches + newest | Skip stale queued search | Actual queue executes21; newest waits211ms at mocked10ms/search | fix | working tree; no commit requested | PASS:20 invalidated +1 current executes1 worker search;newest11ms (10ms mock) |
| Corpus synchronization | Once per immutable snapshot | Map/filter/diff in every queued search even identical array | fix | working tree; no commit requested | PASS:real queue tests1/10/50 have one update per shared snapshot;new revision sees new block |
| Duplicate questions | Coalesce same snapshot/question/limit | No retrieval cache/sharing; each call queued | fix | working tree; no commit requested | PASS:concurrent identical requests share one search;warm retrieval cache avoids another search |
| Rapid revisions / 1,10,50 views | Queue bounded by live consumer count | Promise chain retains every generation until its work completes; no removal mechanism | fix | working tree; no commit requested | PASS:1/10/50 obsolete queued consumers removed;only active+newest searches execute |
| Distinct current questions | All complete fairly | FIFO currently preserves order, must retain fairness | preserve | working tree; no commit requested | PASS:matrix1/10/50 distinct current queries all finish;cooperative active work capped at2 |

Lesson: serialization needs cancellation/backpressure. Stored here.

Restart/restore follow-up: explicit generation guards and owned shared-task cancellation prevent retired searches from populating the replacement cache; both races pass in retrieval-queue.test.ts. SharedWork retires once, and corpus callbacks also check task identity. All111 behavior +3 release tests and release:verify pass.

Reproduce: `node ledgers/probes/qq-queue.cjs`; output `ledgers/measurements/qq-queue-after.txt`. The old exploratory adapter omitted the newly added signal parameter; this preserved probe forwards it. Tests separately hold one worker search active to prove queued cancellation while that search finishes. Already-running worker messages cannot be interrupted individually; subsequent messages are stopped.
