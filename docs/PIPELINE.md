# Review and bake a qualitative query

This pipeline turns a question into reviewed connections between source passages.
The test is: **Does each passage earn its place under the question, with its meaning intact?**
A model score is a selection aid. It is not a quality certificate.

## Files and ownership

| Artifact | Owner and purpose |
| --- | --- |
| Vault `Queries/*.md` | User-authored question, criteria, context, and display settings |
| Vault source notes | Original passages; baking can add native block IDs |
| Local IndexedDB | Reusable Jev scores; not an audit history or a synced vault artifact |
| `docs/pipeline-runs/<run>/capture.json` | Captured query, settings, candidate ranks, scores, and source text |
| `docs/pipeline-runs/<run>/review.json` | Reviewer decisions and reasons |
| `docs/pipeline-runs/<run>/REPORT.md` | Findings, limitations, and completed gates |
| Vault `Baked queries/*.md` | Fixed selections as live source embeds |

Keep each run in a new directory. Preserve earlier captures and decisions.
Captures contain vault text. Do not publish them as plugin release assets.

## 1. State the question and criterion

Record the exact query and criterion before reviewing passages.
Record the vault, plugin version, model, threshold, candidate window, result limit, and explicit context.
Use the loaded plugin version, not the manifest copied onto disk.

Do not replace a broad criterion with a stricter one during review.
For a different criterion, create a separate query and run.

## 2. Check the query and source structure

Parse the query with `src/query.ts`.
Check that context links resolve and that source exclusions match the intended scope.
Keep tables, quotations, callouts, and code fences intact.
Exclude query notes and baked notes from retrieval.

Syntax checks cannot assess whether a passage answers the question.

## 3. Capture retrieval and scoring

Use the plugin's actual retrieval and scoring engine.
Record original retrieval ranks before overlap removal.
Capture all candidate scores, including scores below the threshold.
Keep the original display limit separately.

The capture helper temporarily requests all scores with threshold zero.
It preserves the question, model, criteria, and explicit context.
This does not change the saved query or its normal display threshold.
Cached scores can satisfy the run. Cache hits are not new independent judgements.

Build the helper from the workspace root:

```sh
qualitative-query/node_modules/.bin/esbuild \
  qualitative-query/scripts/pipeline-capture.ts \
  --bundle --platform=node --format=iife \
  --alias:obsidian=./qualitative-query/scripts/pipeline-obsidian.ts \
  --outfile=qualitative-query/docs/pipeline-runs/<run>/capture.js
```

Run the bundle inside the target Obsidian vault through its `eval` command:

```js
eval(require('node:fs').readFileSync('/absolute/path/to/capture.js', 'utf8'));
captureQualitativePipeline({
  queryPath: 'Queries/Question.md',
  bakedPath: 'Baked queries/Question.md', // optional
  output: '/absolute/path/to/capture.json'
});
```

The helper currently supports one query fence and no YAML frontmatter.
It requires Jev selection and can send uncached passages to Jev.
It reads plugin settings selectively and does not export credentials.
The `eval` command can return before capture finishes. Check the output file and handle promise errors.

Reject partial or failed scoring as a completed run.
Record any oversized passages that the engine skipped.
Do not interpret a missing score as a rejection.

## 4. Review the selection

Read every displayed passage, then read its surrounding source text.
Record one decision per passage:

- **KEEP:** meets the stated criterion and can stand in the selection.
- **CUT:** fails the criterion, repeats a stronger passage, or loses necessary meaning.
- **HOLD:** needs context, attribution, or another check before use.

Record a concrete reason for every decision.
Separate the essay author from people quoted or discussed in the essay.
Do not treat the note title as the passage's speaker.
Preserve different viewpoints without presenting them as one agreed definition.

Check repeated ideas separately from exact text duplicates.
If a duplicate is cut, identify the kept passage that replaces it.
Do not force cuts when every selected passage meets the criterion.

The reviewer in an agent-assisted run is the assistant unless another reviewer is named.
Do not describe that review as independent human approval.

## 5. Check what the scorer could not see

Inspect samples on both sides of the score threshold.
Search the vault separately for known useful passages.
For each useful omission, record its stage:

1. Absent from the candidate window: retrieval omission.
2. Removed as an overlapping block: structural exclusion.
3. Retrieved but not scored: incomplete evaluation or explicit skip.
4. Scored below threshold: scoring rejection.
5. Passed but not displayed: result limit or ordering.

Use targeted searches as counterexamples, not as a recall estimate.
Do not report vault-wide recall without a labelled reference set.
A single query does not establish quality across the vault.

## 6. Apply the review

Save decisions before creating the reviewed note.
Record the selected order and every replacement.
Keep the original query and baked note intact.
Create a new reviewed note from the kept block references.

The plugin currently has no keep/remove/reorder review interface.
This stage uses an explicit review artifact and a separate note.
A normal Bake button does not perform this review.

## 7. Bake and check connections

Use native block embeds. Do not copy or generate replacement passage text.
Reuse existing IDs. Add missing IDs only after checking the current source range.
Wait for Obsidian to index every referenced block before opening the note.

Check each embed against Obsidian's metadata cache and rendered view.
Check that each source has an incoming connection from the reviewed note.
Check that the origin link resolves to the query, not to the baked note itself.
Use an unambiguous path when the query and baked note share a basename.

A baked selection is fixed. Its embedded source text remains live.
The capture preserves the source text reviewed at run time.
Later source edits can change the meaning of an existing baked selection.

## 8. Record the result

Record counts, review decisions, omissions, connection checks, and known limits.
Do not call missing evidence a passing check.
Keep the capture, review, and report together.

For code changes, run these checks from `qualitative-query`:

```sh
npm run check
npm test
npm run smoke
```

Build and copy the plugin to each intended vault only after those checks pass.
Preserve vault settings, secret storage, and cache identity files.
Record whether the running plugin has reloaded the installed version.

## First completed run

The local Artistry run is stored in `docs/pipeline-runs/2026-09-19-artistry/`.
Run captures contain vault material and are excluded from the public repository.
