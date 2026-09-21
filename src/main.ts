import { readContextBlocks } from "./context";
import { parseObject } from "./validation";
declare const EMBEDDING_WORKER_SOURCE: string;
import { QueryBuilder } from "./builder";
import { BAKED_FOLDER } from "./bake";
import { Notice, Plugin, TFile, type MarkdownPostProcessorContext, type TAbstractFile } from "obsidian";
import { EmbeddingIndex } from "./embeddings";
import { downloadEmbeddings } from "./embedding-assets";
import { LocalRetrieval } from "./retrieval";
import { ScoreCache } from "./score-cache";
import { VaultIndex } from "./indexer";
import { QUERY_FENCE } from "./query";
import { JevClient, type JevRanker } from "./jev";
import { PassageBatcher } from "./batch";
import { QueryEngine } from "./engine";
import { QueryView } from "./query-view";
import { DEFAULT_SETTINGS, SettingsTab, normalizeSettings, type Settings } from "./settings";
import { scoreNamespace } from "./score-identity";
import type { Block } from "./types";

export default class QualitativeQueryPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  index!: VaultIndex;
  engine!: QueryEngine;
  client: JevRanker | null = null;
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
    const directory = this.pluginDirectory();
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
    const namespace = scoreNamespace(this.settings.model, this.client?.batchSize);
    if (this.index) this.engine = new QueryEngine(this.client, () => this.searchableBlocks(), (question, blocks, limit, signal) => this.retrieval.search(question, blocks, limit, signal), path => readContextBlocks(this.app, path), namespace, this.scoreCache);
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
