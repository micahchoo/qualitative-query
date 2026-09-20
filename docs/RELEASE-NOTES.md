# 0.3.13

- Cancel obsolete queries and remove queued searches when their views close or refresh. Shared requests continue for remaining readers.
- Release cancelled subscribers while a shared request is still running.
- Reuse corpus statistics and retrieval results, and yield during ranking. Bound intermediate ranking work while preserving scores, ties and duplicate handling.
- Keep extension-changing renames from leaving non-Markdown files in search results.
- Handle notes with150,000 indexed passages without argument-limit crashes, and remove quadratic context overlap checks.
- Clear obsolete retrieval state on restart and unload.
- Run the official Obsidian linter during release verification. Publish only main.js, manifest.json and styles.css; offline ZIPs remain a local packaging option.

Broad questions still take longer as matching passages and simultaneous questions increase. Synthetic scaling checks exclude real network latency and do not establish mobile performance.
