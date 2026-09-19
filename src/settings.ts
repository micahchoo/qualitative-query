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
    containerEl.createEl("p", { text: "Ask your vault a question. Connect the passages that answer it." });
    new Setting(containerEl).setName("Jev API key").setDesc("Jev selects passages that answer your question. Sends your question, shortlisted passages, and chosen context notes to TypeSafe. API charges may apply. Without a key, search stays local. The key uses Obsidian secret storage.").addText((text) => { text.setPlaceholder("ts_").setValue(this.plugin.settings.apiKey); text.inputEl.type = "password"; text.onChange(async (value: string) => { this.plugin.settings.apiKey = value.trim(); await this.plugin.saveSettings(); this.plugin.rebuildClient(); }); });
    new Setting(containerEl).setName("Jev model").setDesc("Model used to score passages. Keep the default unless TypeSafe recommends another.").addText((text) => text.setValue(this.plugin.settings.model).onChange(async (value) => { this.plugin.settings.model = /^jev-[a-zA-Z0-9.-]+$/.test(value.trim()) ? value.trim() : DEFAULT_SETTINGS.model; await this.plugin.saveSettings(); this.plugin.rebuildClient(); }));
    new Setting(containerEl).setName("Search by meaning").setDesc("Optional local model finds related wording alongside keyword matches. " + this.plugin.embeddingStatus()).addButton(button => button.setButtonText("Download search model").onClick(async () => { button.setDisabled(true); try { await this.plugin.restoreEmbeddings(); new Notice("Search model downloaded. Open a question to use it."); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); } finally { button.setDisabled(false); this.display(); } }));
    new Setting(containerEl).setName("Questions folder").setDesc("Where saved questions live. Results update when you open them or edit source notes.").addText((text) => text.setValue(this.plugin.settings.queryFolder).onChange(async (value) => { this.plugin.settings.queryFolder = value.trim() || DEFAULT_SETTINGS.queryFolder; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Passages to check").setDesc("Maximum passages shortlisted for each question, up to 1,000. Jev checks this shortlist. Higher limits take longer and can cost more.").addText((text) => text.setValue(String(this.plugin.settings.candidateLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.candidateLimit = Math.min(MAX_CANDIDATES, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_SETTINGS.candidateLimit)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Passages to show").setDesc("Maximum results when the saved question does not specify a limit.").addText((text) => text.setValue(String(this.plugin.settings.resultLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.resultLimit = Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.resultLimit)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Minimum Jev score").setDesc("From 0 to 1. Raise it for fewer matches or lower it for more. A score is not a probability of correctness. Saved questions can override this.").addText((text) => text.setValue(String(this.plugin.settings.threshold)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.threshold = Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.threshold)); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Skip folders").setDesc("Folder paths separated by commas. Questions, saved selections, and the vault settings folder are always skipped.").addText((text) => text.setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); }));
  }
}
