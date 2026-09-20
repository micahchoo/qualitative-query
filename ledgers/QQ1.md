# QQ1 — run cancellation

Status: done — 2026-09-20. Scope: synthetic vault/transport only, preserve existing working changes, no publication. Contract: no queued work or callbacks after settlement; shared requests survive while another consumer needs them; abort transports where supported. Controls: log it, don't fix it yet; continue the ledger; classify only; the kill criterion stands.

Inventory completed before implementation. Obsidian requestUrl has no AbortSignal option; its already-issued request cannot be physically aborted. Cancellation must still suppress callbacks/retries and prevent additional queued calls. Injected transports can support abort.

| Case or stage | Expected | Actual and measurement | Verdict | Fix commit | Retest |
|---|---|---|---|---|---|
| First failure / 100 candidates | Stop new work and callbacks on rejection | 17 calls at rejection, 100 eventual, 99 late callbacks (5ms mock) | fix | working tree; no commit requested | PASS:17 requests at and after rejection;zero late callbacks (qq-cancellation-after.txt) |
| Middle failure (50th) | Same | 66 calls at rejection, 100 eventual, 50 late callbacks | fix | working tree; no commit requested | PASS:66 requests at and after rejection;zero late callbacks |
| Last failure (100th) | No subsequent callbacks | 100 calls, zero late callbacks; no cancellation ownership exists | retain behavior | working tree; no commit requested | PASS:100 requests at and after rejection;zero late callbacks |
| Closed/replaced view | Cancel its run only | onUnload/refresh only alter view version; engine has no per-run signal | fix | working tree; no commit requested | PASS:cancellation.test.ts last-consumer closure leaves16 already-started calls;zero queued starts |
| Duplicate subscribers | One request, retain surviving subscriber | Existing engine test verifies sharing; only global invalidation can stop work | add per-consumer lifetime | working tree; no commit requested | PASS:closed duplicate rejects;survivor completes from one request;shared signal stays live |
| Refresh/unload | Drop queued stale work | Existing engine generation/gate tests pass; active transport has no abort signal | extend cancellation | working tree; no commit requested | PASS:existing engine invalidation tests and bundled unload smoke;run controllers propagated |
| Retry loop | No retries after cancellation | Jev rank loop has no cancellation check | fix | working tree; no commit requested | PASS:cancelled non-abortable429 response causes one transport call and no retries |

Lesson: rejecting a Promise does not cancel its siblings; make operation ownership explicit through queues and shared-work subscribers. Stored in this ledger; no general instructions added.

Retest: 96 behavior + 3 release tests pass; TypeScript and lint pass. New cancellation matrix covers first/mid/last failure, closed subscriber with shared survivor, last-consumer transport abort and no post-close retries. All post-settlement request counts remain unchanged and callbacks are zero. Changes uncommitted for root review. Physical abort remains unavailable for Obsidian requestUrl; its already-issued requests retain gate slots until settling, with no further retries.

Final verification: release:verify passes111 behavior tests +3 release tests, lint, TypeScript, bundled smoke (real model weights/mock transport), package round-trip. Probe: `node ledgers/probes/qq-cancellation.cjs`; output `ledgers/measurements/qq-cancellation-after.txt`. No publication.
