import { Component, MarkdownRenderChild, Notice, TFile, type App } from "obsidian";
import { applyInclusions, inclusionFor, updateInclusions } from "./manual-selection";
import { bakeNote, PendingSave } from "./bake";
import { parseQuery, QUERY_FENCE, resolveContext } from "./query";
import { renderLoading, renderResult } from "./render";
import { expandBlock } from "./markdown";
import { visibleSelection, type Expansion } from "./selection";
import { ViewState } from "./view-state";
import type { QueryEngine } from "./engine";
import type { VaultIndex } from "./indexer";
import type { Settings } from "./settings";
import type { QueryResult, QuerySpec } from "./types";

/** What a view reads from the plugin. The plugin is one; a test can be another. */
export interface QueryViewHost {
  app: App;
  settings: Settings;
  index: VaultIndex;
  engine: QueryEngine;
  /** Null when no Jev key is set: the view says so and shows local matches. */
  client: object | null;
  indexError: string;
  clientError: string;
  stopped: boolean;
  views: Set<QueryView>;
  autoViews: Map<string, QueryView>;
}

/**
 * One rendered Question. Owns its run, its Markdown children and the note writes it starts;
 * what a change means while any of those is in flight is `ViewState`'s decision.
 */
export class QueryView extends MarkdownRenderChild {
  private readonly state = new ViewState();
  private run?: AbortController;
  private content?: Component;

  constructor(
    private readonly plugin: QueryViewHost,
    el: HTMLElement,
    private readonly sourcePath: string,
    private readonly blockSource?: string,
    private readonly autoKey?: string,
  ) { super(el); }

  onload(): void {
    this.plugin.views.add(this);
    void this.refresh();
  }

  invalidate(): void { if (this.state.invalidate() === "abort") this.run?.abort(); }

  onunload(): void {
    this.state.stop();
    this.run?.abort();
    this.plugin.views.delete(this);
    if (this.autoKey && this.plugin.autoViews.get(this.autoKey) === this) this.plugin.autoViews.delete(this.autoKey);
    this.containerEl.empty();
  }

