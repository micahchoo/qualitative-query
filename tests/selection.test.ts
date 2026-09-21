import { describe, expect, it } from "vitest";
import { visibleSelection } from "../src/selection";
import { parseMarkdown } from "../src/markdown";
import type { Block, Judgement } from "../src/types";

const blocks = parseMarkdown("source.md", "First passage.\n\nSecond passage.\n\nThird passage.");
const judge = (block: Block, extra: Partial<Judgement> = {}): Judgement => ({ candidate: { ...block, lexicalScore: 1 }, score: 1, contribution: "other", scores: {}, ...extra });
/** Widening by one covers the whole note, so every later passage sits inside the first. */
const wholeNote = (candidate: Block): Block => ({ ...candidate, lineStart: 1, lineEnd: 5 });

describe("the Selection", () => {
  it("keeps every passage when nothing is widened", () => {
    const shown = visibleSelection(blocks.map(block => judge(block)), 0, wholeNote);
    expect(shown.map(passage => passage.block.id)).toEqual(blocks.map(block => block.id));
  });
  it("drops a passage an earlier widened one already covers", () => {
    const shown = visibleSelection(blocks.map(block => judge(block)), 1, wholeNote);
    expect(shown).toHaveLength(1);
    expect(shown[0].judgement.candidate.id).toBe(blocks[0].id);
    expect(shown[0].block.lineEnd).toBe(5);
  });
  it("never drops a manually included passage", () => {
    const shown = visibleSelection([judge(blocks[0]), judge(blocks[1], { manuallyIncluded: true }), judge(blocks[2])], 1, wholeNote);
    expect(shown.map(passage => passage.judgement.candidate.id)).toEqual([blocks[0].id, blocks[1].id]);
  });
  it("only a passage on the same note can cover another", () => {
    const other = parseMarkdown("other.md", "Elsewhere.")[0];
    const shown = visibleSelection([judge(blocks[0]), judge(other)], 1, wholeNote);
    expect(shown).toHaveLength(2);
  });
});
