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
  const closing = /^---[ \t]*$/m.exec(text.slice(4));
  const end = closing ? 4 + closing.index : -1; if (end < 0) throw new Error("Invalid query frontmatter: closing delimiter is missing.");
  try {
    const parsed: unknown = parseYaml(text.slice(4, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Frontmatter must be a YAML object.");
    return parsed as Record<string, string | number | boolean | string[]>;
  } catch (error) { throw new Error(`Invalid query frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
}

function links(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(links);
  if (typeof value !== "string") return [];
  return [...value.matchAll(/!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
}

/** A fenced query block, by its opening fence: the languages this plugin renders. */
export const QUERY_FENCE = /^ {0,3}(?:`{3,}|~{3,})(?:qualitative-query|qq)\s*$/m;

export function parseQuery(path: string, text: string, folder: string, blockSource?: string): QuerySpec {
  text = text.replace(/\r\n?/g, "\n");
  blockSource = blockSource?.replace(/\r\n?/g, "\n");
  const fm = frontmatter(text);
  const code = blockSource ?? text.match(/```(?:qualitative-query|qq)\s*\n([\s\S]*?)```/i)?.[1] ?? "";
  const fields: Record<string, string | number | boolean | string[]> = { ...fm };
  const supported = new Set(["question", "criteria", "mode", "instructions", "true", "false", "limit", "threshold", "adjacent", "context", "contexts"]);
  const entries = code.split("\n").filter(line => line.trim()).map(line => ({ line, match: /^\s*([\w-]+):\s*(.*)$/.exec(line) }));
  const hasFields = entries.some(({ match }) => match && supported.has(match[1]));
  if (hasFields) for (const { line, match } of entries) {
    if (!match) throw new Error(`Invalid query line: ${line}. Use field: value, or write the whole question without fields.`);
    if (!supported.has(match[1])) throw new Error(`Unknown query field: ${match[1]}. Use question, context, limit, threshold, adjacent, mode, instructions, true, or false.`);
    fields[match[1]] = scalar(match[2]);
  }
  for (const name of ["question", "instructions", "true", "false"] as const) {
    if (fields[name] !== undefined && typeof fields[name] !== "string") throw new Error(`${name} must be text.`);
  }
  for (const name of ["mode", "criteria"] as const) {
    if (fields[name] !== undefined && !["generic", "default", "definition"].includes(String(fields[name]))) throw new Error(`${name} must be generic, default, or definition.`);
  }
  const title = path.split("/").at(-1)!.replace(/\.md$/i, "");
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
    limit: validatedNumber(fields.limit, "limit", 1, 100, true),
    threshold: validatedNumber(fields.threshold, "threshold", 0, 1),
    adjacent: validatedNumber(fields.adjacent, "adjacent", 0, 5, true) ?? 0,
  };
}

function validatedNumber(value: unknown, name: string, min: number, max: number, integer = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  if (integer && !Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return value;
}

export function resolveContext(app: App, queryFile: TFile, paths: string[]): Set<string> {
  const result = new Set<string>();
  const unresolved: string[] = [];
  for (const path of paths) {
    const hash = path.indexOf("#");
    const note = hash < 0 ? path : path.slice(0, hash);
    const fragment = hash < 0 ? "" : path.slice(hash);
    const file = note ? app.metadataCache.getFirstLinkpathDest(note, queryFile.path) : queryFile;
    if (file) result.add(file.path + fragment); else unresolved.push(path);
  }
  if (unresolved.length) throw new Error(`Context note${unresolved.length > 1 ? "s" : ""} not found: ${unresolved.join(", ")}`);
  return result;
}
