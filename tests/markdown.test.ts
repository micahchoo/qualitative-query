import { describe, expect, it } from "vitest";
import { expandBlock, parseMarkdown } from "../src/markdown";

describe("deterministic markdown blocks", () => {
  it("keeps nested list items with their subtree and excludes siblings", () => {
    const blocks = parseMarkdown("note.md", "# Topic\n\n- Parent\n  - unrelated sibling\n  - chosen\n    - child\n- other root\n");
    const lists = blocks.filter((block) => block.kind === "list");
    expect(lists).toHaveLength(5);
    expect(lists[0].text).toContain("unrelated sibling");
    expect(lists[0].text).toContain("chosen");
    expect(lists[0].text).not.toContain("other root");
    expect(lists[2].text).toContain("chosen");
    expect(lists[2].text).toContain("child");
    expect(lists[2].text).not.toContain("unrelated sibling");
    expect(lists[2].text).not.toContain("other root");
    expect(lists[2].renderText).toContain("- Parent");
    expect(lists[2].renderText).not.toContain("unrelated sibling");
    expect(lists[1].parentId).toBe(lists[0].id);

    const withSibling = expandBlock(lists[2], lists, 1);
    expect(withSibling.text.match(/- Parent/g)).toHaveLength(1);
    expect(withSibling.text).toContain("unrelated sibling");
  });

  it("uses complete fences, tables, and callouts as units", () => {
    const blocks = parseMarkdown("note.md", "## Heading\n\n```ts\nconst x = 1;\n```\n\n> [!note]\n> Keep this\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(blocks.map((block) => block.kind)).toEqual(["fence", "callout", "table"]);
    expect(blocks[0].headingPath).toEqual(["Heading"]);
  });

  it("recognizes ordinary tables, setext headings, and keeps fenced content intact", () => {
    const blocks = parseMarkdown("note.md", "Title\n=====\n\nfirst\n\nName | Value\n--- | ---\nalpha | # not a heading\n\n~~~md\n# not a heading\n~~~\n\nsecond\n");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "fence", "paragraph"]);
    expect(blocks[0].headingPath).toEqual(["Title"]);
    expect(blocks[1].text).toContain("alpha | # not a heading");
    expect(blocks[2].text).toContain("# not a heading");
    expect(blocks[2].headingPath).toEqual(["Title"]);
  });

  it("keeps loose list items and nested fenced content in the selected subtree", () => {
    const blocks = parseMarkdown("note.md", "- Parent\n\n  detail\n\n  ```js\n  code\n  ```\n\n  - chosen\n    - child\n\n- sibling\n\nAfter\n");
    const lists = blocks.filter((block) => block.kind === "list");
    expect(lists).toHaveLength(4);
    expect(lists[0].text).toContain("```js");
    expect(lists[1].text).toContain("child");
    expect(lists[1].text).not.toContain("sibling");
    expect(blocks.at(-1)?.text).toBe("After");
  });

  it("does not turn fenced list content into nested list items", () => {
    const blocks = parseMarkdown("note.md", "- Parent\n  ```text\n  - fake\n  ```\n- Sibling\n");
    const lists = blocks.filter((block) => block.kind === "list");
    expect(lists).toHaveLength(2);
    expect(lists[0].text).toContain("- fake");
    expect(lists[1].parentId).toBeUndefined();
  });

  it("expands only inside the same heading section", () => {
    const blocks = parseMarkdown("note.md", "# A\n\nfirst\n\nsecond\n\n# B\n\nthird\n");
    const expanded = expandBlock(blocks[0], blocks, 1);
    expect(expanded.text).toContain("second");
    expect(expanded.text).not.toContain("third");
  });

  it("does not cross repeated heading sections during expansion", () => {
    const blocks = parseMarkdown("note.md", "# Same\n\nfirst\n\n# Same\n\nsecond\n\n# Same\n\nthird\n");
    const expanded = expandBlock(blocks[1], blocks, 10);
    expect(expanded.text).toBe("second");
    expect(expanded.sectionId).toBe("note.md:5");
  });

  it("expands around a list as one source unit", () => {
    const blocks = parseMarkdown("note.md", "# A\n\n- Parent\n  - child\n\nBefore\n\nAfter\n");
    const after = blocks.find((block) => block.text === "After")!;
    const expanded = expandBlock(after, blocks, 2);
    expect(expanded.text.match(/- Parent/g)).toHaveLength(1);
    expect(expanded.text).toContain("child");
    expect(expanded.text).toContain("Before");
    expect(expanded.text).not.toContain("# A");
  });
});
