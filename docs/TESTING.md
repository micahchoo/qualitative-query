# Testing status

Release candidate: **0.3.7**. Checks performed on 2026-09-19.

## Automated checks

The local release checks passed on Linux with Node.js 24.14.0.
GitHub workflows specify Node.js 22. The remote workflows have not run yet.

- TypeScript: no errors.
- Behavior tests: 60 passed across 10 files.
- Release tests: three passed, including rejected versions, missing assets, corrupted weights, and unexpected files.
- Dependency audit: zero known vulnerabilities in the locked dependencies at the time of the check.
- Bundled smoke test: startup, local fallback, mocked Jev scoring, source refresh, settings migration, and unload passed.
- Embedded worker: the code from `main.js` loaded real model weights and retrieved the expected passage.
- Package check: all 14 distribution files passed the allowlist and pinned model hash checks.
- ZIP check: every extracted file matched the distribution file.

A separate source copy passed the release checks with freshly installed dependencies.
Its release checksums matched the workspace build.

The embedding download tests cover valid pinned data and rejected corrupted data.
The smoke test uses mocked Jev transport and a JavaScript worker harness.
It does not replace an Obsidian check of browser workers, network access, or account credentials.

## Manual desktop evidence

Earlier development checks covered query rendering, baking, block embeds, source backlinks, and the query origin link in Obsidian.
The README screenshot shows the actual query builder.
These checks do not establish a fresh community-store installation of version 0.3.7.

## Before submission

Run the eight installation checks in [Deployment](DEPLOY.md#4-check-a-store-shaped-installation) using only the three standard release files.
Check mobile behavior separately before making a tested mobile-support claim.

After publication, check the GitHub workflow, downloaded release checksums, and build attestation.
Community-directory review and acceptance remain separate steps.
