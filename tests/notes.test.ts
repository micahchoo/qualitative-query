import { expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import { createUniqueNote } from "../src/notes";

function vaultFixture() {
  const entries = new Map<string, unknown>();
  const create = vi.fn(async (path: string, text: string) => {
    await Promise.resolve();
    if (entries.has(path)) throw new Error("exists");
    const file = Object.assign(new TFile(), { path });
    entries.set(path, { file, text }); return file;
  });
  const app = { vault: {
    getAbstractFileByPath: (path: string) => entries.get(path), create,
    createFolder: vi.fn(async (path: string) => {
      await Promise.resolve();
      if (entries.has(path)) throw new Error("exists");
      entries.set(path, {});
    }),
  } } as unknown as App;
  return { app, entries, create };
}
it("serializes same-title saves including creation of a shared folder", async () => {
  const { app, entries } = vaultFixture();
  const files = await Promise.all([createUniqueNote(app, "Questions", "Example", "first"), createUniqueNote(app, "Questions", "Example", "second")]);
  expect(files.map(file => file.path)).toEqual(["Questions/Example.md", "Questions/Example 2.md"]);
  expect(entries.get(files[0].path)).toMatchObject({ text: "first" });
  expect(entries.get(files[1].path)).toMatchObject({ text: "second" });
});
it("retries a collision caused by an external writer", async () => {
  const { app, create, entries } = vaultFixture();
  create.mockImplementationOnce(async path => { entries.set(path, { text: "external" }); throw new Error("exists"); });
  expect((await createUniqueNote(app, "", "Example", "ours")).path).toBe("Example 2.md");
  expect(entries.get("Example.md")).toEqual({ text: "external" });
});
it("preserves storage errors and allows later saves after failure", async () => {
  const { app, create } = vaultFixture();
  create.mockRejectedValueOnce(new Error("disk full"));
  await expect(createUniqueNote(app, "", "Example", "first")).rejects.toThrow("disk full");
  expect(create).toHaveBeenCalledTimes(1);
  expect((await createUniqueNote(app, "", "Example", "second")).path).toBe("Example.md");
});
