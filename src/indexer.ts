import type { Vault, TFile } from "obsidian";
import { parseMarkdown } from "./markdown";
import { prepareSearchBlocks } from "./search";
import type { IndexedFile, Block } from "./types";

type Progress = (done: number, total: number) => void;

/** A cooperative, path-versioned vault index. */
export class VaultIndex {
  private files = new Map<string, IndexedFile>();
  private flatBlocks: Block[] = [];
  private blocksDirty = true;
  private pathVersions = new Map<string, number>();
  private scanToken = 0;
  private stopped = false;
  private scanInFlight?: Promise<void>;

  constructor(private readonly vault: Vault, private readonly excluded: () => string[] = () => []) {}

  get ready(): boolean { return !this.scanInFlight; }
  whenReady(): Promise<void> { return this.scanInFlight ?? Promise.resolve(); }
  blocksForPath(path: string): Block[] {
    return this.isExcluded(path) ? [] : this.files.get(path)?.blocks ?? [];
  }

  /** The returned array is replaced on updates, so readers see one snapshot. */
  get blocks(): Block[] {
    this.removeExcludedFiles();
    if (this.blocksDirty) this.rebuildBlocks();
    return this.flatBlocks;
  }

  async indexFile(file: TFile): Promise<void> {
    if (this.stopped) return;
    const path = file.path;
    const version = this.bumpPathVersion(path);
    if (this.isExcluded(path)) {
      this.files.delete(path);
      this.blocksDirty = true;
      return;
    }
    const mtime = file.stat.mtime;
    const source = await this.vault.cachedRead(file);
    if (this.stopped || version !== this.pathVersions.get(path) || this.isExcluded(path) || !this.fileIsCurrent(file, path, mtime)) return;
    const blocks = parseMarkdown(path, source);
    prepareSearchBlocks(blocks);
    if (this.stopped || version !== this.pathVersions.get(path) || this.isExcluded(path) || !this.fileIsCurrent(file, path, mtime)) return;
    this.files.set(path, { path, mtime, blocks });
    this.blocksDirty = true;
  }

  remove(path: string): void {
    if (this.stopped) return;
    this.bumpPathVersion(path);
    if (this.files.delete(path)) this.blocksDirty = true;
  }

  refreshExclusions(): void { this.removeExcludedFiles(); }

  initialScan(onProgress?: Progress): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const token = ++this.scanToken;
    const work = this.scan(token, onProgress);
    const completion = work.finally(() => {
      if (this.scanInFlight === completion) this.scanInFlight = undefined;
    });
    this.scanInFlight = completion;
    return completion;
  }

  /** Pending storage reads may settle, but cannot add data or start another read. */
  dispose(): void {
    this.stopped = true;
    this.scanToken++;
    this.files.clear(); this.pathVersions.clear();
    this.flatBlocks = []; this.blocksDirty = false;
  }

  private async scan(token: number, onProgress?: Progress): Promise<void> {
    const files = this.vault.getMarkdownFiles().filter((file) => !this.isExcluded(file.path));
    const paths = new Set(files.map((file) => file.path));
    for (const path of [...this.files.keys()]) {
      if (!paths.has(path) || this.isExcluded(path)) {
        this.bumpPathVersion(path);
        this.files.delete(path);
      }
    }
    this.blocksDirty = true;
    for (let i = 0; i < files.length; i++) {
      if (token !== this.scanToken) return;
      await this.indexFile(files[i]);
      if (token !== this.scanToken) return;
      onProgress?.(i + 1, files.length);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (token !== this.scanToken) return;
    const current = new Set(this.vault.getMarkdownFiles().map((file) => file.path));
    for (const path of [...this.files.keys()]) {
      if (!current.has(path) || this.isExcluded(path)) {
        this.bumpPathVersion(path);
        this.files.delete(path);
      }
    }
    this.blocksDirty = true;
  }

  private bumpPathVersion(path: string): number {
    const version = (this.pathVersions.get(path) ?? 0) + 1;
    this.pathVersions.set(path, version);
    return version;
  }

  private fileIsCurrent(file: TFile, path: string, mtime: number): boolean {
    if (file.path !== path || file.stat.mtime !== mtime) return false;
    const getByPath = (this.vault as Vault & { getAbstractFileByPath?: (path: string) => unknown }).getAbstractFileByPath;
    if (!getByPath) return true;
    const current = getByPath.call(this.vault, path) as Partial<TFile> | null;
    return current === file || (!!current && current.path === path && current.stat?.mtime === mtime);
  }

  private removeExcludedFiles(): void {
    let changed = false;
    for (const path of [...this.files.keys()]) {
      if (!this.isExcluded(path)) continue;
      this.bumpPathVersion(path);
      this.files.delete(path);
      changed = true;
    }
    if (changed) this.blocksDirty = true;
  }

  private rebuildBlocks(): void {
    this.flatBlocks = [];
    for (const file of this.files.values()) this.flatBlocks.push(...file.blocks);
    this.blocksDirty = false;
  }

  private isExcluded(path: string): boolean {
    return this.excluded().some((prefix) => {
      const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
      return normalized && (path === normalized || path.startsWith(`${normalized}/`));
    });
  }
}
