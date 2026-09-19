import { TFile, type App } from "obsidian";

export function safeTitle(title: string): string {
  return Array.from(title, char => char.charCodeAt(0) < 32 ? " " : char).join("").replace(/[\\/:*?"<>|#[\]^]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Query";
}

// All callers share one creation queue per vault, including folder preparation.
const creations = new WeakMap<App["vault"], Promise<unknown>>();

/** Create a new note without overwriting existing notes, even during concurrent saves. */
export function createUniqueNote(app: App, folder: string, title: string, text: string): Promise<TFile> {
  const create = async (): Promise<TFile> => {
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        try { await app.vault.createFolder(current); }
        catch (error) {
          // Another writer may create the folder while this operation awaits storage.
          if (!app.vault.getAbstractFileByPath(current)) throw error;
        }
      }
      if (app.vault.getAbstractFileByPath(current) instanceof TFile) throw new Error(`A note already occupies folder path: ${current}`);
    }
    const base = `${folder ? folder + "/" : ""}${safeTitle(title)}`;
    for (let number = 1; ; number++) {
      const path = `${base}${number === 1 ? "" : ` ${number}`}.md`;
      if (app.vault.getAbstractFileByPath(path)) continue;
      try { return await app.vault.create(path, text); }
      catch (error) {
        // Retry only a confirmed collision, never a storage or permission failure.
        if (!app.vault.getAbstractFileByPath(path)) throw error;
      }
    }
  };
  const pending = (creations.get(app.vault) ?? Promise.resolve()).then(create, create);
  creations.set(app.vault, pending);
  const clear = () => { if (creations.get(app.vault) === pending) creations.delete(app.vault); };
  void pending.then(clear, clear);
  return pending;
}
