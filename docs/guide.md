# User guide

Qualitative Query assembles source passages under saved questions.
Jev selects passages. The plugin does not generate a written answer.

## Build a query

Run **Qualitative Query: Build a query** from the command palette or ribbon.
Enter a question, then choose a selection preset.
Each preset supplies fixed instructions and inclusion/exclusion criteria.
The builder does not ask a model to write the rubric.

Under **Refine selection**, you can replace either criterion.
For example, ask for experiences that changed a practice and exclude advice without a described experience.

Select **Save and open query**.
The new note opens in Reading view and starts retrieval.
With Jev configured, uncached passages are sent for scoring.
Saving a second query with the same title creates a separate note.

Builder defaults are six results, threshold 0.5, no context notes, and no adjacent expansion.
The retrieval window comes from plugin settings, initially 1,000 candidates.

## Edit the Markdown

A saved query contains a `qualitative-query` code block.
You can edit the fields directly or put a query block in another note.
For an automatic query in the query folder, the filename supplies the question when no explicit question exists.

| Field | Meaning |
| --- | --- |
| `question` | The question to answer with source passages |
| `mode: generic` | Score relevance against the supplied or default rubric |
| `mode: default` | Score definitions, conditions, and distinctions |
| `instructions` | The judgement to make about each passage |
| `true` | What qualifies |
| `false` | What does not qualify |
| `limit` | Number of results to display |
| `threshold` | Minimum Jev score from zero to one |
| `adjacent` | Number of neighbouring structural units to include, from zero to five |
| `context` | Explicit context-note links |

With no explicit mode or authored rubric, questions such as “What defines conflict?” use definition ordering.
Builder presets explicitly use generic mode, including the Definitions preset.
Generic mode sorts by score. Default mode sorts definitions, conditions, then distinctions, with scores inside each group.

## Give context explicitly

```text
context: "[[Projects/Workshop]]"
```

Context changes how Jev interprets the question. It does not restrict retrieval to that note.
The plugin does not follow outgoing links from context notes.
Only add context you intend to send to Jev.

## Understand retrieval and scoring

The local index preserves paragraphs, list structure, quotations, callouts, tables, and code fences.
POTION-8M provides static token embeddings in a background worker.
Keyword ranking and embedding ranking combine into a candidate window.
Exact duplicate text is deprioritized. Overlapping blocks are removed before scoring.

The default window contains at most 1,000 blocks before overlap removal.
This is not exhaustive classification of every vault block.
Useful passages outside the window cannot be selected by Jev.
Passing the threshold does not guarantee display: the result limit still applies.

Up to 16 requests run concurrently per plugin instance.
Throttling reduces concurrency; successful requests gradually restore it.
Partial results can change while scoring continues. Bake becomes available after the run completes.

**Expand context** adds nearby units in source order, within the current section.
Expansion uses source structure and does not make another model call.
Source links open the original note at the passage.

## Bake a selection

Select **Bake note** after scoring completes.
The plugin writes a new note in `Baked queries` with the selected blocks in their current order.
The query remains live. The baked selection does not change with later query results.

Native embeds keep source text live and create backlinks to the baked note.
Baking reuses existing block IDs and adds missing IDs to source Markdown.
The plugin checks source ranges, then waits for Obsidian to index the IDs.
The link back to the query uses its full path to avoid same-name ambiguity.

Expanded neighbours are not baked.
A nested list embed targets the source item, not the plugin's assembled ancestor display.
Headings and frontmatter cannot be baked as exact passage embeds.
The plugin rejects stale selections instead of editing a different passage.

A repeated bake creates a new note. It does not overwrite your earlier selection.
Changes to several source files cannot be atomic together.
If a later file changes during baking, already-added IDs remain and are safe to keep.

Review before baking. The plugin has no keep/remove/reorder review interface yet.
Use the [review pipeline](PIPELINE.md) for an auditable manual review.

## Cache and refresh

Open query views refresh after source edits. Closed queries evaluate when opened.
Scores persist in a vault-specific IndexedDB database with a ceiling of one million entries.
The ceiling does not reserve disk space upfront.

The cache stores hashed keys and scores, not passage text.
Keys include the question, rubric, explicit context, passage with headings, and provider/model identity.
Matching content can reuse a score after a move or across duplicate locations.
Legacy location-based entries are promoted when encountered.

Cache data lives in local Obsidian application storage, not in vault sync.
The vault's `score-cache-id.json` identifies the database.
Embedding files can sync with the plugin folder; in-memory passage vectors rebuild after restart.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Results say Local match | Add a Jev key for qualitative scoring. |
| Embeddings unavailable | Use Download / restore embeddings; keyword retrieval remains available. |
| No passages qualify | Read the criteria and threshold; this does not prove the vault lacks useful material. |
| Scoring is slow | Start with one open query; new candidates need API calls. Cached scores reuse earlier work. |
| Source changed during baking | Refresh the query, then bake again. |
| Obsidian is still indexing IDs | Wait briefly, refresh, and retry. No broken baked note is created on timeout. |
| Missing block in an older bake | Check whether the source or ID was removed. Reopen after indexing completes. |
| Unexpected source attribution | Read the surrounding source; the note title does not identify every passage's speaker. |

## Data and costs

A configured Jev key enables requests to `https://api.typesafe.ai/v1/systemone`.
The request includes the question, passage with headings, rubric, and explicit context.
TypeSafe account terms and API charges apply.
See [TypeSafe's privacy policy](https://typesafe.ai/legal/privacy-policy).

The optional embedding download requests a pinned model revision from Hugging Face.
Each downloaded data file must match its expected size and SHA-256 hash.
No executable code is downloaded. The worker ships in `main.js`.
The runtime uses vault APIs and local application storage; it does not read arbitrary files outside the vault.
