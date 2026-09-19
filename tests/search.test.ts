import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown";
import { shortlist, shortlistAsync } from "../src/search";

describe("keyword candidate retrieval", () => {
  it("returns a deterministic shortlist without claiming qualitative judgement", () => {
    const blocks = [
      ...parseMarkdown("a.md", "A conflict is a sustained disagreement between actors."),
      ...parseMarkdown("b.md", "A recipe uses flour and water."),
    ];
    const result = shortlist("What defines a conflict?", blocks, 10);
    expect(result[0].path).toBe("a.md");
    expect(result[0].lexicalScore).toBeGreaterThan(0);
  });
});

it("keeps substantive rare-term matches ahead of tiny common-word fragments", () => {
  const blocks = [
    ...parseMarkdown("letter.md", "My experience at Ochin included coordinating a community research programme, supporting partners and documenting outcomes in this cover letter."),
    ...Array.from({ length: 20 }, (_, i) => parseMarkdown(`noise-${i}.md`, i % 2 ? "My experience." : "Cover letters.")).flat(),
  ];
  expect(shortlist("What cover letters describe my experience at Ochin?", blocks, 3)[0].path).toBe("letter.md");
});

it("does not spend the shortlist on archived copies of the same passage", () => {
  const blocks = [
    ...parseMarkdown("one.md", "Conflict resolution requires collective discussion."),
    ...parseMarkdown("archive.md", "Conflict resolution requires collective discussion."),
    ...parseMarkdown("two.md", "A collective can resolve conflict through mediation and agreed processes."),
  ];
  const result = shortlist("How can conflict be dealt with in a collective?", blocks, 2);
  expect(new Set(result.map(block => block.text)).size).toBe(2);
});

it("cooperative scanning retains the same ranking as synchronous search", async () => {
  const blocks = Array.from({length:1000}, (_, i) => parseMarkdown(`${i}.md`, i % 2 ? "Conflict mediation." : "A recipe for cake.")).flat();
  expect(await shortlistAsync("conflict", blocks, 12)).toEqual(shortlist("conflict", blocks, 12));
});
