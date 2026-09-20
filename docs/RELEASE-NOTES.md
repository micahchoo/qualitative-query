# 0.3.12

- Inspect below-threshold passages and include them manually. Choices persist in the query note, support undo, and join saved selections without displacing automatic results.
- Flag manual inclusions when their source changes or disappears.
- Show retrieval-window saturation, overlap removal, and scoring counts for cached work, shared work, requests, retries, and skipped passages.
- Clarify that local matches do not use the Jev score threshold.
- Select explicit context sections or blocks and see the context size.
- Retry saving while Obsidian indexes source links, with a visible timeout and no repeated source edits. Overlap errors identify the conflicting ranges.
- Restart local embeddings without downloading the model again.
- Validate structured query fields while preserving multiline prose questions.

Requires Obsidian 1.11.4 or later. Mobile testing remains outstanding.
Jev scoring sends shortlisted passages to TypeSafe and requires an API key. API charges can apply.
