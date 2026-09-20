import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Component, MarkdownRenderer } from "obsidian";
import { renderResult } from "../src/render";
import { parseMarkdown } from "../src/markdown";
import type { QueryResult, QuerySpec } from "../src/types";

vi.mock("obsidian", async () => {
  const original = await vi.importActual<object>("obsidian");
  class Owner {
    cleanups: Array<() => void> = [];
    children: Owner[] = [];
    register(fn: () => void) { this.cleanups.push(fn); }
    addChild(child: Owner) { this.children.push(child); return child; }
    removeChild(child: Owner) { child.unload(); this.children = this.children.filter(value => value !== child); }
    registerDomEvent(el: ElementAdapter, type: string, fn: () => void) { el.events.set(type, fn); }
    unload() { this.cleanups.forEach(fn => fn()); this.children.forEach(child => child.unload()); }
  }
  return { ...original, Component: Owner, MarkdownRenderer: { render: vi.fn() } };
});
class ElementAdapter {
  children: ElementAdapter[] = [];
  events = new Map<string, () => void>();
  text = "";
  empty() { this.children = []; }
  addClass() {}
  setText(text: string) { this.text = text; }
  appendChild(child: ElementAdapter) { this.children.push(child); }
  createEl(_tag: string, options: { text?: string } = {}) { const child = new ElementAdapter(); child.text = options.text ?? ""; this.children.push(child); return child; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
}
const spec: QuerySpec = { question: "test", folder: "Questions", contextPaths: [], criteria: { mode: "generic" } };
const blocks = parseMarkdown("source.md", "First passage.\n\nSecond passage.");
const result: QueryResult = { status: "ready", candidates: [], judgements: blocks.map(candidate => ({ candidate: { ...candidate, lexicalScore: 1 }, score: 1, contribution: "other", scores: {} })) };
it("stops rendering further passages when unloaded during a Markdown render", async () => {
  let finish!: () => void;
  vi.mocked(MarkdownRenderer.render).mockReset().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  vi.stubGlobal("createEl", () => new ElementAdapter());
  vi.stubGlobal("createDiv", () => new ElementAdapter());
  const owner = new Component(); const container = new ElementAdapter();
  try {
    const rendering = renderResult({} as App, container as unknown as HTMLElement, result, spec, owner, candidate => candidate);
    owner.unload(); finish(); await rendering;
    expect(MarkdownRenderer.render).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(1);
    expect(container.children[0].children).toHaveLength(2); // Metadata and passage container, no expansion button.
  } finally { vi.unstubAllGlobals(); }
});
it("ignores an older expansion failure after a newer render succeeds", async () => {
  let rejectOlder!: (error: Error) => void;
  vi.mocked(MarkdownRenderer.render).mockReset().mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOlder = reject; }))
    .mockResolvedValueOnce(undefined);
  vi.stubGlobal("createEl", () => new ElementAdapter());
  vi.stubGlobal("createDiv", () => new ElementAdapter());
  const owner = new Component(); const container = new ElementAdapter();
  try {
    await renderResult({} as App, container as unknown as HTMLElement, { ...result, judgements: result.judgements.slice(0, 1) }, spec, owner, candidate => candidate);
    const item = container.children[0]; const content = item.children[1]; const button = item.children[2];
    button.events.get("click")!(); button.events.get("click")!();
    await Promise.resolve();
    rejectOlder(new Error("late failure")); await Promise.resolve();
    expect(content.text).toBe("");
    expect(content.children).toHaveLength(1);
  } finally { owner.unload(); vi.unstubAllGlobals(); }
});
it("offers inclusion for rejected passages and undo for manual selections", async () => {
  vi.mocked(MarkdownRenderer.render).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("createEl", () => new ElementAdapter());
  vi.stubGlobal("createDiv", () => new ElementAdapter());
  const owner = new Component(), container = new ElementAdapter();
  const include = vi.fn().mockResolvedValue(undefined);
  const find = (element: ElementAdapter, text: string): ElementAdapter | undefined => element.text === text ? element : element.children.map(child => find(child, text)).find(Boolean);
  try {
    await renderResult({} as App, container as unknown as HTMLElement, { ...result, judgements: [result.judgements[0]] }, spec, owner, undefined, include, true);
    await find(container, "Include passage")!.events.get("click")!();
    expect(include).toHaveBeenCalledWith(result.judgements[0], true);
    const selected = { ...result.judgements[0], manuallyIncluded: true };
    await renderResult({} as App, container as unknown as HTMLElement, { ...result, judgements: [selected] }, spec, owner, undefined, include);
    expect(find(container, "Manually included")).toBeDefined();
    await find(container, "Undo inclusion")!.events.get("click")!();
    expect(include).toHaveBeenLastCalledWith(selected, false);
  } finally { owner.unload(); vi.unstubAllGlobals(); }
});
