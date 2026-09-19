# Qualitative Query

Ask your vault a question, find the passages that answer it, and turn the selection into lasting connections.

![The query builder in Obsidian, with a question field, selection preset, optional criteria, and a Save and open query button.](https://raw.githubusercontent.com/micahchoo/qualitative-query/main/docs/img/query-builder.png)

Qualitative Query selects your existing words. It does not generate answers or rewrite passages.
Saved queries stay live; baked notes keep your selection as native block embeds with backlinks.

## What it does

- **Finds passages across your vault.** Keyword search and optional local embeddings retrieve candidates at block level.
- **Selects by meaning.** Jev scores whether a passage meets your question and criteria.
- **Helps you write queries.** Choose relevant passages, definitions, distinctions, concrete practices, or evidence. Add your own criteria when needed.
- **Shows results as they arrive.** Open the source or expand nearby context without another model call.
- **Makes connections permanent.** Bake a finished selection into a separate note. The chosen blocks stay fixed; their source text stays live.

## Start with a question

1. Enable the plugin, then open its settings.
2. For semantic retrieval, select **Download / restore embeddings**. This downloads about 31 MB once.
3. For qualitative scoring, add your **TypeSafe API key**.
4. Run **Qualitative Query: Build a query** from the command palette or search icon in the ribbon.
5. Enter a question, choose a preset, and select **Save and open query**.

For example: **What is artistry?** with **Relevant passages**, or **How does solitude differ from loneliness?** with **Distinctions**.

Without a key, results are labelled **Local match**. Without the embedding download, keyword retrieval still works.

The builder saves a Markdown note in `Queries`. You can also write a query directly:

````markdown
```qualitative-query
question: How does solitude differ from loneliness?
mode: generic
instructions: Select passages that explain the distinction.
true: It contrasts solitude with loneliness or demonstrates the difference.
false: It only mentions either topic.
limit: 6
threshold: 0.5
adjacent: 0
```
````

## Bake a note

After scoring finishes, select **Bake note**. The plugin creates a new note in `Baked queries`.

Baking adds missing block IDs to source notes and waits for Obsidian to index them.
It preserves existing IDs and never overwrites an earlier baked note.
Open a source note's Backlinks pane to return to the baked selection.

The score is a selection aid, not proof of relevance. Read the passages before baking.

## Settings

| Setting | Purpose |
| --- | --- |
| Jev API key | Enables qualitative scoring; stored in Obsidian secret storage. |
| Local embeddings | Downloads or restores the pinned POTION-8M model. |
| Query folder | Holds saved queries; default `Queries`. |
| Candidate limit | Retrieval window before overlap removal; default 1,000. |
| Result limit | Maximum displayed results; builder queries specify six. |
| Relevance threshold | Minimum Jev score; builder queries specify 0.5. |
| Excluded folders | Comma-separated folders to leave out of retrieval. |

Query notes, baked notes, and the vault configuration folder are excluded automatically.

## Privacy, accounts, and costs

Jev scoring requires a [TypeSafe account and API key](https://console.typesafe.ai/login). API use may incur charges under your plan.
The plugin sends the question, candidate passages with headings, and explicitly selected context notes to `api.typesafe.ai`.
See [TypeSafe's privacy policy](https://typesafe.ai/legal/privacy-policy) for service-side data handling.

Embeddings run locally. The explicit model download contacts Hugging Face and sends no vault text or Jev key.
The worker code ships inside the plugin; no executable code is downloaded.
The plugin adds no telemetry. Its runtime reads vault files and stores scores in Obsidian's local IndexedDB storage.

## Installation and compatibility

Requires **Obsidian 1.11.4 or newer**. Community-directory submission is pending; this is not yet advertised as listed.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/micahchoo/qualitative-query/releases).
Place them in `<vault-config>/plugins/qualitative-query/`, then reload Obsidian and enable the plugin.
The configuration folder is usually `.obsidian`. The optional release ZIP includes the embedding model for offline setup.

Desktop testing covers the main query and bake flows. Mobile testing remains outstanding.

## More

- [User guide](docs/guide.md): explicit context, ordering, cache behavior, and troubleshooting.
- [Review pipeline](docs/PIPELINE.md): assess selections and check their source connections.
- [Testing status](docs/TESTING.md): completed checks and remaining manual checks.
- [Deployment](docs/DEPLOY.md): build, release, and community-directory submission.

## Development and licence

```sh
npm ci
npm run download:embeddings
npm run release:verify
```

Node.js 22 and Python 3 are required for release packaging. Tests use mocked Jev transport; no API key is required.

Code is [MIT](LICENSE). Model and tokenizer notices are in [NOTICE](NOTICE).
Your vault content retains its own rights and is not included in plugin releases.
