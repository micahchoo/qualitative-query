import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown";
import { shortlistAsync } from "../src/search";

describe("keyword candidate retrieval", () => {
  it("returns a deterministic shortlist without claiming qualitative judgement", async () => {
    const blocks = [
      ...parseMarkdown("a.md", "A conflict is a sustained disagreement between actors."),
      ...parseMarkdown("b.md", "A recipe uses flour and water."),
    ];
    const result = await shortlistAsync("What defines a conflict?", blocks, 10);
    expect(result[0].path).toBe("a.md");
    expect(result[0].lexicalScore).toBeGreaterThan(0);
    expect(await shortlistAsync("What defines a conflict?", [...blocks], 10)).toEqual(result);
  });
});

it("keeps substantive rare-term matches ahead of tiny common-word fragments", async () => {
  const blocks = [
    ...parseMarkdown("letter.md", "My experience at Ochin included coordinating a community research programme, supporting partners and documenting outcomes in this cover letter."),
    ...Array.from({ length: 20 }, (_, i) => parseMarkdown(`noise-${i}.md`, i % 2 ? "My experience." : "Cover letters.")).flat(),
  ];
  expect((await shortlistAsync("What cover letters describe my experience at Ochin?", blocks, 3))[0].path).toBe("letter.md");
});

it("does not spend the shortlist on archived copies of the same passage", async () => {
  const blocks = [
    ...parseMarkdown("one.md", "Conflict resolution requires collective discussion."),
    ...parseMarkdown("archive.md", "Conflict resolution requires collective discussion."),
    ...parseMarkdown("two.md", "A collective can resolve conflict through mediation and agreed processes."),
  ];
  const result = await shortlistAsync("How can conflict be dealt with in a collective?", blocks, 2);
  expect(new Set(result.map(block => block.text)).size).toBe(2);
});

it("fills the shortlist with archived copies once distinct passages run out", async () => {
  const blocks = [
    ...parseMarkdown("one.md", "Conflict resolution requires collective discussion."),
    ...parseMarkdown("archive.md", "Conflict resolution requires collective discussion."),
  ];
  const result = await shortlistAsync("conflict", blocks, 5);
  expect(result.map(block => block.path).sort()).toEqual(["archive.md", "one.md"]);
});
