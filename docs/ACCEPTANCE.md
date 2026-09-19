# Acceptance checks

These checks describe the agreed behavior. They do not record completed tests.

## First query

The query asks “What defines a conflict?” across the current vault. It has no context notes.
With Jev configured, definitions appear before qualifying conditions. Distinctions appear after conditions.
Mere mentions do not qualify. Results contain source passages, not generated prose.

## Source passages

- A paragraph remains a paragraph.
- A list item includes its parent chain and subtree.
- Tables, callouts, and fenced code remain complete containers.
- Each result displays its source and heading ancestry.
- Additional context follows source order and stops at section boundaries.
- Source navigation opens the original passage.
- Live query rendering does not insert block IDs. Baking adds missing IDs and waits for native indexing.

## Queries and context

- Query notes live in a configurable folder.
- A question works without authored criteria or context notes.
- Optional criteria change selection behavior.
- Only explicitly selected notes supply additional context.
- Outgoing links do not expand the context set.
- Query notes do not become candidates for their own results.

## Updates

- Source edits update the local index and visible results.
- Deleted passages disappear from visible results.
- Renamed notes retain working source navigation after refresh.
- Context edits invalidate judgments that used the previous context.
- Changing a question, criterion, or model invalidates the corresponding judgments.
- Stale requests cannot replace results from a newer query.

## Retrieval and scoring

- Jev is the sole qualitative scorer and requires a TypeSafe API key.
- A small downloaded embedding model runs in a background worker for candidate retrieval.
- Keyword and embedding rankings combine deterministically.
- Missing embeddings fall back to keywords with a visible notice.
- Missing credentials show local matches without qualitative labels or probability thresholds.
- No embedded decision-model runtime, GPU setup, or local inference endpoint exists.
- Only shortlisted passages, the question, and explicit context are sent to Jev.
- API failures produce an actionable message.
- Tests do not send vault content to Jev.

## Limits to measure

Evaluate both retrieval recall and Jev selection against questions from this vault.
Static embeddings can miss nuance. Tests cannot establish relevance for every query.
Measure first-index and subsequent-query responsiveness on the user's vault after restarting Obsidian.
