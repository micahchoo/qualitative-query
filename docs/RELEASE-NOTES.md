# 0.3.15

- Save exactly the passages shown. When nearby text is shown, a passage that an earlier widened passage already covers is not drawn; it was still written into the saved note. Rendering and **Save passages** now read one Selection. A passage you included by hand is always shown and always saved.
- A question view stays live while a save waits on Obsidian to index new block IDs. Until now a pending save held the view frozen to every vault change until **Retry save** succeeded. A change that arrives during a save is applied once the save ends.
- What identifies a cached score (scoring version, endpoint, model, batch size) is declared in one place, and the endpoint requests go to is the one cached scores are keyed by.
- Internal: the query view moved out of `main.ts` with its state as a pure module; local retrieval is a required argument of the engine, so the engine's tests run on the shipped keyword retrieval rather than a second BM25 that never shipped; that second implementation is deleted and the async ranking is measured against a captured reference.

No change to stored data, saved questions or the score cache's contents.

# 0.3.14

- Send several passages to Jev in one request. A question that shortlists 1,000 passages now costs about 100 requests instead of 1,000, and re-sends the question and any context notes once per request rather than once per passage. Set **Passages per request** to 1 to check each passage on its own.
- Batched scores are cached separately from one-per-request scores. Returning the setting to 1 restores the earlier scores unchanged.
- Report requests, input tokens and average request time under each question's result counts.
- Recover concurrency a request at a time after a rate limit, rather than one slot per 32 successes; a halved cap used to need hundreds of successes to undo.
- Spread retry delays so parallel requests that hit the same rate limit do not retry in step.

Score drift under batching is not yet measured on a real vault. `docs/BATCHING.md` states what is measured, and `npm run probe:batching` measures the rest against a pipeline capture. Broad questions still take longer as matching passages and simultaneous questions increase. Synthetic scaling checks exclude real network latency and do not establish mobile performance.

# 0.3.13

- Cancel obsolete queries and remove queued searches when their views close or refresh. Shared requests continue for remaining readers.
- Release cancelled subscribers while a shared request is still running.
- Reuse corpus statistics and retrieval results, and yield during ranking. Bound intermediate ranking work while preserving scores, ties and duplicate handling.
- Keep extension-changing renames from leaving non-Markdown files in search results.
- Handle notes with150,000 indexed passages without argument-limit crashes, and remove quadratic context overlap checks.
- Clear obsolete retrieval state on restart and unload.
- Run the official Obsidian linter during release verification. Publish only main.js, manifest.json and styles.css; offline ZIPs remain a local packaging option.

Broad questions still take longer as matching passages and simultaneous questions increase. Synthetic scaling checks exclude real network latency and do not establish mobile performance.
