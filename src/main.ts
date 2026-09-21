import { applyInclusions, inclusionFor, updateInclusions } from "./manual-selection";
import { readContextBlocks } from "./context";
import { parseObject } from "./validation";
declare const EMBEDDING_WORKER_SOURCE: string;
import { QueryBuilder } from "./builder";
import { bakeNote, BAKED_FOLDER, PendingSave } from "./bake";
import { Notice, Component, MarkdownRenderChild, Plugin, TFile, type MarkdownPostProcessorContext, type TAbstractFile } from "obsidian";
import { EmbeddingIndex } from "./embeddings";
import { downloadEmbeddings } from "./embedding-assets";
import { LocalRetrieval } from "./retrieval";
import { ScoreCache } from "./score-cache";
import { VaultIndex } from "./indexer";
import { parseQuery, resolveContext } from "./query";
import { JevClient } from "./jev";
import { PassageBatcher } from "./batch";
import { QueryEngine } from "./engine";
import { renderLoading, renderResult } from "./render";
import { expandBlock } from "./markdown";
import { DEFAULT_SETTINGS, TYPESAFE_ENDPOINT, SettingsTab, normalizeSettings, type Settings } from "./settings";
import type { Block, QueryResult, QuerySpec } from "./types";
const SCORING_VERSION = "jev-v1";

