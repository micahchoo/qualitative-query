import { parseYaml, type App, type TFile } from "obsidian";
import type { QueryCriteria, QuerySpec } from "./types";

function scalar(value: string): string | number | boolean | string[] {
  const clean = value.trim();
  if (clean === "true" || clean === "false") return clean === "true";
  if (/^-?\d+(\.\d+)?$/.test(clean)) return Number(clean);
  if (clean.startsWith("[[") || clean.startsWith("![[")) return clean;
  if (clean.startsWith("[") && clean.endsWith("]")) return clean.slice(1, -1).split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return clean.replace(/^['"]|['"]$/g, "");
}
function frontmatter(text: string): Record<string, string | number | boolean | string[]> {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4); if (end < 0) throw new Error("Invalid query frontmatter: closing delimiter is missing.");
  try {
    const parsed: unknown = parseYaml(text.slice(4, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Frontmatter must be a YAML object.");
    return parsed as Record<string, string | number | boolean | string[]>;
  } catch (error) { throw new Error(`Invalid query frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
}

function links(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(links);
  if (typeof value !== "string") return [];
  return [...value.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
}

export function parseQuery(path: string, text: string, folder: string, blockSource?: string): QuerySpec {
  const fm = frontmatter(text);
  const code = blockSource ?? text.match(/```(?:qualitative-query|qq)\s*\n([\s\S]*?)```/i)?.[1] ?? "";
  const fields: Record<string, string | number | boolean | string[]> = { ...fm };
  for (const line of code.split("\n")) { const m = line.match(/^([\w-]+):\s*(.*)$/); if (m) fields[m[1]] = scalar(m[2]); }
  const title = path.split("/").at(-1)!.replace(/\.md$/i, "");
  const hasFields = /^\s*[\w-]+\s*:/m.test(code);
  const question = typeof fields.question === "string" && fields.question.trim() ? fields.question.trim() : (!hasFields && code.trim() ? code.trim() : title);
  const explicitMode = fields.criteria === "generic" || fields.mode === "generic" ? "generic" : fields.criteria === "default" || fields.criteria === "definition" || fields.mode === "default" || fields.mode === "definition" ? "default" : undefined;
  const authoredRubric = [fields.instructions, fields.true, fields.false].some((value) => typeof value === "string" && value.trim());
  const definitionQuestion = /\b(?:what\s+(?:defines|is)|define)\b/i.test(question);
  const criteria: QueryCriteria = { mode: explicitMode ?? (authoredRubric || !definitionQuestion ? "generic" : "default") };
  if (typeof fields.instructions === "string") criteria.instructions = fields.instructions;
  if (typeof fields.true === "string") criteria.true = fields.true;
  if (typeof fields.false === "string") criteria.false = fields.false;
  return {
    question, folder, contextPaths: links(fields.context ?? fields.contexts), criteria,
    limit: validatedNumber(fields.limit, "limit", 1, 100),
    threshold: validatedNumber(fields.threshold, "threshold", 0, 1),
    adjacent: validatedNumber(fields.adjacent, "adjacent", 0, 5) ?? 0,
  };
}

function validatedNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

export function resolveContext(app: App, queryFile: TFile, paths: string[]): Set<string> {
  const result = new Set<string>();
  const unresolved: string[] = [];
  for (const path of paths) {
    const file = app.metadataCache.getFirstLinkpathDest(path, queryFile.path);
    if (file) result.add(file.path); else unresolved.push(path);
  }
  if (unresolved.length) throw new Error(`Context note${unresolved.length > 1 ? "s" : ""} not found: ${unresolved.join(", ")}`);
  return result;
}