  async refresh(): Promise<void> {
    const token = this.state.begin();
    if (!token) return;
    this.run?.abort();
    const run = this.run = new AbortController();
    const current = () => token.current() && !this.plugin.stopped;
    if (this.content) { this.removeChild(this.content); this.content = undefined; }
    renderLoading(this.containerEl);
    let spec: QuerySpec = { question: "", folder: this.plugin.settings.queryFolder, contextPaths: [], criteria: { mode: "generic" } };
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
      if (!(file instanceof TFile)) throw new Error("The query note no longer exists. Open its new location or close this view.");
      const text = await this.plugin.app.vault.cachedRead(file);
      if (!current()) return;
      // A note with explicit query blocks does not also get an automatic view.
      if (this.blockSource === undefined && QUERY_FENCE.test(text)) { this.containerEl.empty(); return; }
      spec = parseQuery(file.path, text, this.plugin.settings.queryFolder, this.blockSource);
      spec.contextPaths = [...resolveContext(this.plugin.app, file, spec.contextPaths)];
      await this.plugin.index.whenReady();
      if (!current()) return;
      if (this.plugin.indexError) throw new Error(this.plugin.indexError);
      if (this.plugin.clientError) throw new Error(this.plugin.clientError);
      let result: QueryResult;
      {
        let completed = 0;
        let total = 0;
        const started = Date.now();
        let rendering = Promise.resolve();
        let partialVersion = 0;
        const showProgress = () => {
          if (!current()) return;
          let status = this.containerEl.querySelector<HTMLElement>(".qq-progress");
          if (!status) {
            status = createDiv(); status.className = "qq-status qq-progress";
            this.containerEl.prepend(status);
          }
          status.textContent = this.plugin.client ? `Jev is checking passages: ${completed}/${total} · ${Math.floor((Date.now() - started) / 1000)}s` : "Finding passages locally…";
        };
        const timer = window.setInterval(showProgress, 1000);
        try {
          result = await this.plugin.engine.run(spec, this.plugin.settings.candidateLimit, this.plugin.settings.resultLimit, spec.threshold ?? this.plugin.settings.threshold,
            (done, count) => { completed = done; total = count; showProgress(); },
            partial => {
              const revision = ++partialVersion;
              rendering = rendering.then(async () => {
                const valid = () => current() && revision === partialVersion;
                if (!valid()) return;
                await this.display(partial, spec, valid);
                showProgress();
              }).catch(error => console.warn("Qualitative Query: partial rendering failed", error));
            }, run.signal);
        } finally {
          window.clearInterval(timer);
          partialVersion++;
          await rendering;
        }
      }
      if (!current()) return;
      await this.display(result, spec, current, true);
    } catch (error) {
      if (!current()) return;
      await this.display({ status: "error", candidates: [], judgements: [], error: error instanceof Error ? error.message : String(error) }, spec, current);
    }
  }

  /** Run a note write under the state's rules: one at a time, changes deferred, refresh after if one arrived. */
  private async writing(work: () => Promise<unknown>): Promise<boolean> {
    if (!this.state.beginSave()) return false;
    try { await work(); }
    finally { if (this.state.endSave()) void this.refresh(); }
    return true;
  }

  private async display(result: QueryResult, spec: QuerySpec, current: () => boolean, allowBake = false): Promise<void> {
    const baseResult = result;
    const queryFile = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    const manual = allowBake && queryFile instanceof TFile
      ? await applyInclusions(await this.plugin.app.vault.read(queryFile), spec, result, this.plugin.index.blocks)
      : { result, missing: [] };
    result = manual.result;
    // What is saved is what is shown: one Selection, read by the renderer and the bake alike.
    const expand: Expansion = (candidate, adjacent) => expandBlock(candidate, this.plugin.index.blocksForPath(candidate.path), adjacent);
    const shown = visibleSelection(result.judgements, spec.adjacent ?? 0, expand).map(passage => passage.judgement);
    const content = new Component();
    this.addChild(content);
    const stage = createDiv();
    stage.addClass("qq-view");
    try {
      await renderResult(this.plugin.app, stage, result, spec, content, expand,
        allowBake && queryFile instanceof TFile ? async (judgement, include) => {
          if (!current()) return;
          const entry = await inclusionFor(judgement);
          if (!current()) return;
          await this.writing(() => this.plugin.app.vault.process(queryFile, text => updateInclusions(text, spec, entry, include)));
          if (current()) await this.display(baseResult, spec, current, true);
        } : undefined);
      for (const missing of manual.missing) {
        const warning = stage.createDiv({ cls: "qq-warning", text: missing.message });
        const remove = warning.createEl("button", { text: "Remove inclusion" });
        content.registerDomEvent(remove, "click", async () => {
          if (!current() || !(queryFile instanceof TFile) || remove.disabled) return;
          remove.disabled = true;
          try {
            await this.writing(() => this.plugin.app.vault.process(queryFile, text => updateInclusions(text, spec, missing.entry, false)));
            if (current()) await this.display(baseResult, spec, current, true);
          } catch (error) { remove.disabled = false; new Notice(error instanceof Error ? error.message : String(error)); }
        });
      }
      if (allowBake && result.status === "ready" && shown.length) {
        const tools = createDiv();
        tools.className = "qq-bake-actions";
        const button = tools.createEl("button", { text: "Save passages" });
        tools.createEl("small", { text: " Creates a note with these passages linked to their sources. Adds missing block IDs to source notes. Nearby context is not saved." });
        const saveStatus = tools.createEl("small", { text: "" });
        const controller = new AbortController();
        content.register(() => controller.abort());
        let save = () => bakeNote(this.plugin.app, { ...result, judgements: shown }, spec, this.sourcePath, {
          signal: controller.signal,
          onWait: (pending, ms) => saveStatus.setText(` Waiting for ${pending} source links · timeout in ${Math.ceil(ms / 1000)}s.`),
        });
        content.registerDomEvent(button, "click", async () => {
          if (!current() || controller.signal.aborted) return;
          button.disabled = true;
          let file: TFile | undefined;
          try {
            await this.writing(async () => { file = await save(); });
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof PendingSave) { save = error.retry; button.setText("Retry save"); }
            saveStatus.setText(error instanceof Error ? error.message : String(error)); button.disabled = false;
            return;
          }
          if (!file) return;
          saveStatus.setText(" Saved.");
          new Notice("Passages saved. Open a source note’s backlinks to see the connection.");
          await this.plugin.app.workspace.getLeaf(true).openFile(file, { state: { mode: "preview" } });
        });
        stage.prepend(tools);
      }
      if (!current()) { this.removeChild(content); return; }
      if (this.content) this.removeChild(this.content);
      this.content = content;
      this.containerEl.empty();
      this.containerEl.appendChild(stage);
    } catch (error) { this.removeChild(content); throw error; }
  }
}
