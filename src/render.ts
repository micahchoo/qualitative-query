import { Component, MarkdownRenderer, TFile, type App } from "obsidian";
import type { Block, Candidate, Judgement, QueryResult, QuerySpec } from "./types";

type Expansion = (candidate: Candidate, adjacent: number) => Block;

/** Only the fence language changes; authored source content remains intact. */
export function inertQueryBlocks(text: string): string {
  return text.replace(/^( {0,3})(`{3,}|~{3,})(?:qualitative-query|qq)[ \t]*$/gm, "$1$2text");
}

export async function renderResult(
  app: App,
  container: HTMLElement,
  result: QueryResult,
  spec: QuerySpec,
  component: Component,
  expand?: Expansion,
  onInclude?: (judgement: Judgement, include: boolean) => Promise<void>,
  belowThreshold = false,
): Promise<void> {
  let active = true;
  component.register(() => { active = false; });
  container.empty();
  container.addClass("qq-view");
  if (result.stats) {
    const s = result.stats;
    container.createDiv({ cls: "qq-status", text: `Shortlisted ${s.shortlisted} passages from ${s.searchable} searchable blocks · ${s.overlapRemoved} overlaps removed${s.truncated ? ` · Window limit ${s.windowLimit} reached; more matches were available` : ""}.` });
    container.createDiv({ cls: "qq-status", text: result.selection === "local"
      ? "Local matches · Jev minimum score does not apply."
      : `${s.checked} checked · ${s.cached} cached · ${s.shared} shared · ${s.requested} sent in ${s.requests} requests · ${s.retries} retries · ${s.skipped} skipped · ${s.passed} meet minimum score ${s.threshold}.` });
    if (s.requests) container.createDiv({ cls: "qq-status", text: `Jev read ${s.inputTokens.toLocaleString()} input tokens · ${Math.round(s.requestMs / s.requests).toLocaleString()} ms average per request.` });
    if (s.contextChars) container.createDiv({ cls: "qq-status", text: `Explicit context: ${s.contextChars.toLocaleString()} / 48,000 characters.` });
  }
  if (result.belowThreshold?.length) {
    const below = result.belowThreshold;
    const details = container.createEl("details");
    details.createEl("summary", { text: `${below.length} passages below minimum score` });
    details.createEl("p", { text: "Highest scores first. These passages are not included when you save the selection." });
    const list = details.createDiv();
    const more = details.createEl("button", { text: "Show next 25" });
    let offset = 0, busy = false;
    const page = async () => {
      if (busy || !active || offset >= below.length) return;
      busy = true; more.disabled = true;
      const stage = list.createDiv();
      const chunk = below.slice(offset, offset + 25);
      await renderResult(app, stage, { status: "ready", selection: "jev", candidates: [], judgements: chunk }, { ...spec, adjacent: 0 }, component, expand, onInclude, true);
      if (!active) return;
      offset += chunk.length; busy = false; more.disabled = false; more.hidden = offset >= below.length;
    };
    component.registerDomEvent(details, "toggle", () => { if (details.open && offset === 0) void page(); });
    component.registerDomEvent(more, "click", () => { void page(); });
  }
  if (result.warning) container.createDiv({ cls: "qq-warning", text: result.warning });
  if (result.status !== "ready") {
    container.createDiv({ cls: result.status === "error" ? "qq-error" : "qq-status", text: result.error ?? "No matching passages found. Try a broader question." });
    return;
  }
  const visibleRanges: Array<{ path: string; start: number; end: number }> = [];
  for (const judgement of result.judgements) {
    if (!active) return;
    const original = judgement.candidate;
    let adjacent = spec.adjacent ?? 0;
    const initial = adjacent && expand ? expand(original, adjacent) : original;
    if (visibleRanges.some(range => range.path === initial.path && range.start <= initial.lineStart && range.end >= initial.lineEnd)) continue;
    visibleRanges.push({ path: initial.path, start: initial.lineStart, end: initial.lineEnd });
    const item = container.createDiv({ cls: "qq-result" });
    const meta = item.createDiv({ cls: "qq-result-meta" });
    const link = meta.createEl("a", { text: original.path, href: "#" });
    component.registerDomEvent(link, "click", event => {
      event.preventDefault();
      const file = app.vault.getAbstractFileByPath(original.path);
      if (!(file instanceof TFile)) return;
      void app.workspace.getLeaf(event.ctrlKey || event.metaKey).openFile(file, { eState: { line: Math.max(0, original.lineStart - 1) } });
    });
    meta.createSpan({ cls: "qq-breadcrumb", text: original.headingPath.join(" › ") });
    if (result.selection !== "local" && spec.criteria.mode === "default") meta.createSpan({ text: judgement.contribution });
    meta.createSpan({ cls: "qq-score", text: result.selection === "local" ? "Local match" : `Jev score ${judgement.score.toFixed(2)}` });
    if (judgement.manuallyIncluded) meta.createSpan({ text: "Manually included" });
    if (onInclude && (belowThreshold || judgement.manuallyIncluded)) {
      const control = item.createEl("button", { text: judgement.manuallyIncluded ? "Undo inclusion" : "Include passage" });
      component.registerDomEvent(control, "click", async () => {
        if (!active || control.disabled) return;
        control.disabled = true;
        try { await onInclude(judgement, !judgement.manuallyIncluded); }
        catch (error) { if (active) { item.createDiv({ cls: "qq-error", text: error instanceof Error ? error.message : String(error) }); control.disabled = false; } }
      });
    }
    const content = item.createDiv({ cls: "qq-source-content" });
    let markdownChild: Component | undefined;
    let serial = 0;
    const show = async (block: Block): Promise<void> => {
      if (!active) return;
      const version = ++serial;
      if (markdownChild) component.removeChild(markdownChild);
      const child = new Component();
      markdownChild = child;
      component.addChild(child);
      const stage = createDiv();
      stage.addClass("qq-source-content");
      try {
        await MarkdownRenderer.render(app, inertQueryBlocks(block.renderText ?? block.text), stage, block.path, child);
      } catch {
        if (active && version === serial) content.setText("Could not render this passage. Open its source note.");
        return;
      }
      if (!active || version !== serial) return;
      content.empty();
      content.appendChild(stage);
    };
    component.register(() => { serial++; });
    await show(initial);
    if (!active) return;
    if (expand) {
      const button = item.createEl("button", { cls: "qq-expand", text: "Show nearby text" });
      component.registerDomEvent(button, "click", () => {
        if (!active) return;
        adjacent = adjacent ? 0 : 1;
        button.setText(adjacent ? "Hide nearby text" : "Show nearby text");
        void show(adjacent ? expand(original, adjacent) : original);
      });
    }
  }
}

export function renderLoading(container: HTMLElement): void {
  container.empty();
  container.addClass("qq-view");
  container.createDiv({ cls: "qq-status", text: "Finding passages…" });
}
