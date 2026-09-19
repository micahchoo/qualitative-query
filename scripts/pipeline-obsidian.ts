/** CLI eval lacks the plugin loader's obsidian module. Native file type comes from the active vault. */
export const TFile = (globalThis as any).app.vault.getMarkdownFiles()[0].constructor;
export function parseYaml(): never { throw new Error('CLI capture currently requires a query without YAML frontmatter.'); }
