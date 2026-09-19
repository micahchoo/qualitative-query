# 0.3.10

Ask your vault a question. Connect the passages that answer it.

- Keep keyword-fallback warnings attached to the correct question during concurrent searches.
- Report search-model failures correctly and share model restoration across requests.
- Stop passage rendering when its view closes. Ignore errors from older renders.
- Save simultaneous questions and selections under distinct filenames without overwriting existing notes.
- Consolidate local retrieval and note creation, with regression tests for their lifecycle and collision handling.

Validation: 71 behavior tests, three packaging tests, TypeScript, and the bundled smoke check.

Requires Obsidian 1.11.4 or later. Mobile testing remains outstanding.
Jev scoring sends shortlisted passages to TypeSafe and requires an API key. API charges can apply.
