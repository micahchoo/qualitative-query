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
    const client = new JevClient("secret", "jev-1.13.0", { post }, async () => {});
    const throttle = vi.fn();
    await client.rank("q", "c", { mode: "generic" }, "", throttle);
    expect(throttle).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    const bad = vi.fn().mockResolvedValue({ status: 422, json: {} });
    await expect(new JevClient("secret", "jev-1.13.0", { post: bad }, async () => {}).rank("q", "c", { mode: "generic" })).rejects.toThrow("422");
    expect(bad).toHaveBeenCalledTimes(1);
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
