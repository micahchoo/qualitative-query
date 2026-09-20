import { TFile, type App } from "obsidian";
import type { Block } from "./types";

/** Read precisely the note, section, or block explicitly linked as context. */
export async function readContextBlocks(app: App, reference: string): Promise<Block[]> {
  const hash = reference.indexOf("#");
  const path = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 ? "" : reference.slice(hash + 1);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`Context note not found: ${path}`);
  const text = await app.vault.cachedRead(file);
  const lines = text.split(/\r?\n/);
  let start = 0, end = lines.length - 1;
  const cache = app.metadataCache.getFileCache(file);
  if (fragment.startsWith("^")) {
    const block = cache?.blocks?.[fragment.slice(1)];
    if (!block) throw new Error(`Context block not found: ${reference}. Check its block ID or wait for Obsidian to index it.`);
    start = block.position.start.line; end = block.position.end.line;
  } else if (fragment) {
    const headings = cache?.headings ?? [];
    const heading = headings.find(item => item.heading === fragment);
    if (!heading) throw new Error(`Context section not found: ${reference}. Use the exact heading text.`);
    start = heading.position.start.line;
    const next = headings.find(item => item.position.start.line > start && item.level <= heading.level);
    end = next ? next.position.start.line - 1 : end;
  }
  if (start < 0 || end >= lines.length || end < start) throw new Error(`Context changed: ${reference}. Refresh the question.`);
  const selected = fragment ? lines.slice(start, end + 1).join("\n") : text;
  return [{ id: reference, path, lineStart: start + 1, lineEnd: end + 1, text: selected, searchText: selected, kind: "paragraph", headingPath: [] }];
}
