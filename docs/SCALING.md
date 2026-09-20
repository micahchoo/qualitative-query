# 0.3.13 correctness and larger-workload checks

On2026-09-20,118 behavior tests and3 release tests passed, along with lint, TypeScript, the bundled real-model smoke test and package round-trip verification. Independent comparison against the original lexical implementation matched all160 randomized score/order cases.

Synthetic250k-passage/100-question bursts previously hit a1.5GB heap guard without completing a question. After compact retrieval state and completion scheduling, all100 finish in4.35s, with the first result at117ms and maximum timer gap10ms. A500k-passage/200-question burst finishes in19.1s, first result380ms, maximum gap15ms, peak heap675MB plus73MB array buffers. Retained heap falls from407MB to21MB after disposal. These measurements exclude model vectors, DOM, real storage and Obsidian.

Portable probes: `node --expose-gc scripts/probe-query-scale.cjs 500000 200`, `node --expose-gc scripts/probe-query-lifetimes.cjs`, and `node scripts/probe-query-boundaries.cjs`. See `ledgers/ROUND2-QQ.md` for the full matrix and limits.
