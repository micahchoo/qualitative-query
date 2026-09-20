import type { Block, Judgement, QueryResult, QuerySpec } from "./types";

interface Inclusion { path: string; fingerprint: string; score: number; contribution: Judgement["contribution"]; scores: Record<string, number> }
interface SelectionRecord { key: string; entries: Inclusion[] }
const marker = /^<!-- qualitative-query-inclusions: (.*?) -->$/gm;

/** Ignore native IDs added by Save passages, but never silently match changed prose. */
async function fingerprint(block: Block): Promise<string> {
  const text = block.text.replace(/\r\n/g, "\n").replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, "").replace(/^\^[A-Za-z0-9-]+[ \t]*$/gm, "").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function key(spec: QuerySpec): string {
  return JSON.stringify([spec.question, spec.criteria, spec.contextPaths]);
}
function records(text: string): SelectionRecord[] {
  return [...text.matchAll(marker)].map(match => {
    try {
      const value: unknown = JSON.parse(decodeURIComponent(match[1]));
      if (!value || typeof value !== "object" || !("key" in value) || typeof value.key !== "string" || !("entries" in value) || !Array.isArray(value.entries)) throw new Error();
      for (const entry of value.entries as unknown[]) {
        if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string" || !("fingerprint" in entry) || typeof entry.fingerprint !== "string" || !("score" in entry) || typeof entry.score !== "number" || !Number.isFinite(entry.score) || !("contribution" in entry) || !["definition", "condition", "distinction", "other"].includes(String(entry.contribution)) || !("scores" in entry) || !entry.scores || typeof entry.scores !== "object" || Object.values(entry.scores).some(score => typeof score !== "number" || !Number.isFinite(score))) throw new Error();
      }
      return value as SelectionRecord;
    } catch { throw new Error("Saved manual selections could not be read. Check the qualitative-query-inclusions comment in this query note."); }
  });
}
export async function inclusionFor(judgement: Judgement): Promise<Inclusion> {
  return { path: judgement.candidate.path, fingerprint: await fingerprint(judgement.candidate), score: judgement.score, contribution: judgement.contribution, scores: judgement.scores };
}
export function updateInclusions(text: string, spec: QuerySpec, entry: Inclusion, include: boolean): string {
  const all = records(text), queryKey = key(spec);
  const record = all.find(record => record.key === queryKey) ?? { key: queryKey, entries: [] };
  record.entries = record.entries.filter(value => value.path !== entry.path || value.fingerprint !== entry.fingerprint);
  if (include) record.entries.push(entry);
  const updated = [...all.filter(value => value.key !== queryKey), record].filter(value => value.entries.length);
  const base = text.replace(marker, "").trimEnd();
  return base + (updated.length ? "\n\n" + updated.map(value => `<!-- qualitative-query-inclusions: ${encodeURIComponent(JSON.stringify(value))} -->`).join("\n") : "") + "\n";
}
export interface MissingInclusion { entry: Inclusion; message: string }
export async function applyInclusions(text: string, spec: QuerySpec, result: QueryResult, blocks: Block[]): Promise<{ result: QueryResult; missing: MissingInclusion[] }> {
  const entries = records(text).find(record => record.key === key(spec))?.entries ?? [];
  const judgements = [...result.judgements], missing: MissingInclusion[] = [];
  const paths = new Set(entries.map(entry => entry.path));
  const indexed = await Promise.all(blocks.filter(block => paths.has(block.path)).map(async block => ({ block, fingerprint: await fingerprint(block) })));
  const selected = new Set<string>();
  for (const entry of entries) {
    const matches = indexed.filter(value => value.block.path === entry.path && value.fingerprint === entry.fingerprint);
    if (matches.length !== 1) { missing.push({ entry, message: `Manual inclusion unavailable: ${entry.path}. Its passage changed, disappeared, or has duplicate matches.` }); continue; }
    const block = matches[0].block;
    selected.add(block.id);
    const existing = judgements.findIndex(value => value.candidate.id === block.id);
    const current = judgements[existing] ?? result.belowThreshold?.find(value => value.candidate.id === block.id);
    const value: Judgement = { ...(current ?? entry), candidate: { ...block, lexicalScore: 0 }, manuallyIncluded: true };
    if (existing >= 0) judgements[existing] = value; else judgements.push(value);
  }
  return { result: { ...result, judgements, belowThreshold: result.belowThreshold?.filter(value => !selected.has(value.candidate.id)), status: judgements.length && result.status === "empty" ? "ready" : result.status }, missing };
}
