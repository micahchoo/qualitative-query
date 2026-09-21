# Passages per request

A question with 1,000 shortlisted passages used to cost 1,000 requests. Jev accepts many
questions over one state, so passages that share a question can share a request.

## What the shortlist costs

Measured on `docs/pipeline-runs/2026-09-19-artistry/capture.json`, a real 1,000-candidate run:

| Measure | Value |
| --- | --- |
| Passage size | 381 characters at the median, 900 at the 90th percentile |
| Candidate text, all 1,000 | 437 KB, about 109,000 tokens |
| Question and criteria re-sent per passage | about 350 characters |

The run is bound by round trips, not by tokens. At batch 10 the same 1,000 passages travel in
100 requests and about 117,000 input tokens; at batch 25, in 40 requests. Explicit context
notes reach 48,000 characters and are re-sent with every request, so a question that uses
them saves far more.

## Why the shortlist cannot simply be shorter

Scoring fewer passages would be the obvious saving, but the local shortlist does not predict
the Jev score. In the same capture, Spearman's rho between retrieval rank and Jev score is
**0.116**, and the six displayed passages came from ranks 950, 40, 646, 898, 62 and 611.
A window of 150 would have dropped four of the six. Retrieval rank is a recall device, not a
ranking, so the request count is the only lever left.

## The request shape

One passage keeps the original body exactly:

```json
{ "state": { "question": "…", "candidate_passage": "…", "context_notes": "…" },
  "questions": { "relevant": { "type": "noul", "instructions": "…" } } }
```

Several passages move into a named map, and each question points at its own passage with
`inspect`, the field pointer the API reference documents:

```json
{ "state": { "question": "…", "context_notes": "…", "passages": { "p0": "…", "p1": "…" } },
  "questions": { "p0.relevant": { "type": "noul",
    "instructions": { "question": "…", "inspect": "passages.p0" } } } }
```

Passages share a request only when their question, criteria and context are identical.
`src/batch.ts` holds that rule; `src/jev.ts` builds both bodies.

## What is measured, and what is not

TypeSafe's [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
measures batching over **one fixed state** as 12.2x cheaper and 10.0x faster with no change in
answers, across five repeats. Here the state grows with the batch, which is a different case,
and `jev-1.13`'s known jagged edges include large states full of irrelevant detail and
indirection. **Score drift under batching has not been measured on this vault.**

Measure it with a capture as the baseline. The probe re-scores captured passages through the
shipped client and reports what moved:

```sh
TYPESAFE_API_KEY=… npm run probe:batching -- docs/pipeline-runs/<run>/capture.json --sizes 1,10,25 --sample 200
```

It reports, per batch size: requests, seconds, input tokens, mean and maximum score drift,
Spearman's rho against the baseline, how many passages crossed the threshold, and how much of
the displayed selection survived. It writes `<capture>.batching.json` beside the capture and
touches neither the score cache nor the vault. Two hundred passages at three batch sizes cost
roughly a cent.

Read a batch size as safe only when the threshold crossings and the kept selection hold.

## Reverting

Set **Passages per request** to 1. Batched scores are cached under their own namespace, so the
scores from one-per-request runs are still there, unchanged, and are used again immediately.
Changing the batch size never rewrites a score that already exists; it stores the new shape
beside the old one.
