import { describe, expect, it } from "vitest";
import { ENDPOINT, bucketKey, scoreKey, scoreNamespace } from "../src/score-identity";
import type { Candidate, QuerySpec } from "../src/types";

const spec: QuerySpec = { question: "What defines conflict?", folder: "Queries", contextPaths: [], criteria: { mode: "generic" } };
const candidate: Candidate = { id: "a", path: "a.md", lineStart: 1, lineEnd: 1, text: "A conflict.", searchText: "A conflict.", kind: "paragraph", headingPath: ["Notes"], lexicalScore: 1 };

describe("a score's identity", () => {
  it("carries the endpoint the request goes to", () => {
    expect(scoreNamespace("jev-1")).toContain(ENDPOINT);
  });
  it("separates batched from single-passage scores, and one model from another", () => {
    expect(scoreNamespace("jev-1")).toBe(scoreNamespace("jev-1", 1));
    expect(scoreNamespace("jev-1", 10)).not.toBe(scoreNamespace("jev-1"));
    expect(scoreNamespace("jev-2")).not.toBe(scoreNamespace("jev-1"));
  });
  it("keys a score by the text shown to Jev, not where it sits", () => {
    const moved = { ...candidate, path: "b.md", lineStart: 9, lineEnd: 9 };
    expect(scoreKey("ns", spec, moved, "")).toBe(scoreKey("ns", spec, candidate, ""));
    expect(scoreKey("ns", spec, { ...candidate, text: "Another." }, "")).not.toBe(scoreKey("ns", spec, candidate, ""));
    expect(scoreKey("ns", spec, candidate, "context")).not.toBe(scoreKey("ns", spec, candidate, ""));
  });
  it("orders criteria keys so equal criteria make equal keys", () => {
    const a = scoreKey("ns", { ...spec, criteria: { mode: "generic", true: "yes", false: "no" } }, candidate, "");
    const b = scoreKey("ns", { ...spec, criteria: { false: "no", true: "yes", mode: "generic" } }, candidate, "");
    expect(a).toBe(b);
  });
  it("batches only passages with the same question, criteria and context", () => {
    const criteria = spec.criteria;
    expect(bucketKey("q", criteria, "")).toBe(bucketKey("q", { ...criteria }, ""));
    expect(bucketKey("q", criteria, "ctx")).not.toBe(bucketKey("q", criteria, ""));
    expect(bucketKey("q", { mode: "default" }, "")).not.toBe(bucketKey("q", criteria, ""));
  });
});