const QUERY_FENCE = /^ {0,3}(?:`{3,}|~{3,})(?:qualitative-query|qq)\s*$/m;

/** Each rendered query owns its subscriptions, async generation, and Markdown children. */
class QueryView extends MarkdownRenderChild {
  private version = 0;
  private run?: AbortController;
  private stopped = false;
  private saving = false;
  private content?: Component;

  constructor(
    private readonly plugin: QualitativeQueryPlugin,
    el: HTMLElement,
    private readonly sourcePath: string,
    private readonly blockSource?: string,
    private readonly autoKey?: string,
  ) { super(el); }

  onload(): void {
    this.plugin.views.add(this);
    void this.refresh();
  }

  invalidate(): void { if (!this.saving) { this.version++; this.run?.abort(); } }

  onunload(): void {
    this.stopped = true;
    this.run?.abort();
    this.invalidate();
    this.plugin.views.delete(this);
    if (this.autoKey && this.plugin.autoViews.get(this.autoKey) === this) this.plugin.autoViews.delete(this.autoKey);
    this.containerEl.empty();
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.saving) return;
    this.run?.abort();
    const run = this.run = new AbortController();
    const version = ++this.version;
    const current = () => !this.stopped && version === this.version && !this.plugin.stopped;
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

  private async display(result: QueryResult, spec: QuerySpec, current: () => boolean, allowBake = false): Promise<void> {
    const baseResult = result;
    const queryFile = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    const manual = allowBake && queryFile instanceof TFile
      ? await applyInclusions(await this.plugin.app.vault.read(queryFile), spec, result, this.plugin.index.blocks)
      : { result, missing: [] };
    result = manual.result;
    const content = new Component();
    this.addChild(content);
    const stage = createDiv();
    stage.addClass("qq-view");
    try {
      await renderResult(this.plugin.app, stage, result, spec, content, (candidate, adjacent) =>
        expandBlock(candidate, this.plugin.index.blocksForPath(candidate.path), adjacent),
        allowBake && queryFile instanceof TFile ? async (judgement, include) => {
          if (!current()) return;
          const entry = await inclusionFor(judgement);
          if (!current()) return;
          this.saving = true;
          try { await this.plugin.app.vault.process(queryFile, text => updateInclusions(text, spec, entry, include)); }
          finally { this.saving = false; }
          if (current()) await this.display(baseResult, spec, current, true);
        } : undefined);
      for (const missing of manual.missing) {
        const warning = stage.createDiv({ cls: "qq-warning", text: missing.message });
        const remove = warning.createEl("button", { text: "Remove inclusion" });
        content.registerDomEvent(remove, "click", async () => {
          if (!current() || !(queryFile instanceof TFile) || remove.disabled) return;
          remove.disabled = true; this.saving = true;
          try {
            await this.plugin.app.vault.process(queryFile, text => updateInclusions(text, spec, missing.entry, false));
            this.saving = false;
            if (current()) await this.display(baseResult, spec, current, true);
          } catch (error) { this.saving = false; remove.disabled = false; new Notice(error instanceof Error ? error.message : String(error)); }
        });
      }
      if (allowBake && result.status === "ready" && result.judgements.length) {
        const tools = createDiv();
        tools.className = "qq-bake-actions";
        const button = tools.createEl("button", { text: "Save passages" });
        tools.createEl("small", { text: " Creates a note with these passages linked to their sources. Adds missing block IDs to source notes. Nearby context is not saved." });
        const saveStatus = tools.createEl("small", { text: "" });
        const controller = new AbortController();
        content.register(() => controller.abort());
        let save = () => bakeNote(this.plugin.app, result, spec, this.sourcePath, {
          signal: controller.signal,
          onWait: (pending, ms) => saveStatus.setText(` Waiting for ${pending} source links · timeout in ${Math.ceil(ms / 1000)}s.`),
        });
        content.registerDomEvent(button, "click", async () => {
          if (!current() || controller.signal.aborted) return;
          button.disabled = true;
          this.saving = true;
          try {
            const file = await save();
            this.saving = false;
            saveStatus.setText(" Saved.");
            new Notice("Passages saved. Open a source note’s backlinks to see the connection.");
            await this.plugin.app.workspace.getLeaf(true).openFile(file, { state: { mode: "preview" } });
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof PendingSave) { save = error.retry; button.setText("Retry save"); }
            else this.saving = false;
            saveStatus.setText(error instanceof Error ? error.message : String(error)); button.disabled = false;
          }
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

export default class QualitativeQueryPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  index!: VaultIndex;
  engine!: QueryEngine;
  client: (Pick<JevClient, "rank"> & { batchSize?: number }) | null = null;
  private batcher?: PassageBatcher;
  clientError = "";
  indexError = "";
  stopped = false;
  readonly views = new Set<QueryView>();
  readonly autoViews = new Map<string, QueryView>();
  private refreshTimer?: number;
  private fileTimers = new Map<string, number>();
  private exclusionKey = "";
  private scoreCache?: ScoreCache;
  private retrieval!: LocalRetrieval;
  private corpusSource?: Block[];
  private corpus: Block[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.retrieval = new LocalRetrieval(() => new EmbeddingIndex({
      read: name => this.app.vault.adapter.readBinary(`${this.pluginDirectory()}/embeddings/${name}`),
      readWorker: async () => EMBEDDING_WORKER_SOURCE,
    }), () => downloadEmbeddings(this.app.vault.adapter, this.pluginDirectory()));
    this.addCommand({ id: "build-query", name: "Ask your vault", callback: () => new QueryBuilder(this.app, this.settings.queryFolder).open() });
    this.addRibbonIcon("search", "Ask your vault", () => new QueryBuilder(this.app, this.settings.queryFolder).open());
    const directory = this.manifest?.dir ?? `${this.app.vault.configDir}/plugins/qualitative-query`;
    const cachePath = `${directory}/scores-v1.json`;
    const adapter = this.app.vault.adapter;
    if (adapter) {
      let reported = false;
      const onError = (error: unknown) => {
        console.warn("Qualitative Query: score cache unavailable", error);
        if (!reported) { reported = true; new Notice("Qualitative Query could not persist some scores. Check available disk space and restart Obsidian."); }
      };
      try {
        const identityPath = `${directory}/score-cache-id.json`;
        let identity: string;
        if (await adapter.exists(identityPath)) {
          const storedIdentity = parseObject(await adapter.read(identityPath)).id;
          if (typeof storedIdentity !== "string" || !/^[a-f0-9-]{36}$/.test(storedIdentity)) throw new Error("Invalid score cache identity file.");
          identity = storedIdentity;
        } else {
          identity = crypto.randomUUID();
          await adapter.write(identityPath, JSON.stringify({ id: identity }));
        }
        this.scoreCache = new ScoreCache({ read: async () => await adapter.exists(cachePath) ? adapter.read(cachePath) : null },
          { databaseName: `qualitative-query-scores-v2-${identity}`, onError });
      } catch (error) { onError(error); }
    }
    this.index = new VaultIndex(this.app.vault, () => this.exclusions());
    this.exclusionKey = JSON.stringify(this.exclusions());
    this.rebuildClient();
    void this.scan();
    for (const language of ["qualitative-query", "qq"]) {
      this.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
        if (el.closest(".qq-source-content")) { el.createEl("pre", { text: source }); return; }
        this.mount(el, ctx, source);
      });
    }
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (el.closest(".qq-view") || !this.inQueryFolder(ctx.sourcePath)) return;
      const key = `${ctx.docId}:${ctx.sourcePath}`;
      if (this.autoViews.has(key)) return;
      if (el.querySelector(".qq-view, .block-language-qualitative-query, .block-language-qq")) return;
      const view = this.mount(el.createDiv({ cls: "qq-auto-view" }), ctx, undefined, key);
      this.autoViews.set(key, view);
    });
    this.registerEvent(this.app.vault.on("create", file => this.scheduleIndex(file)));
    this.registerEvent(this.app.vault.on("modify", file => this.scheduleIndex(file)));
    this.registerEvent(this.app.vault.on("delete", file => {
      this.invalidateViews();
      this.index.remove(file.path);
      if (!(file instanceof TFile)) void this.scan();
      else this.scheduleQueries();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      window.clearTimeout(this.fileTimers.get(oldPath));
      this.fileTimers.delete(oldPath);
      this.index.remove(oldPath);
      if (file instanceof TFile && file.extension !== "md") { this.invalidateViews(); this.scheduleQueries(); }
      else this.scheduleIndex(file);
    }));
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({ id: "reindex-vault", name: "Reindex vault", callback: () => void this.scan() });
    this.addCommand({ id: "refresh-queries", name: "Refresh open questions", callback: () => this.scheduleQueries() });
  }

  private mount(el: HTMLElement, ctx: MarkdownPostProcessorContext, source?: string, autoKey?: string): QueryView {
    const view = new QueryView(this, el, ctx.sourcePath, source, autoKey);
    ctx.addChild(view);
    return view;
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.settings.apiKey = this.app.secretStorage.getSecret("qualitative-query-api-key") ?? "";
  }

  async saveSettings(): Promise<void> {
    const { apiKey, ...stored } = this.settings;
    this.app.secretStorage.setSecret("qualitative-query-api-key", apiKey);
    await this.saveData(stored);
    const exclusions = JSON.stringify(this.exclusions());
    if (exclusions !== this.exclusionKey) {
      this.exclusionKey = exclusions;
      await this.scan();
    } else this.scheduleQueries();
  }

  rebuildClient(): void {
    this.invalidateViews();
    this.engine?.dispose();
    this.batcher?.dispose(); this.batcher = undefined;
    this.clientError = "";
    try {
      if (!this.settings.apiKey.trim()) this.client = null;
      else {
        const client = new JevClient(this.settings.apiKey, this.settings.model);
        this.client = this.settings.passagesPerRequest > 1 ? (this.batcher = new PassageBatcher(client, this.settings.passagesPerRequest)) : client;
      }
    } catch (error) { this.client = null; this.clientError = error instanceof Error ? error.message : String(error); }
    // The batch size is part of the score's identity: a passage judged beside others was asked
    // a differently shaped question, so its score is only reused for that same shape.
    const namespace = `${SCORING_VERSION}:${TYPESAFE_ENDPOINT}:${this.settings.model}${this.client?.batchSize && this.client.batchSize > 1 ? `:batch-${this.client.batchSize}` : ""}`;
    if (this.index) this.engine = new QueryEngine(this.client, () => this.searchableBlocks(), path => readContextBlocks(this.app, path), namespace, this.scoreCache, (question, blocks, limit, signal) => this.retrieval.search(question, blocks, limit, signal));
    this.scheduleQueries();
  }

  private searchableBlocks(): Block[] {
    const source = this.index.blocks;
    if (source !== this.corpusSource) {
      this.corpusSource = source;
      this.corpus = source.filter(block => !QUERY_FENCE.test(block.text));
    }
    return this.corpus;
  }

  private pluginDirectory(): string { return this.manifest?.dir ?? `${this.app.vault.configDir}/plugins/qualitative-query`; }

  embeddingStatus(): string { return this.retrieval.status; }

  restartLocalSearch(): void {
    this.retrieval.restart(); this.invalidateViews(); this.scheduleQueries();
  }

  async restoreEmbeddings(): Promise<void> {
    await this.retrieval.restore();
    if (this.stopped) return;
    this.invalidateViews(); this.scheduleQueries();
  }

  private exclusions(): string[] {
    return [...this.settings.excludedFolders.split(",").map(value => value.trim()).filter(Boolean), this.app.vault.configDir, this.settings.queryFolder, BAKED_FOLDER];
  }

  private inQueryFolder(path: string): boolean {
    const folder = this.settings.queryFolder.replace(/^\/+|\/+$/g, "");
    return Boolean(folder && path.startsWith(`${folder}/`));
  }

  private invalidateViews(): void {
    this.engine?.invalidate();
    for (const view of this.views) view.invalidate();
  }

  private async scan(): Promise<void> {
    if (this.stopped) return;
    this.invalidateViews();
    this.indexError = "";
    try { await this.index.initialScan(); }
    catch { this.indexError = "Some vault files could not be indexed. Run Reindex vault after checking file access."; }
    if (!this.stopped) this.scheduleQueries();
  }

  private scheduleIndex(file: TAbstractFile): void {
    if (this.stopped) return;
    if (file instanceof TFile && file.extension !== "md") return;
    this.invalidateViews();
    if (!(file instanceof TFile)) { void this.scan(); return; }
    if (file.extension !== "md") { this.scheduleQueries(); return; }
    const path = file.path;
    window.clearTimeout(this.fileTimers.get(path));
    const timer = window.setTimeout(() => {
      this.fileTimers.delete(path);
      void this.index.indexFile(file).catch(() => { this.indexError = `Could not index ${path}. Run Reindex vault.`; }).finally(() => this.scheduleQueries());
    }, 250);
    this.fileTimers.set(path, timer);
  }

  private scheduleQueries(): void {
    if (this.stopped) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      for (const view of this.views) void view.refresh();
    }, 300);
  }

  onunload(): void {
    this.stopped = true;
    window.clearTimeout(this.refreshTimer);
    for (const timer of this.fileTimers.values()) window.clearTimeout(timer);
    this.fileTimers.clear();
    this.engine?.dispose();
    this.batcher?.dispose(); this.batcher = undefined;
    this.retrieval?.dispose();
    this.index?.dispose();
    this.corpusSource = undefined; this.corpus = [];
    void this.scoreCache?.close();
    for (const view of [...this.views]) view.unload();
    this.autoViews.clear();
  }
}
