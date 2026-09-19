import { Notice, PluginSettingTab, Setting, type App, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
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
  getSettingDefinitions(): SettingDefinitionItem[] { return this.definitions(); }
  private definitions(): Array<Omit<SettingDefinitionRender, "render"> & { render: (setting: Setting) => void }> {
    return [
      { name: "Jev API key", desc: "Jev selects passages that answer your question. Sends your question, shortlisted passages, and chosen context notes to TypeSafe. API charges may apply. Without a key, search stays local. The key uses Obsidian secret storage.", render: setting => { setting.addText((text) => { text.setPlaceholder("ts_").setValue(this.plugin.settings.apiKey); text.inputEl.type = "password"; text.onChange(async (value: string) => { this.plugin.settings.apiKey = value.trim(); await this.plugin.saveSettings(); this.plugin.rebuildClient(); }); }); } },
      { name: "Jev model", desc: "Model used to score passages. Keep the default unless TypeSafe recommends another.", render: setting => { setting.addText((text) => text.setValue(this.plugin.settings.model).onChange(async (value) => { this.plugin.settings.model = /^jev-[a-zA-Z0-9.-]+$/.test(value.trim()) ? value.trim() : DEFAULT_SETTINGS.model; await this.plugin.saveSettings(); this.plugin.rebuildClient(); })); } },
      { name: "Search by meaning", desc: "Optional local model finds related wording alongside keyword matches. " + this.plugin.embeddingStatus(), render: setting => { setting.addButton(button => button.setButtonText("Download search model").onClick(async () => { button.setDisabled(true); try { await this.plugin.restoreEmbeddings(); new Notice("Search model downloaded. Open a question to use it."); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); } finally { button.setDisabled(false); this.renderSettings(); } })); } },
      { name: "Questions folder", desc: "Where saved questions live. Results update when you open them or edit source notes.", render: setting => { setting.addText((text) => text.setValue(this.plugin.settings.queryFolder).onChange(async (value) => { this.plugin.settings.queryFolder = value.trim() || DEFAULT_SETTINGS.queryFolder; await this.plugin.saveSettings(); })); } },
      { name: "Passages to check", desc: "Maximum passages shortlisted for each question, up to 1,000. Jev checks this shortlist. Higher limits take longer and can cost more.", render: setting => { setting.addText((text) => text.setValue(String(this.plugin.settings.candidateLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.candidateLimit = Math.min(MAX_CANDIDATES, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_SETTINGS.candidateLimit)); await this.plugin.saveSettings(); })); } },
      { name: "Passages to show", desc: "Maximum results when the saved question does not specify a limit.", render: setting => { setting.addText((text) => text.setValue(String(this.plugin.settings.resultLimit)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.resultLimit = Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.resultLimit)); await this.plugin.saveSettings(); })); } },
      { name: "Minimum Jev score", desc: "From 0 to 1. Raise it for fewer matches or lower it for more. A score is not a probability of correctness. Saved questions can override this.", render: setting => { setting.addText((text) => text.setValue(String(this.plugin.settings.threshold)).onChange(async (value) => { const parsed = Number(value); this.plugin.settings.threshold = Math.min(1, Math.max(0, Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.threshold)); await this.plugin.saveSettings(); })); } },
      { name: "Skip folders", desc: "Folder paths separated by commas. Questions, saved selections, and the vault settings folder are always skipped.", render: setting => { setting.addText((text) => text.setValue(this.plugin.settings.excludedFolders).onChange(async (value) => { this.plugin.settings.excludedFolders = value; await this.plugin.saveSettings(); })); } },
    ];
  }
  // Obsidian 1.11–1.12 requires display(); newer versions can search these same definitions.
  display(): void { this.renderSettings(); }
  private renderSettings(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("p", { text: "Ask your vault a question. Connect the passages that answer it." });
    for (const definition of this.definitions()) {
      const setting = new Setting(containerEl).setName(definition.name).setDesc(definition.desc ?? "");
      definition.render(setting);
    }
  }
}
