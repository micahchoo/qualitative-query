import { checkSignal } from "./work";
import { requestUrl } from "obsidian";
import { ENDPOINT } from "./score-identity";
import type { JevResponse, QueryCriteria } from "./types";

export interface JevTransport { post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown }> }
export interface JevPassage { id: string; text: string }
export interface RequestReport { requests: number; passages: number; inputTokens: number; elapsedMs: number }
/** Per-caller notices. `onRequest` reports one completed HTTP request, not one passage. */
export interface RankHooks { onThrottle?: () => void; onRetry?: () => void; onRequest?: (report: RequestReport) => void }
const defaultTransport: JevTransport = { post: async (url, headers, body) => { const response = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false }); return { status: response.status, json: response.json }; } };

/**
 * Named questions for one passage. Ids are local; TypeSafe does not send them to the model.
 * `field` points the question at one passage inside a batched state, the way the API reference
 * and jev.directory's Jev Review point a question at one field. Undefined for a lone passage,
 * whose state carries nothing else to confuse it with.
 */
function questionsFor(question: string, criteria: QueryCriteria, field?: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  const ask = (text: string): string | Record<string, string> => field ? { question: text, inspect: field } : text;
  if (criteria.mode === "generic") {
    questions.relevant = { type: "noul", instructions: ask(criteria.instructions ?? `Does this passage answer the question: “${question}”?`), criteria: { true: criteria.true ?? "The passage directly addresses the question with substantive content.", false: criteria.false ?? "The passage only mentions the topic or is unrelated." } };
  } else {
    questions.definition = { type: "noul", instructions: ask(`For the question “${question}”, does this passage directly define the subject?`), criteria: { true: "It states what the subject is or means, rather than merely mentioning it.", false: "It mentions, illustrates, or uses the subject without defining it." } };
    questions.condition = { type: "noul", instructions: ask(`For the question “${question}”, does this passage state a condition that makes the subject apply?`), criteria: { true: "It states a qualifying condition, test, boundary, or necessary feature.", false: "It does not give a condition or boundary for the subject." } };
    questions.distinction = { type: "noul", instructions: ask(`For the question “${question}”, does this passage distinguish the subject from a related concept?`), criteria: { true: "It contrasts, separates, or clarifies the subject against another concept.", false: "It does not distinguish the subject from a related concept." } };
    questions.contribution = { type: "choice", instructions: ask(`Which contribution does this passage make toward answering “${question}”?`), criteria: { definition: "Directly defines the subject.", condition: "States qualifying conditions, tests, or boundaries.", distinction: "Distinguishes the subject from related concepts.", other: "None of those; it is another kind of relevant contribution." } };
  }
  return questions;
}

/** What the engine asks of a client: one passage judged, and how many travel together. */
export type JevRanker = Pick<JevClient, "rank"> & { batchSize?: number };

export class JevClient {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly transport: JevTransport = defaultTransport, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))) {}

  async rank(question: string, candidate: string, criteria: QueryCriteria, context = "", hooks: RankHooks = {}, signal?: AbortSignal): Promise<JevResponse> {
    const answers = await this.rankMany(question, [{ id: "p0", text: candidate }], criteria, context, hooks, signal);
    const response = answers.get("p0");
    if (!response) throw new Error("Jev returned no answers for the passage.");
    return response;
  }

  /**
   * Score several passages in one request. The question and the context notes are the part of
   * the state every passage shares, so N passages in one request pay for them once instead of
   * N times. One passage keeps the single-passage body exactly, so a cached score stays reachable.
   */
  async rankMany(question: string, passages: JevPassage[], criteria: QueryCriteria, context = "", hooks: RankHooks = {}, signal?: AbortSignal): Promise<Map<string, JevResponse>> {
    if (!passages.length) return new Map();
    const lone = passages.length === 1 ? passages[0] : undefined;
    const body = lone
      ? { model: this.model, state: { question, candidate_passage: lone.text, context_notes: context }, questions: questionsFor(question, criteria) }
      : {
        model: this.model,
        state: { question, context_notes: context, passages: Object.fromEntries(passages.map(passage => [passage.id, passage.text])) },
        questions: Object.fromEntries(passages.flatMap(passage => Object.entries(questionsFor(question, criteria, `passages.${passage.id}`)).map(([id, value]) => [`${passage.id}.${id}`, value]))),
      };
    const response = await this.send(body, hooks, signal);
    hooks.onRequest?.({ requests: 1, passages: passages.length, inputTokens: response.usage?.input_tokens ?? 0, elapsedMs: response.elapsedMs });
    if (lone) return new Map([[lone.id, response.json]]);
    const answers = response.json?.answers;
    if (!answers || typeof answers !== "object") throw new Error("The decision model returned an invalid response: answers are missing.");
    const byPassage = new Map<string, JevResponse>(passages.map(passage => [passage.id, { answers: {} }]));
    for (const [id, answer] of Object.entries(answers)) {
      const split = id.indexOf(".");
      const target = split > 0 ? byPassage.get(id.slice(0, split)) : undefined;
      if (target) target.answers[id.slice(split + 1)] = answer;
    }
    return byPassage;
  }

  /** One request, including its own rate-limit retries. Callers own batching and concurrency. */
  private async send(body: unknown, hooks: RankHooks, signal?: AbortSignal): Promise<{ json: JevResponse; usage?: { input_tokens?: number }; elapsedMs: number }> {
    checkSignal(signal);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey.trim()) headers.Authorization = `Bearer ${this.apiKey}`;
    else throw new Error("TypeSafe API key is not configured.");
    const started = performance.now();
    let attempt = 0;
    while (true) {
      checkSignal(signal);
      const response = await this.transport.post(ENDPOINT, headers, body, signal);
      checkSignal(signal);
      if (response.status >= 200 && response.status < 300) {
        const json = response.json as JevResponse;
        return { json, usage: json?.usage, elapsedMs: performance.now() - started };
      }
      if (response.status === 429 || response.status === 529) hooks.onThrottle?.();
      // Full backoff would land every parallel request on the same instant; spread the retries.
      if ((response.status === 429 || response.status === 529) && attempt < 3) { hooks.onRetry?.(); const delay = 250 * 2 ** attempt; await this.sleep(delay / 2 + Math.random() * delay / 2); attempt++; continue; }
      if (response.status === 401 || response.status === 403) throw new Error(`Jev authentication failed (${response.status}). Check the TypeSafe API key.`);
      if (response.status === 422) throw new Error("Jev rejected the request (422). Check the model and typed question payload.");
      if (response.status === 429) throw new Error("Jev rate limit persisted after retries (429).");
      if (response.status === 529) throw new Error("Jev service remained unavailable after retries (529).");
      throw new Error(`Jev request failed (${response.status}).`);
    }
  }
}
