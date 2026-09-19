import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({ test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup.ts"] }, resolve: { alias: { obsidian: resolve(import.meta.dirname, "tests/obsidian-stub.ts") } } });
