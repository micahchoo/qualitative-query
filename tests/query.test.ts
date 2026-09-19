import { describe, expect, it } from "vitest";
import { parseQuery } from "../src/query";

describe("query note authoring", () => {
  it("uses the note title by default and accepts codeblock overrides", () => {
    const spec = parseQuery("Queries/What defines conflict.md", "# Notes\n\n```qualitative-query\nquestion: A narrower question\ncriteria: generic\nlimit: 4\nadjacent: 1\ncontext: [[Project context]]\n```", "Queries");
    expect(spec.question).toBe("A narrower question");
    expect(spec.criteria.mode).toBe("generic");
    expect(spec.limit).toBe(4);
    expect(spec.adjacent).toBe(1);
    expect(spec.contextPaths).toEqual(["Project context"]);
    expect(parseQuery("Queries/What defines conflict.md", "", "Queries").question).toBe("What defines conflict");
    expect(parseQuery("Queries/Anything.md", "", "Queries", "What defines conflict?").question).toBe("What defines conflict?");
  });
});
