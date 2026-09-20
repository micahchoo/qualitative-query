import { cooperative } from "./cooperative";
import { TopK } from "./top-k";
import { checkSignal, SharedWork } from "./work";
import type { Block, Candidate } from "./types";

const stopWords = new Set("the a an and or to of in on for is are was were what how why with from this that does do define defines can could would should be been being my your our their at it its".split(" "));

interface SearchMetadata { terms: Uint32Array; length: number; fingerprint?: string; }
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
    const counts = new Map<number, number>();
    for (const token of hashes) counts.set(token, (counts.get(token) ?? 0) + 1);
    const terms = new Uint32Array(counts.size * 2);
    let offset = 0;
    for (const [token, count] of counts) { terms[offset++] = token; terms[offset++] = count; }
    metadata.set(block, { terms, length: hashes.length });
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
    for (let i = 0; i < info.terms.length; i += 2) if (querySet.has(info.terms[i])) counts.set(info.terms[i], info.terms[i + 1]);
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

interface SearchCorpus {
  documents: number;
  totalLength: number;
  blocks: Block[];
  postings: Map<number, number | Uint32Array>;
  byId: Map<string, Block>;
  duplicateGroup: Uint32Array;
  duplicateGroups: number;
}
interface CorpusState { value?: SearchCorpus; work?: SharedWork<SearchCorpus> }
const corpora = new WeakMap<Block[], CorpusState>();

function* buildCorpus(blocks: Block[]): Generator<void, SearchCorpus> {
  const corpus: SearchCorpus = { documents: blocks.length, totalLength: 0, blocks, postings: new Map(), byId: new Map(), duplicateGroup: new Uint32Array(blocks.length), duplicateGroups: 0 };
  const postings = new Map<number, number | number[]>();
  const firstText = new Map<string, number>();
  let operations = 0, index = 0;
  for (const block of blocks) {
    prepareSearchBlock(block);
    const info = metadata.get(block)!;
    corpus.totalLength += info.length;
    corpus.byId.set(block.id, block);
    const text = info.fingerprint ??= block.text.replace(/\s+/g, " ").trim();
    const first = firstText.get(text);
    if (first === undefined) firstText.set(text, index);
    else {
      const group = corpus.duplicateGroup[first] || ++corpus.duplicateGroups;
      corpus.duplicateGroup[first] = group;
      corpus.duplicateGroup[index] = group;
    }
    for (let i = 0; i < info.terms.length; i += 2) {
      const token = info.terms[i];
      const posting = postings.get(token);
      if (posting === undefined) postings.set(token, index);
      else if (typeof posting === "number") postings.set(token, [posting, index]);
      else posting.push(index);
      if (++operations % 128 === 0) yield;
    }
    index++;
    if (++operations % 128 === 0) yield;
  }
  // Retain compact document ordinals, not a Map entry/object for every posting.
  for (const [token, values] of postings) {
    corpus.postings.set(token, typeof values === "number" ? values : Uint32Array.from(values));
    postings.delete(token);
    if (++operations % 128 === 0) yield;
  }
  return corpus;
}

async function searchCorpus(blocks: Block[], signal?: AbortSignal): Promise<SearchCorpus> {
  checkSignal(signal);
  let state = corpora.get(blocks);
  if (!state) { state = {}; corpora.set(blocks, state); }
  if (state.value) return state.value;
  const shared = state;
  if (!shared.work) {
    const work = new SharedWork(async ownedSignal => {
    const value = await cooperative(buildCorpus(blocks), ownedSignal);
    shared.value = value;
    return value;
  }, () => { if (shared.work === work) shared.work = undefined; });
    shared.work = work;
  }
  return shared.work.join(signal);
}

interface Scored { block: Block; score: number }
const compareScored = (a: Scored, b: Scored) => b.score - a.score || a.block.id.localeCompare(b.block.id);

function retain(heap: TopK<Scored>, block: Block, score: number): void {
  const cutoff = heap.cutoff;
  // Avoid allocating a Scored object for the overwhelming majority of matches.
  if (!cutoff || score > cutoff.score || (score === cutoff.score && block.id.localeCompare(cutoff.block.id) < 0)) heap.add({ block, score });
}

