import { expect, it } from "vitest";
import { TFile, type App } from "obsidian";
import { readContextBlocks } from "../src/context";
import { parseQuery, resolveContext } from "../src/query";
const file = Object.assign(new TFile(), { path: "Notes/source.md" });
const position = (start: number, end = start) => ({ start: { line: start }, end: { line: end } });
const app = { vault: { getAbstractFileByPath: () => file, cachedRead: async () => "# First\nChosen ^anchor\n## Child\nDetail\n# Second\nExcluded" }, metadataCache: {
 getFirstLinkpathDest: () => file,
 getFileCache: () => ({ blocks: { anchor: { position: position(1) } }, headings: [ { heading: "First", level: 1, position: position(0) }, { heading: "Child", level: 2, position: position(2) }, { heading: "Second", level: 1, position: position(4) } ] }),
} } as unknown as App;
it("retains explicit context subpaths through parsing and resolution", () => {
 const spec = parseQuery("Queries/q.md", "", "Queries", "question: Test\ncontext: [[source#^anchor]], [[source#First|label]]");
 expect(spec.contextPaths).toEqual(["source#^anchor", "source#First"]);
 expect([...resolveContext(app, file, spec.contextPaths)]).toEqual(["Notes/source.md#^anchor", "Notes/source.md#First"]);
});
it("reads only an explicitly selected block or section including subsections", async () => {
 expect((await readContextBlocks(app, "Notes/source.md#^anchor"))[0].text).toBe("Chosen ^anchor");
 expect((await readContextBlocks(app, "Notes/source.md#First"))[0].text).toBe("# First\nChosen ^anchor\n## Child\nDetail");
 await expect(readContextBlocks(app, "Notes/source.md#Missing")).rejects.toThrow("section not found");
 await expect(readContextBlocks(app, "Notes/source.md#^missing")).rejects.toThrow("block not found");
});
