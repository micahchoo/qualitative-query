import { describe, expect, it } from "vitest";
import { VaultIndex } from "../src/indexer";

type FakeFile = { path: string; extension: string; stat: { mtime: number } };

const file = (path: string, mtime: number): FakeFile => ({ path, extension: "md", stat: { mtime } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function vaultFor(files: FakeFile[], read: (file: FakeFile) => Promise<string> | string) {
  return {
    getMarkdownFiles: () => files,
    cachedRead: read,
    getAbstractFileByPath: (path: string) => files.find((item) => item.path === path) ?? null,
  } as any;
}

describe("vault index", () => {
  it("does not let a deleted file's pending read reappear", async () => {
    const pending = deferred<string>();
    const note = file("a.md", 1);
    const index = new VaultIndex(vaultFor([note], () => pending.promise));
    const indexing = index.indexFile(note as any);
    index.remove("a.md");
    pending.resolve("conflict definition");
    await indexing;
    expect(index.blocks).toEqual([]);
  });

  it("keeps the newer read when an older read resolves later", async () => {
    const oldRead = deferred<string>();
    const oldFile = file("a.md", 1);
    const files = [oldFile];
    const vault = vaultFor(files, (current) => current.stat.mtime === 1 ? oldRead.promise : "new conflict definition");
    const index = new VaultIndex(vault);
    const first = index.indexFile(oldFile as any);
    const newFile = file("a.md", 2);
    files[0] = newFile;
    const second = index.indexFile(newFile as any);
    await second;
    oldRead.resolve("old passage");
    await first;
    expect(index.blocks[0].text).toContain("new conflict");
  });

  it("removes already indexed files when exclusions change", async () => {
    let excluded: string[] = [];
    const note = file("Queries/a.md", 1);
    const index = new VaultIndex(vaultFor([note], () => "conflict definition"), () => excluded);
    await index.indexFile(note as any);
    expect(index.blocks).toHaveLength(1);
    excluded = ["Queries"];
    expect(index.blocks).toEqual([]);
  });

  it("yields between files during an initial scan", async () => {
    const files = [file("a.md", 1), file("b.md", 1)];
    let reads = 0;
    const index = new VaultIndex(vaultFor(files, () => { reads++; return "conflict definition"; }));
    const scan = index.initialScan();
    expect(index.ready).toBe(false);
    await scan;
    expect(reads).toBe(2);
    expect(index.ready).toBe(true);
    expect(index.blocks).toHaveLength(2);
  });
});

it("stops a scan and ignores its pending read after disposal", async () => {
  const pending = deferred<string>();
  let reads = 0;
  const notes = [file("a.md", 1), file("b.md", 1)];
  const index = new VaultIndex(vaultFor(notes, () => { reads++; return pending.promise; }));
  const scan = index.initialScan();
  index.dispose(); pending.resolve("Late passage"); await scan; await index.whenReady();
  await index.initialScan(); await index.indexFile(notes[1] as any);
  expect(reads).toBe(1); expect(index.blocks).toEqual([]); expect(index.ready).toBe(true);
});
it("clears indexed passages and rejects stale individual commits on disposal", async () => {
  const pending = deferred<string>();
  const notes = [file("a.md", 1), file("b.md", 1)];
  const index = new VaultIndex(vaultFor(notes, note => note.path === "a.md" ? "Existing" : pending.promise));
  await index.indexFile(notes[0] as any);
  const indexing = index.indexFile(notes[1] as any);
  index.dispose(); pending.resolve("Late"); await indexing;
  expect(index.blocks).toEqual([]); expect(index.blocksForPath("a.md")).toEqual([]);
});

it("does not repeat a full exclusion census for each reader of the same corpus", async () => {
  const notes = Array.from({ length: 100 }, (_, i) => file(`${i}.md`, 1));
  let exclusionReads = 0;
  const index = new VaultIndex(vaultFor(notes, () => "Passage"), () => { exclusionReads++; return []; });
  for (const note of notes) await index.indexFile(note as any);
  const first = index.blocks;
  exclusionReads = 0;
  for (let i = 0; i < 50; i++) expect(index.blocks).toBe(first);
  expect(exclusionReads).toBe(50);
});

it("refuses a renamed non-Markdown file when a delayed index callback arrives", async () => {
  const note = file("source.md", 1);
  const index = new VaultIndex(vaultFor([note], () => "A source passage."));
  await index.indexFile(note as any);
  const oldPath = note.path;
  note.path = "source.txt"; note.extension = "txt";
  index.remove(oldPath);
  await index.indexFile(note as any);
  expect(index.blocks).toEqual([]);
});

it("reads a corpus containing more source passages than the JS argument limit", async () => {
  const note = file("large.md", 1);
  const source = Array(150_000).fill("Passage.").join("\n\n");
  const index = new VaultIndex(vaultFor([note], () => source));
  await index.indexFile(note as any);
  expect(index.blocks).toHaveLength(150_000);
  expect(index.blocks.at(-1)?.lineStart).toBe(299_999);
  index.dispose();
});
