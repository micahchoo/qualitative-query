import { TFile, type App } from "obsidian";
import type { Block, QueryResult, QuerySpec } from "./types";

export const BAKED_FOLDER = "Baked queries";
export function safeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|#\[\]^\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Query";
}

/** Validate every range before editing. Edits are applied bottom-up to preserve offsets. */
export function planBlockIds(source: string, blocks: Block[], makeId = () => `qq-${crypto.randomUUID()}`): { text: string; ids: Map<string, string> } {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const ids = new Map<string, string>();
  const edits: Array<{line: number; insert?: string[]; append?: string}> = [];
  const used = new Set([...source.matchAll(/\^([A-Za-z0-9-]+)\b/g)].map(m=>m[1]));
  const ranges: Block[] = [];
  for (const block of blocks) {
    if (ids.has(block.id)) continue;
    if (block.kind === "heading" || block.kind === "yaml") throw new Error("Headings and frontmatter cannot be saved as passage embeds. Use passage results instead.");
    if (ranges.some(b=>b.lineStart<=block.lineEnd && block.lineStart<=b.lineEnd)) throw new Error("These passages overlap. Refresh the question before saving.");
    ranges.push(block);
    const start = block.lineStart - 1, end = block.lineEnd - 1;
    if (start < 0 || end >= lines.length || lines.slice(start,end+1).join("\n") !== block.text.replace(/\r\n/g,"\n")) {
      throw new Error(`Source changed: ${block.path}. Refresh the query before saving passages.`);
    }
    const inlineLine = block.kind === "list" ? start : end;
    let id = (block.kind === "paragraph" || block.kind === "list") ? lines[inlineLine].match(/\s\^([A-Za-z0-9-]+)\s*$/)?.[1] : undefined;
    if (!id && block.kind !== "list") {
      let after = end + 1;
      while (after < lines.length && !lines[after].trim()) after++;
      id = lines[after]?.match(/^\^([A-Za-z0-9-]+)\s*$/)?.[1];
    }
    if (!id) {
      id = makeId();
      if (!/^[A-Za-z0-9-]+$/.test(id) || used.has(id)) throw new Error("Could not allocate a unique block ID. Try baking again.");
      used.add(id);
      if (block.kind === "paragraph" || block.kind === "list") edits.push({line:inlineLine,append:` ^${id}`});
      else edits.push({line:end,insert:["",`^${id}`,""]});
    }
    ids.set(block.id,id);
  }
  for (const edit of edits.sort((a,b)=>b.line-a.line)) {
    if (edit.append) lines[edit.line] += edit.append;
    if (edit.insert) lines.splice(edit.line+1,0,...edit.insert);
  }
  return {text:lines.join(eol),ids};
}

export async function createUniqueNote(app: App, folder: string, title: string, text: string): Promise<TFile> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
  const base = `${folder ? folder + "/" : ""}${safeTitle(title)}`;
  let path = `${base}.md`, n = 2;
  while (app.vault.getAbstractFileByPath(path)) path = `${base} ${n++}.md`;
  return app.vault.create(path,text);
}

export async function bakeNote(app: App, result: QueryResult, spec: QuerySpec, queryPath: string): Promise<TFile> {
  if (!result.judgements.length) throw new Error("No passages to save. Open a question and wait for results.");
  const grouped = new Map<string, Block[]>();
  for (const {candidate} of result.judgements) grouped.set(candidate.path,[...(grouped.get(candidate.path) ?? []),candidate]);
  const plans: Array<{file:TFile;before:string;after:string;ids:Map<string,string>}> = [];
  for (const [path,blocks] of grouped) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Source note is missing: ${path}`);
    const before = await app.vault.read(file);
    const plan = planBlockIds(before,blocks);
    plans.push({file,before,after:plan.text,ids:plan.ids});
  }
  // Vault.process rechecks the latest contents, avoiding overwriting concurrent edits.
  for (const plan of plans) if (plan.before !== plan.after) await app.vault.process(plan.file, current => {
    if (current !== plan.before) throw new Error(`Source changed: ${plan.file.path}. Refresh before saving passages. Any IDs already added are safe to keep.`);
    return plan.after;
  });
  // Source writes finish before Obsidian's asynchronous Markdown indexing.
  // Do not create/open embeds until the native metadata cache can resolve them.
  const deadline = Date.now() + 15_000;
  while (plans.some(plan => {
    const blocks = app.metadataCache.getFileCache(plan.file)?.blocks;
    return [...plan.ids.values()].some(id => !blocks?.[id]);
  })) {
    if (Date.now() >= deadline) throw new Error("Obsidian is still indexing the source block IDs. Wait a moment, refresh the question, and select Save passages again. No selection note was created.");
    await new Promise(resolve => window.setTimeout(resolve, 50));
  }
  const outputPath = `${BAKED_FOLDER}/note.md`;
  const embeds = result.judgements.map(({candidate}) => {
    const plan = plans.find(p=>p.file.path===candidate.path)!;
    return "!" + app.fileManager.generateMarkdownLink(plan.file,outputPath,`#^${plan.ids.get(candidate.id)}`);
  });
  const query = app.vault.getAbstractFileByPath(queryPath);
  const origin = query instanceof TFile ? `[Saved question](${query.path.split("/").map(encodeURIComponent).join("/")})` : queryPath;
  const text = `# ${spec.question.replace(/\r?\n/g," ")}\n\nFrom ${origin} · ${new Date().toISOString()}\n\nThese passages stay in this order. Their text updates when the source notes change.\n\n${embeds.join("\n\n")}\n`;
  return createUniqueNote(app,BAKED_FOLDER,spec.question,text);
}
