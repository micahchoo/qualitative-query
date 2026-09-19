# Release and submit Qualitative Query

Target repository: `micahchoo/qualitative-query`.
Publish the contents of the `qualitative-query` directory as the repository root.
Do not publish the surrounding workspace, vaults, or local review captures.

## Release layout

Obsidian downloads `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release.
The worker code and licence notices are included in `main.js`.
Embedding weights are optional data, downloaded explicitly through settings with pinned hashes.
The plugin does not download executable dependencies or update itself.

The release also provides an offline ZIP, `INSTALLATION.json`, and `SHA256SUMS`.
The ZIP contains all distribution files, including model assets and separate licence notices.

[Obsidian submission instructions](https://docs.obsidian.md/plugins/releasing/submit-plugin) describe the current installer and directory process.

## 1. Prepare the source repository

Keep `README.md`, `LICENSE`, `NOTICE`, `manifest.json`, `versions.json`, and the lock file at the repository root.
Keep `.github/workflows` at that same root.
Use the public repository named above for README image URLs.

The local `.gitignore` excludes vault-derived reports, cached settings, build output, and model weights.
Check the staged file list before pushing.
Do not include API keys, `data.json`, score caches, or copied vault notes.

## 2. Choose a version

Update the version in these files:

- `manifest.json`
- `package.json`
- `package-lock.json`, including its root package entry

Add the matching `minAppVersion` entry to `versions.json`.
Preserve existing compatibility entries.
Update `docs/RELEASE-NOTES.md` for the same version.
Use a bare version tag, such as `0.3.8`, without a `v` prefix.

The current minimum is 1.11.4 because the plugin uses Obsidian secret storage introduced in that version.
Mobile testing remains outstanding. Do not describe mobile behavior as tested.

## 3. Run the release gates

Use Node.js 22 and Python 3.
Run from the plugin repository root:

```sh
npm ci
npm audit --audit-level=moderate
npm run download:embeddings
npm run release:verify
```

The download checks pinned model hashes.
The release gates run TypeScript, behavior tests, packaging tests, the production build, and the bundled smoke test.
The smoke test executes the embedded worker with real model weights and mocked Jev transport.
It does not require an API key.

The package check rejects missing files, unexpected files, modified weights, and inconsistent versions.
The packager opens its ZIP and compares every file against the build.
It writes assets under `release/`.

Check the intended tag before publishing:

```sh
npm run release:check -- 0.3.8
```

For a clean-build check, repeat the build and compare `release/SHA256SUMS`.
That local check does not establish reproducibility on every operating system.

## 4. Check a store-shaped installation

Use a disposable vault or an isolated plugin installation.
Copy only `release/main.js`, `release/manifest.json`, and `release/styles.css`.

Check these paths:

1. Enable the plugin without a key or model files.
2. Open the builder and save a query.
3. Check that keyword-only results appear without a network request.
4. Download embeddings through settings.
5. Check that local semantic retrieval works without a separate worker file.
6. Add a Jev key and check scoring.
7. Bake a selection and check embeds, query origin, and source backlinks.
8. Restart and check score reuse.

Do not put a real API key in a test fixture, screenshot, or release artifact.
Use a separate manual check for mobile before claiming mobile support is tested.

## 5. Publish source and tag

Publishing changes an external repository. Run this step only when the owner requests publication.
The commands assume the plugin is the repository root and `origin` is the intended public repository.

```sh
git remote get-url origin
git status --short
git diff --cached --stat
```

Commit the reviewed source and documentation together.
Then publish the branch and matching tag:

```sh
git push origin main
git tag 0.3.8
git push origin 0.3.8
```

Keep README claims aligned with the version people can install.
The current docs state that community-directory submission is pending.

## 6. Check the release workflow

`.github/workflows/release.yml` runs on version tags.
It installs locked dependencies, downloads pinned data, runs the gates, and checks the tag against the manifest.
It attests the standard assets, offline ZIP, installation inventory, and checksums.
Only then does it publish the release.

```sh
gh run watch --repo micahchoo/qualitative-query
gh release view 0.3.8 --repo micahchoo/qualitative-query
gh release download 0.3.8 --repo micahchoo/qualitative-query --dir /tmp/qualitative-query-release
cd /tmp/qualitative-query-release
sha256sum -c SHA256SUMS
gh attestation verify main.js --repo micahchoo/qualitative-query
```

Do not replace the workflow with a hand-built release.
If the workflow fails, correct the cause before publishing another version.
A local build does not prove the remote workflow completed.

## 7. Submit to the community directory

The current official process uses [community.obsidian.md](https://community.obsidian.md).
Sign in with the owner's Obsidian account and link the GitHub account.
Add `micahchoo/qualitative-query` as a plugin after the public source and matching release exist.

The directory checks the default branch's manifest.
Check the plugin ID for availability during submission.
Resolve automated-review findings before describing the plugin as accepted or installable from the store.
For a code correction, publish a new version and matching release.

References checked during preparation:

- [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submit a plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)

Repository preparation does not sign in, submit, or obtain approval on the owner's behalf.
