import { checkSignal } from "./work";
import { requestUrl } from "obsidian";
import type { JevResponse, QueryCriteria } from "./types";

export interface JevTransport { post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown }> }
const defaultTransport: JevTransport = { post: async (url, headers, body) => { const response = await requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false }); return { status: response.status, json: response.json }; } };

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export class JevClient {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly transport: JevTransport = defaultTransport, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))) {}

  async rank(question: string, candidate: string, criteria: QueryCriteria, context = "", onThrottle?: () => void, onRetry?: () => void, signal?: AbortSignal): Promise<JevResponse> {
    checkSignal(signal);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey.trim()) headers.Authorization = `Bearer ${this.apiKey}`;
    else throw new Error("TypeSafe API key is not configured.");
    const questions: Record<string, unknown> = {};
    if (criteria.mode === "generic") {
      questions.relevant = { type: "noul", instructions: criteria.instructions ?? `Does this passage answer the question: “${question}”?`, criteria: { true: criteria.true ?? "The passage directly addresses the question with substantive content.", false: criteria.false ?? "The passage only mentions the topic or is unrelated." } };
    } else {
      questions.definition = { type: "noul", instructions: `For the question “${question}”, does this passage directly define the subject?`, criteria: { true: "It states what the subject is or means, rather than merely mentioning it.", false: "It mentions, illustrates, or uses the subject without defining it." } };
      questions.condition = { type: "noul", instructions: `For the question “${question}”, does this passage state a condition that makes the subject apply?`, criteria: { true: "It states a qualifying condition, test, boundary, or necessary feature.", false: "It does not give a condition or boundary for the subject." } };
      questions.distinction = { type: "noul", instructions: `For the question “${question}”, does this passage distinguish the subject from a related concept?`, criteria: { true: "It contrasts, separates, or clarifies the subject against another concept.", false: "It does not distinguish the subject from a related concept." } };
      questions.contribution = { type: "choice", instructions: `Which contribution does this passage make toward answering “${question}”?`, criteria: { definition: "Directly defines the subject.", condition: "States qualifying conditions, tests, or boundaries.", distinction: "Distinguishes the subject from related concepts.", other: "None of those; it is another kind of relevant contribution." } };
    }
    const body = { model: this.model, state: { question, candidate_passage: candidate, context_notes: context }, questions };
    let attempt = 0;
    while (true) {
      checkSignal(signal);
      const response = await this.transport.post(ENDPOINT, headers, body, signal);
      checkSignal(signal);
      if (response.status >= 200 && response.status < 300) return response.json as JevResponse;
      if (response.status === 429 || response.status === 529) onThrottle?.();
      if ((response.status === 429 || response.status === 529) && attempt < 3) { onRetry?.(); await this.sleep(250 * 2 ** attempt); attempt++; continue; }
      if (response.status === 401 || response.status === 403) throw new Error(`Jev authentication failed (${response.status}). Check the TypeSafe API key.`);
      if (response.status === 422) throw new Error("Jev rejected the request (422). Check the model and typed question payload.");
      if (response.status === 429) throw new Error("Jev rate limit persisted after retries (429).");
      if (response.status === 529) throw new Error("Jev service remained unavailable after retries (529).");
      throw new Error(`Jev request failed (${response.status}).`);
    }
  }
}
