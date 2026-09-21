import { describe, expect, it, vi } from "vitest";
import { JevClient } from "../src/jev";

describe("Jev transport", () => {
  it("sends typed noul and choice questions in one request", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, json: { answers: { definition: { noul: 0.9 }, contribution: { choice: "definition" } } } });
    const client = new JevClient("secret", "jev-1.13.0", { post });
    const response = await client.rank("What defines conflict?", "Conflict is...", { mode: "default" }, "A linked context note");
    expect(response.answers.definition.noul).toBe(0.9);
    const body = post.mock.calls[0][2] as any;
    expect(body.state.context_notes).toContain("linked context");
    expect(body.questions.definition.type).toBe("noul");
    expect(body.questions.contribution.type).toBe("choice");
  });

  it("retries rate limits and does not retry client errors", async () => {
    const post = vi.fn().mockResolvedValueOnce({ status: 429, json: {} }).mockResolvedValueOnce({ status: 200, json: { answers: {} } });
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new JevClient("secret", "jev-1.13.0", { post }, sleep);
    const onThrottle = vi.fn();
    await client.rank("q", "c", { mode: "generic" }, "", { onThrottle });
    expect(onThrottle).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    // Jittered backoff: half the delay is fixed, half is spread across the window.
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(125);
    expect(sleep.mock.calls[0][0]).toBeLessThan(250);
    const bad = vi.fn().mockResolvedValue({ status: 422, json: {} });
    await expect(new JevClient("secret", "jev-1.13.0", { post: bad }, async () => {}).rank("q", "c", { mode: "generic" })).rejects.toThrow("422");
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("reports tokens and elapsed time for each completed request", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, json: { answers: { relevant: { noul: 0.7 } }, usage: { input_tokens: 412 } } });
    const onRequest = vi.fn();
    await new JevClient("secret", "jev-1.13.0", { post }).rank("q", "c", { mode: "generic" }, "", { onRequest });
    expect(onRequest).toHaveBeenCalledTimes(1);
    const report = onRequest.mock.calls[0][0];
    expect(report).toMatchObject({ requests: 1, passages: 1, inputTokens: 412 });
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("carries several passages in one request and splits the answers back out", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, json: { answers: {
      "a.relevant": { noul: 0.8 }, "b.relevant": { noul: 0.1 }, "stray": { noul: 0.5 },
    }, usage: { input_tokens: 900 } } });
    const onRequest = vi.fn();
    const client = new JevClient("secret", "jev-1.13.0", { post });
    const answers = await client.rankMany("What defines conflict?", [{ id: "a", text: "first passage" }, { id: "b", text: "second passage" }], { mode: "generic" }, "shared context", { onRequest });
    expect(answers.get("a")!.answers.relevant.noul).toBe(0.8);
    expect(answers.get("b")!.answers.relevant.noul).toBe(0.1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.calls[0][0]).toMatchObject({ requests: 1, passages: 2, inputTokens: 900 });
    const body = post.mock.calls[0][2] as any;
    // The shared part of the state travels once; each question points at its own passage.
    expect(body.state.context_notes).toBe("shared context");
    expect(body.state.passages).toEqual({ a: "first passage", b: "second passage" });
    expect(body.questions["a.relevant"].instructions.inspect).toBe("passages.a");
    expect(body.state.candidate_passage).toBeUndefined();
  });

  it("keeps the single-passage body unchanged so earlier scores stay reachable", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, json: { answers: { relevant: { noul: 0.6 } } } });
    const client = new JevClient("secret", "jev-1.13.0", { post });
    const answers = await client.rankMany("q", [{ id: "only", text: "one passage" }], { mode: "generic" }, "");
    expect(answers.get("only")!.answers.relevant.noul).toBe(0.6);
    const body = post.mock.calls[0][2] as any;
    expect(body.state.candidate_passage).toBe("one passage");
    expect(body.state.passages).toBeUndefined();
    expect(body.questions.relevant.instructions).toBe("Does this passage answer the question: “q”?");
  });

  it("requires a key and sends credentials only to the fixed Jev endpoint", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, json: { answers: {} } });
    await expect(new JevClient("", "jev-1.13.0", { post }).rank("q", "p", { mode: "generic" })).rejects.toThrow("key");
    expect(post).not.toHaveBeenCalled();
    await new JevClient("secret", "jev-1.13.0", { post }).rank("q", "p", { mode: "generic" });
    expect(post.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(post.mock.calls[0][1].Authorization).toBe("Bearer secret");
  });
});
