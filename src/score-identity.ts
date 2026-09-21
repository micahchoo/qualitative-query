import type { Block, Candidate, QueryCriteria, QuerySpec } from "./types";
import { displayText } from "./markdown";

/** Where every Jev request goes. Part of a score's identity: a score from one endpoint is not a score from another. */
export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Bump when the questions sent to Jev change shape, so old scores are not reused for new questions. */
export const SCORING_VERSION = "jev-v1";

/**
 * What makes two scores the same score, and two passages batchable into one request.
 *
 * Until 2026-09-21 this was spread over four files: the version in main.ts, the endpoint
 * written once in settings.ts for the cache and again in jev.ts for the request, the key in
 * engine.ts and a second key in batch.ts. Changing the endpoint where the request was made
 * left every cached score keyed by the other literal valid.
 */

/** The text Jev is shown for a passage: its heading path, then the passage. */
export function modelText(block: Block): string {
  const heading = block.headingPath.length ? `[Headings: ${block.headingPath.join(" > ")}]\n` : "";
  return `${heading}${displayText(block)}`;
}

/**
 * The namespace a score lives in: scoring version, endpoint, model, and the batch size when
 * passages travel together — a passage judged beside others was asked a differently shaped
 * question, so its score is reused only for that same shape.
 */
export function scoreNamespace(model: string, batchSize = 1): string {
  return `${SCORING_VERSION}:${ENDPOINT}:${model}${batchSize > 1 ? `:batch-${batchSize}` : ""}`;
}

/**
 * The persistent key of one judgement. `legacy` is the pre-keyVersion-2 shape, keyed by
 * location rather than text, read once so an old cache is promoted without rescoring.
 */
export function scoreKey(namespace: string, spec: QuerySpec, candidate: Candidate, context: string, legacy = false): string {
  const text = modelText(candidate);
  return stable({ namespace, question: spec.question, criteria: spec.criteria, context,
    ...(legacy ? { candidate: { id: candidate.id, path: candidate.path, lineStart: candidate.lineStart, lineEnd: candidate.lineEnd, headingPath: candidate.headingPath, text } }
      : { passage: text, keyVersion: 2 }) });
}

/** Passages share a request only when their question, criteria and context are identical. */
export function bucketKey(question: string, criteria: QueryCriteria, context: string): string {
  return `${question}\u0000${JSON.stringify(criteria)}\u0000${context}`;
}

/** JSON with keys in a fixed order, so equal objects make equal keys. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
