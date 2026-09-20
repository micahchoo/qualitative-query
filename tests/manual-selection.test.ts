import { expect, it } from "vitest";
import { applyInclusions, inclusionFor, updateInclusions } from "../src/manual-selection";
import { parseMarkdown } from "../src/markdown";
import type { Judgement, QueryResult, QuerySpec } from "../src/types";
const spec: QuerySpec = { question: "What matters?", folder: "Queries", criteria: { mode: "generic" }, contextPaths: [], limit: 1, threshold: .5 };
const blocks = parseMarkdown("source.md", "Automatic passage.\n\nChosen passage.");
const judgement = (index: number, score: number): Judgement => ({ candidate: { ...blocks[index], lexicalScore: 1 }, score, contribution: "other", scores: { relevant: score } });
const automatic = judgement(0, .9), below = judgement(1, .2);
const result: QueryResult = { status: "ready", selection: "jev", candidates: [], judgements: [automatic], belowThreshold: [below] };
it("persists a manual addition outside the limit without changing scores, and undoes it", async () => {
  const entry = await inclusionFor(below);
  const text = updateInclusions("# Question\n", spec, entry, true);
  const selected = await applyInclusions(text, { ...spec, threshold: .7 }, result, blocks);
  expect(selected.result.judgements).toHaveLength(2);
  expect(selected.result.judgements[1]).toMatchObject({ score: .2, manuallyIncluded: true });
  expect(selected.result.belowThreshold).toEqual([]);
  expect(selected.missing).toEqual([]);
  const undone = await applyInclusions(updateInclusions(text, spec, entry, false), spec, result, blocks);
  expect(undone.result.judgements).toEqual([automatic]);
  expect(undone.result.belowThreshold).toEqual([below]);
});
it("restores a selection outside the retrieval window and tolerates line shifts and baked IDs", async () => {
  const text = updateInclusions("", spec, await inclusionFor(below), true);
  const moved = parseMarkdown("source.md", "New first paragraph.\n\nAutomatic passage.\n\nChosen passage. ^saved-id");
  const restored = await applyInclusions(text, spec, { status: "empty", candidates: [], judgements: [] }, moved);
  expect(restored.result.status).toBe("ready");
  expect(restored.result.judgements[0].candidate.lineStart).toBe(5);
  expect(restored.result.judgements[0].manuallyIncluded).toBe(true);
});
it("flags missing or ambiguous sources, does not reuse stale text, and permits removal", async () => {
  const entry = await inclusionFor(below), text = updateInclusions("", spec, entry, true);
  for (const source of ["Changed passage.", "Chosen passage.\n\nChosen passage."]) {
    const restored = await applyInclusions(text, spec, result, parseMarkdown("source.md", source));
    expect(restored.missing).toHaveLength(1);
    expect(restored.result.judgements).toEqual([automatic]);
    expect(updateInclusions(text, spec, restored.missing[0].entry, false)).not.toContain("qualitative-query-inclusions");
  }
});
it("keeps different questions separate and rejects corrupt persistence", async () => {
  const text = updateInclusions("", spec, await inclusionFor(below), true);
  expect((await applyInclusions(text, { ...spec, question: "Another question" }, result, blocks)).result.judgements).toEqual([automatic]);
  await expect(applyInclusions("<!-- qualitative-query-inclusions: broken -->", spec, result, blocks)).rejects.toThrow("could not be read");
});
it("does not duplicate a manually included passage when it later qualifies automatically", async () => {
  const text = updateInclusions("", spec, await inclusionFor(below), true);
  const qualified = { ...below, score: .8 };
  const restored = await applyInclusions(text, spec, { ...result, judgements: [qualified], belowThreshold: [] }, blocks);
  expect(restored.result.judgements).toHaveLength(1);
  expect(restored.result.judgements[0]).toMatchObject({ score: .8, manuallyIncluded: true });
});
