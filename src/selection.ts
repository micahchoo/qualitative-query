import type { Block, Candidate, Judgement } from "./types";

/** Widen a passage to its neighbours; `adjacent` is how many on each side. */
export type Expansion = (candidate: Candidate, adjacent: number) => Block;

/** One passage of the Selection as the reader sees it: the judgement, and the block drawn for it. */
export interface ShownPassage { judgement: Judgement; block: Block }

/**
 * The Selection: the ordered passages after inclusions, with a passage dropped when an
 * earlier one on the same note already covers its range once both are widened.
 *
 * Rendering and saving both read this, so a Saved selection holds exactly what was shown.
 * Until 2026-09-21 rendering applied the rule and saving did not, so a saved note could
 * embed a passage the reader never saw. A manually included passage is never dropped:
 * the reader asked for it by name.
 */
export function visibleSelection(judgements: readonly Judgement[], adjacent: number, expand?: Expansion): ShownPassage[] {
  const shown: ShownPassage[] = [];
  for (const judgement of judgements) {
    const original = judgement.candidate;
    const block = adjacent && expand ? expand(original, adjacent) : original;
    const covered = shown.some(({ block: earlier }) => earlier.path === block.path && earlier.lineStart <= block.lineStart && earlier.lineEnd >= block.lineEnd);
    if (covered && !judgement.manuallyIncluded) continue;
    shown.push({ judgement, block });
  }
  return shown;
}
