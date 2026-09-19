import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import { MAX_CANDIDATES } from "./limits";
import type QualitativeQueryPlugin from "./main";

export interface Settings { apiKey: string; model: string; queryFolder: string; candidateLimit: number; resultLimit: number; threshold: number; excludedFolders: string; }
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_SETTINGS: Settings = { apiKey: "", model: "jev-1.13.0", queryFolder: "Queries", candidateLimit: 1000, resultLimit: 8, threshold: 0.45, excludedFolders: "" };

/** Whitelist retained settings; discard retired provider, endpoint and model paths. */
export function normalizeSettings(value: unknown): Settings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS };
  for (const key of ["queryFolder", "excludedFolders"] as const) if (typeof data[key] === "string") result[key] = data[key];
  if (typeof data.model === "string" && /^jev-[a-zA-Z0-9.-]+$/.test(data.model)) result.model = data.model;
  for (const key of ["candidateLimit", "resultLimit", "threshold"] as const) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = key === "threshold" ? Math.min(1, Math.max(0, value)) : Math.min(key === "candidateLimit" ? MAX_CANDIDATES : 100, Math.max(1, Math.floor(value)));
  }
  return result;
}

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: QualitativeQueryPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    new Setting(containerEl).setName("Jev API key").setDesc("Jev scores shortlisted passages. The question, candidate passages and explicitly selected context notes are sent to TypeSafe. Without a key, local retrieval remains available. Stored in Obsidian secret storage.").addText((text) => { text.setPlaceholder("ts_").setValue(this.plugin.settings.apiKey); text.inputEl.type = "password"; text.onChange(async (value: string) => { this.plugin.settings.apiKey = value.trim(); await this.plugin.saveSettings(); this.plugin.rebuildClient(); }); });
    new Setting(containerEl).setName("Jev model").addText((text) => text.setValue(this.plugin.settings.model).onChange(async (value) => { this.plugin.settings.model = /^jev-[a-zA-Z0-9.-]+$/.test(value.trim()) ? value.trim() : DEFAULT_SETTINGS.model; await this.plugin.saveSettings(); this.plugin.rebuildClient(); }));
    new Setting(containerEl).setName("Local embeddings").setDesc(this.plugin.embeddingStatus()).addButton(button => button.setButtonText("Download / restore embeddings").onClick(async () => { button.setDisabled(true); try { await this.plugin.restoreEmbeddings(); new Notice("Embedding download ready."); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); } finally { button.setDisabled(false); this.display(); } }));
    new Setting(containerEl).setName("Query folder").setDesc("Folder containing persistent Markdown query notes.").addText((text) => text.setValue(this.plugin.settings.queryFolder).onChange(async (value) => { this.plugin.settings.queryFolder = value.trim() || DEFAULT_SETTINGS.queryFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Candidate limit").setDesc("Up to 1,000 retrieved passages per query, before overlap removal. Larger windows take longer to score with Jev.").addText((text) => text.setValue(String(this.plugin.settings.candidateLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.candidateLimit = Math.min(MAX_CANDIDATES, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_SETTINGS.candidateLimit)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Result limit").addText((text) => text.setValue(String(this.plugin.settings.resultLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.resultLimit = Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.resultLimit)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Relevance threshold").setDesc("Minimum selection score from 0 to 1. Scores are not calibrated accuracy estimates.").addText((text) => text.setValue(String(this.plugin.settings.threshold)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.threshold = Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.threshold)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Excluded folders").setDesc("Comma-separated vault-relative folders.").addText((text) => text.setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); }));
  }
}
