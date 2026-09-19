import type { Block } from "./types";

const atxHeadingPattern = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const setextHeadingPattern = /^ {0,3}(=+|-+)[ \t]*$/;
const fencePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const listPattern = /^(\s*)([-*+] |\d+[.)] )(.*)$/;
const calloutPattern = /^\s*>\s*\[!([^\]]+)\]/i;

interface ListItemStart {
  line: number;
  indent: number;
}

interface ParsedListItem extends ListItemStart {
  end: number;
  parentIndex: number;
}

function indentWidth(value: string): number {
  let width = 0;
  for (const character of value) width += character === "\t" ? 4 : 1;
  return width;
}

function isFenceClose(line: string, marker: string, length: number): boolean {
  const match = line.match(/^( {0,3})(`+|~+)[ \t]*$/);
  return Boolean(match && match[2][0] === marker && match[2].length >= length);
}

function listFence(line: string): { marker: string; length: number } | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})(?:.*)$/);
  return match ? { marker: match[1][0], length: match[1].length } : undefined;
}

function listFenceClose(line: string, marker: string, length: number): boolean {
  const match = line.match(/^\s*(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === marker && match[1].length >= length);
}

function isTableDelimiter(line: string): boolean {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 2 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function hasTablePipe(line: string): boolean {
  let escaped = false;
  for (const character of line) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "|") return true;
  }
  return false;
}

function isTableStart(lines: string[], line: number): boolean {
  return line + 1 < lines.length && hasTablePipe(lines[line]) && isTableDelimiter(lines[line + 1]);
}

function isIndentedContinuation(line: string, rootIndent: number): boolean {
  if (!line.trim()) return true;
  const match = line.match(/^(\s*)\S/);
  return Boolean(match && indentWidth(match[1]) > rootIndent);
}

function isListRunLine(line: string, rootIndent: number): boolean {
  if (!line.trim()) return true;
  const item = line.match(listPattern);
  if (item) return indentWidth(item[1]) >= rootIndent;
  return isIndentedContinuation(line, rootIndent);
}

function listRunEnd(lines: string[], start: number, rootIndent: number): number {
  let end = start + 1;
  while (end < lines.length && isListRunLine(lines[end], rootIndent)) end++;
  while (end > start && !lines[end - 1].trim()) end--;
  return end;
}

function listItems(lines: string[], start: number, end: number): ParsedListItem[] {
  const starts: ListItemStart[] = [];
  let fenced: { marker: string; length: number } | undefined;
  for (let line = start; line < end; line++) {
    const match = lines[line].match(listPattern);
    if (fenced) {
      if (listFenceClose(lines[line], fenced.marker, fenced.length)) fenced = undefined;
      continue;
    }
    if (match) {
      starts.push({ line, indent: indentWidth(match[1]) });
      fenced = listFence(match[3]);
    } else {
      fenced = listFence(lines[line]);
    }
  }

  const stack: number[] = [];
  const nextBoundary = new Array<number>(starts.length).fill(end);
  const rightStack: number[] = [];
  for (let index = starts.length - 1; index >= 0; index--) {
    while (rightStack.length && starts[rightStack[rightStack.length - 1]].indent > starts[index].indent) rightStack.pop();
    if (rightStack.length) nextBoundary[index] = starts[rightStack[rightStack.length - 1]].line;
    rightStack.push(index);
  }

  return starts.map((item, index) => {
    while (stack.length && starts[stack[stack.length - 1]].indent >= item.indent) stack.pop();
    const parentIndex = stack.length ? stack[stack.length - 1] : -1;
    stack.push(index);

    let itemEnd = nextBoundary[index];
    while (itemEnd > item.line + 1 && !lines[itemEnd - 1].trim()) itemEnd--;
    return { ...item, end: itemEnd, parentIndex };
  });
}

/** Parse markdown into deterministic structural units. Never modifies the source file. */
export function parseMarkdown(path: string, source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const headings: string[] = [];
  let sectionId = `${path}:0`;
  let paragraphStart = -1;
  let line = 0;

  const add = (start: number, end: number, kind: Block["kind"], text = lines.slice(start, end + 1).join("\n"), parentId?: string): Block | undefined => {
    if (start > end || !text.trim()) return undefined;
    const block: Block = {
      id: `${path}:${start + 1}-${end + 1}`,
      path,
      lineStart: start + 1,
      lineEnd: end + 1,
      text,
      searchText: text,
      kind,
      headingPath: headings.filter(Boolean),
      parentId,
      sectionId,
    };
    blocks.push(block);
    return block;
  };

  const flushParagraph = (end: number): void => {
    if (paragraphStart >= 0) add(paragraphStart, end, "paragraph");
    paragraphStart = -1;
  };

  const setHeading = (level: number, title: string): void => {
    headings.splice(level - 1);
    headings[level - 1] = title.trim();
  };

  while (line < lines.length) {
    const value = lines[line];
    if (!value.trim()) {
      flushParagraph(line - 1);
      line++;
      continue;
    }

    if (line === 0 && value === "---") {
      const close = lines.slice(1).findIndex((candidate) => candidate === "---" || candidate === "...");
      if (close >= 0) {
        flushParagraph(line - 1);
        add(0, close + 1, "yaml");
        line = close + 2;
        continue;
      }
    }

    const atxHeading = value.match(atxHeadingPattern);
    if (atxHeading) {
      flushParagraph(line - 1);
      const level = atxHeading[2].length;
      setHeading(level, atxHeading[3].replace(/[ \t]+#+[ \t]*$/, "").trim());
      sectionId = `${path}:${line + 1}`;
      line++;
      continue;
    }

    if (line + 1 < lines.length && value.trim() && setextHeadingPattern.test(lines[line + 1])) {
      flushParagraph(line - 1);
      const level = lines[line + 1].trimStart()[0] === "=" ? 1 : 2;
      setHeading(level, value.trim());
      sectionId = `${path}:${line + 1}`;
      line += 2;
      continue;
    }

    const fence = value.match(fencePattern);
    if (fence) {
      flushParagraph(line - 1);
      const marker = fence[2][0];
      const markerLength = fence[2].length;
      let end = line + 1;
      while (end < lines.length && !isFenceClose(lines[end], marker, markerLength)) end++;
      add(line, Math.min(end, lines.length - 1), "fence");
      line = Math.min(end + 1, lines.length);
      continue;
    }

    if (calloutPattern.test(value)) {
      flushParagraph(line - 1);
      let end = line + 1;
      while (end < lines.length && (/^\s*>/.test(lines[end]) || !lines[end].trim())) end++;
      while (end > line + 1 && !lines[end - 1].trim()) end--;
      add(line, end - 1, "callout");
      line = end;
      continue;
    }

    if (isTableStart(lines, line)) {
      flushParagraph(line - 1);
      let end = line + 2;
      while (end < lines.length && lines[end].trim() && hasTablePipe(lines[end])) end++;
      add(line, end - 1, "table");
      line = end;
      continue;
    }

    const list = value.match(listPattern);
    if (list) {
      flushParagraph(line - 1);
      const runEnd = listRunEnd(lines, line, indentWidth(list[1]));
      const items = listItems(lines, line, runEnd);
      const itemIds = items.map((item) => `${path}:${item.line + 1}-${item.end}`);
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        const parentId = item.parentIndex >= 0 ? itemIds[item.parentIndex] : undefined;
        const block = add(item.line, item.end - 1, "list", lines.slice(item.line, item.end).join("\n"), parentId);
        if (!block) continue;

        const ancestors: string[] = [];
        let ancestorIndex = item.parentIndex;
        while (ancestorIndex >= 0) {
          ancestors.unshift(lines[items[ancestorIndex].line]);
          ancestorIndex = items[ancestorIndex].parentIndex;
        }
        block.renderText = [...ancestors, block.text].join("\n");
      }
      line = runEnd;
      continue;
    }

    if (/^\s*>/.test(value)) {
      flushParagraph(line - 1);
      let end = line + 1;
      while (end < lines.length && (/^\s*>/.test(lines[end]) || !lines[end].trim())) end++;
      while (end > line + 1 && !lines[end - 1].trim()) end--;
      add(line, end - 1, "blockquote");
      line = end;
      continue;
    }

    if (paragraphStart < 0) paragraphStart = line;
    line++;
  }
  flushParagraph(lines.length - 1);
  return blocks.filter((block) => block.kind !== "heading" && block.kind !== "yaml");
}

function sameSection(block: Block, other: Block): boolean {
  return block.sectionId === other.sectionId;
}

function isListSibling(block: Block, other: Block): boolean {
  return block.kind === "list" && other.kind === "list" && block.parentId === other.parentId;
}

function displayText(block: Block): string {
  return block.renderText ?? block.text;
}

function outerListUnit(block: Block, blocks: Block[]): Block {
  let current = block;
  while (current.parentId) {
    const parent = blocks.find((candidate) => candidate.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Expand a block with nearby source units, stopping at the current heading section. */
export function expandBlock(block: Block, blocks: Block[], adjacent = 0): Block {
  const count = Number.isFinite(adjacent) ? Math.max(0, Math.floor(adjacent)) : 0;
  if (!count) return block;
  const index = blocks.findIndex((candidate) => candidate.id === block.id);
  if (index < 0) return block;

  const selected: Block[] = [block];
  if (block.kind === "list") {
    const siblings = blocks.filter((candidate) => sameSection(block, candidate) && isListSibling(block, candidate)).sort((a, b) => a.lineStart - b.lineStart);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === block.id);
    for (let offset = 1; offset <= count; offset++) {
      const before = siblingIndex - offset >= 0 ? siblings[siblingIndex - offset] : undefined;
      const after = siblingIndex + offset < siblings.length ? siblings[siblingIndex + offset] : undefined;
      if (before) selected.unshift(before);
      if (after) selected.push(after);
    }
  } else {
    let before = index - 1;
    let after = index + 1;
    for (let offset = 0; offset < count; offset++) {
      while (before >= 0 && (!sameSection(block, blocks[before]) || blocks[before].lineEnd >= block.lineStart)) before--;
      if (before >= 0) {
        const neighbor = outerListUnit(blocks[before], blocks);
        selected.unshift(neighbor);
        const neighborIndex = blocks.findIndex((candidate) => candidate.id === neighbor.id);
        before = neighborIndex - 1;
      }
      while (after < blocks.length && (!sameSection(block, blocks[after]) || blocks[after].lineStart <= block.lineEnd)) after++;
      if (after < blocks.length) {
        const neighbor = outerListUnit(blocks[after], blocks);
        selected.push(neighbor);
        const neighborIndex = blocks.findIndex((candidate) => candidate.id === neighbor.id);
        after = neighborIndex + 1;
        while (after < blocks.length && blocks[after].lineStart <= neighbor.lineEnd) after++;
      }
    }
  }

  const ordered = selected.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  const firstListParent = ordered[0].kind === "list" ? ordered[0].parentId : undefined;
  const text = ordered.map((candidate, candidateIndex) => {
    // Sibling list displays share the same ancestor breadcrumb. Emit it once,
    // then append each sibling's own subtree to avoid duplicate parent lines.
    if (candidateIndex > 0 && candidate.kind === "list" && ordered[0].kind === "list" && candidate.parentId === firstListParent) return candidate.text;
    return displayText(candidate);
  }).join("\n\n");
  return {
    ...block,
    lineStart: Math.min(...ordered.map((candidate) => candidate.lineStart)),
    lineEnd: Math.max(...ordered.map((candidate) => candidate.lineEnd)),
    text,
    renderText: text,
  };
}
