# Qualitative Query 0.3.7

Find source passages with saved questions, score them with Jev, and bake selections as native block embeds.

- Query builder with fixed presets and optional inclusion/exclusion criteria.
- Local keyword retrieval and optional POTION-8M embeddings.
- Progressive Jev results, adaptive concurrency, and persistent score reuse.
- Native block embeds with source backlinks and explicit query-origin links.
- Wait for Obsidian to index new block IDs before opening a baked note.
- Worker code and third-party licence notices included in main.js for standard Obsidian installs.

Requires Obsidian 1.11.4 or newer. Jev requires a TypeSafe account and API key; usage charges may apply.
The embedding model is an explicit download of about 31 MB in plugin settings.
Without a key, local matches remain available. Without embeddings, keyword retrieval remains available.

Standard assets: main.js, manifest.json, styles.css.
The optional ZIP also includes model files for offline setup.
Mobile testing remains outstanding. Community-directory acceptance is a separate review step.
