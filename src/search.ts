import type { Block, Candidate } from "./types";

const stopWords = new Set("the a an and or to of in on for is are was were what how why with from this that does do define defines can could would should be been being my your our their at it its".split(" "));

interface SearchMetadata { hashes: Uint32Array; length: number; }
const metadata = new WeakMap<Block, SearchMetadata>();

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0)!;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function collectHashes(value: string): Uint32Array {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const result: number[] = [];
  for (const word of normalized.split(/\s+/)) {
    if (word && !stopWords.has(word)) result.push(hash(word));
  }
  return Uint32Array.from(result);
}

function queryHashes(value: string): Uint32Array { return collectHashes(value); }

/** Prepare one block while it is being indexed, instead of during a query. */
export function prepareSearchBlock(block: Block): void {
  if (!metadata.has(block)) {
    const hashes = collectHashes(block.searchText || block.text);
    metadata.set(block, { hashes, length: hashes.length });
  }
}

export function prepareSearchBlocks(blocks: readonly Block[]): void {
  for (const block of blocks) prepareSearchBlock(block);
}

/** Small, deterministic lexical shortlist. It is not a qualitative judgement. */
function* scanShortlist(question: string, blocks: Block[], limit: number, scope?: Set<string>): Generator<void, Candidate[]> {
  const query = queryHashes(question);
  if (!query.length) return [];
  const querySet = new Set(query);
  const frequencies = new Map<number, number>();
  const matches: Array<{ block: Block; counts: Map<number, number>; length: number }> = [];
  let documents = 0;
  let totalLength = 0;
  let scanned = 0;
  for (const block of blocks) {
    if (++scanned % 256 === 0) yield;
    if (scope && !scope.has(block.path)) continue;
    prepareSearchBlock(block);
    const info = metadata.get(block)!;
    documents++;
    totalLength += info.length;
    const counts = new Map<number, number>();
    for (const token of info.hashes) if (querySet.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const token of counts.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    if (counts.size) matches.push({ block, counts, length: info.length });
  }
  // BM25: rare query terms matter, and length normalization is bounded.
  const averageLength = Math.max(1, totalLength / Math.max(1, documents));
  const scored: Candidate[] = [];
  for (const { block, counts, length } of matches) {
    if (++scanned % 256 === 0) yield;
    let score = 0;
    for (const [token, count] of counts) {
      const frequency = frequencies.get(token)!;
      const idf = Math.log(1 + (documents - frequency + 0.5) / (frequency + 0.5));
      score += idf * (count * 2.2) / (count + 1.2 * (0.75 + 0.25 * length / averageLength));
    }
    scored.push({ ...block, lexicalScore: score * (1 + Math.log(counts.size)) });
  }
  scored.sort((a, b) => b.lexicalScore - a.lexicalScore || a.id.localeCompare(b.id));
  // Prefer distinct text before spending scarce model calls on archived copies.
  // Retain duplicate locations if there are not enough distinct candidates.
  const seen = new Set<string>();
  const distinct: Candidate[] = [];
  const duplicates: Candidate[] = [];
  for (const candidate of scored) {
    const fingerprint = candidate.text.replace(/\s+/g, " ").trim();
    if (seen.has(fingerprint)) duplicates.push(candidate);
    else { seen.add(fingerprint); distinct.push(candidate); }
  }
  return [...distinct, ...duplicates].slice(0, Math.max(1, limit));
}


export function shortlist(question: string, blocks: Block[], limit: number, scope?: Set<string>): Candidate[] {
  const work = scanShortlist(question, blocks, limit, scope);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Yield the renderer periodically while scanning a large vault. */
export async function shortlistAsync(question: string, blocks: Block[], limit: number): Promise<Candidate[]> {
  const work = scanShortlist(question, blocks, limit);
  let sliceStart = performance.now();
  let step = work.next();
  while (!step.done) {
    if (performance.now() - sliceStart >= 6) { await new Promise(resolve => window.setTimeout(resolve, 0)); sliceStart = performance.now(); }
    step = work.next();
  }
  return step.value;
}

/** Weighted reciprocal-rank fusion keeps lexical and cosine scales separate. */
export function hybridShortlist(question: string, blocks: Block[], semantic: Array<{ id: string; score: number }>, limit: number, keywords?: Candidate[]): Candidate[] {
  const pool = Math.max(limit * 4, 32);
  const lexical = keywords ?? shortlist(question, blocks, pool);
  const byId = new Map(blocks.map(block => [block.id, block]));
  const candidates = new Map<string, Candidate>();
  lexical.forEach((candidate, rank) => candidates.set(candidate.id, { ...candidate, retrievalScore: 0.65 / (60 + rank + 1) }));
  semantic.forEach((hit, rank) => {
    const block = byId.get(hit.id);
    if (!block || !Number.isFinite(hit.score) || hit.score < 0.15) return;
    const candidate = candidates.get(hit.id) ?? { ...block, lexicalScore: 0, retrievalScore: 0 };
    candidate.retrievalScore! += 0.35 / (60 + rank + 1);
    candidate.semanticScore = hit.score;
    candidates.set(hit.id, candidate);
  });
  const ranked = [...candidates.values()].sort((a, b) => b.retrievalScore! - a.retrievalScore! || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const unique: Candidate[] = [], copies: Candidate[] = [];
  for (const candidate of ranked) {
    const key = candidate.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) copies.push(candidate); else { seen.add(key); unique.push(candidate); }
  }
  return [...unique, ...copies].slice(0, Math.max(1, limit));
}