function* rankedMatches(question: string, corpus: SearchCorpus, limit: number): Generator<void, Candidate[]> {
  const terms = new Set(queryHashes(question));
  if (!terms.size) return [];
  const frequencies = new Map<number, number>();
  for (const term of terms) {
    const posting = corpus.postings.get(term);
    if (posting !== undefined) {
      const length = typeof posting === "number" ? 1 : posting.length;
      frequencies.set(term, Math.log(1 + (corpus.documents - length + 0.5) / (length + 0.5)));
    }
  }
  const average = Math.max(1, corpus.totalLength / Math.max(1, corpus.documents));
  const count = Math.max(1, limit);
  const distinct = new TopK<Scored>(count, compareScored), duplicates = new TopK<Scored>(count, compareScored);
  const visited = new Uint8Array(corpus.documents);
  const representatives = new Uint32Array(corpus.duplicateGroups + 1);
  const groupScores = new Float64Array(corpus.duplicateGroups + 1);
  let operations = 0;
  for (const term of terms) {
    const posting = corpus.postings.get(term);
    if (posting === undefined) continue;
    for (const index of typeof posting === "number" ? [posting] : posting) {
      if (++operations % 128 === 0) yield;
      if (visited[index]) continue;
      visited[index] = 1;
      const block = corpus.blocks[index], info = metadata.get(block)!;
      let score = 0, matched = 0;
      // Original document token order preserves even floating-point tie behavior.
      for (let i = 0; i < info.terms.length; i += 2) {
        const idf = frequencies.get(info.terms[i]);
        if (idf !== undefined) {
          const occurrences = info.terms[i + 1];
          score += idf * (occurrences * 2.2) / (occurrences + 1.2 * (0.75 + 0.25 * info.length / average));
          matched++;
        }
        if (++operations % 128 === 0) yield;
      }
      score *= 1 + Math.log(matched);
      const group = corpus.duplicateGroup[index];
      if (!group) { retain(distinct, block, score); continue; }
      const previous = representatives[group];
      const previousBlock = previous ? corpus.blocks[previous - 1] : undefined;
      if (!previousBlock || score > groupScores[group] || (score === groupScores[group] && block.id.localeCompare(previousBlock.id) < 0)) {
        if (previousBlock) retain(duplicates, previousBlock, groupScores[group]);
        representatives[group] = index + 1;
        groupScores[group] = score;
      } else retain(duplicates, block, score);
    }
  }
  for (let group = 1; group <= corpus.duplicateGroups; group++) {
    if (representatives[group]) retain(distinct, corpus.blocks[representatives[group] - 1], groupScores[group]);
    if (++operations % 128 === 0) yield;
  }
  return [...distinct.sorted(), ...duplicates.sorted()].slice(0, count).map(value => ({ ...value.block, lexicalScore: value.score }));
}

/** Reuse corpus statistics/postings and share one cooperative budget across views. */
export async function shortlistAsync(question: string, blocks: Block[], limit: number, signal?: AbortSignal): Promise<Candidate[]> {
  const corpus = await searchCorpus(blocks, signal);
  return cooperative(rankedMatches(question, corpus, limit), signal);
}

/** Reuse the corpus lookup rather than allocating one full-vault map per query. */
export async function hybridShortlistAsync(question: string, blocks: Block[], semantic: Array<{ id: string; score: number }>, limit: number, keywords: Candidate[], signal?: AbortSignal): Promise<Candidate[]> {
  const corpus = await searchCorpus(blocks, signal);
  checkSignal(signal);
  return cooperative(fuseShortlist(question, blocks, semantic, limit, keywords, corpus.byId), signal, true);
}

/** Weighted reciprocal-rank fusion keeps lexical and cosine scales separate. */
export function hybridShortlist(question: string, blocks: Block[], semantic: Array<{ id: string; score: number }>, limit: number, keywords?: Candidate[]): Candidate[] {
  const work = fuseShortlist(question, blocks, semantic, limit, keywords);
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}

function* fuseShortlist(question: string, blocks: Block[], semantic: Array<{ id: string; score: number }>, limit: number, keywords?: Candidate[], lookup?: Map<string, Block>): Generator<void, Candidate[]> {
  const pool = Math.max(limit * 4, 32);
  const lexical = keywords ?? shortlist(question, blocks, pool);
  const byId = lookup ?? new Map(blocks.map(block => [block.id, block]));
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
  yield;
  const ranked = [...candidates.values()].sort((a, b) => b.retrievalScore! - a.retrievalScore! || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const unique: Candidate[] = [], copies: Candidate[] = [];
  let visited = 0;
  for (const candidate of ranked) {
    if (++visited % 128 === 0) yield;
    const key = candidate.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) copies.push(candidate); else { seen.add(key); unique.push(candidate); }
  }
  return [...unique, ...copies].slice(0, Math.max(1, limit));
}
