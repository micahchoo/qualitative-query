import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'scripts/**', 'tests/**', '*.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Jev", "TypeSafe", "Qualitative Query", "Obsidian"],
        // Preserve the credential prefix and the established UI spelling for block IDs.
        ignoreRegex: ["^ts_$", "^.*\\bIDs\\b.*$"],
      }],
    },
  },
]);
