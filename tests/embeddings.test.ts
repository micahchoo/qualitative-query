import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StaticEmbeddings, cosine } from "../src/static-embeddings";
import { hybridShortlist } from "../src/search";
import { parseMarkdown } from "../src/markdown";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/embedding-reference.json", import.meta.url), "utf8"));
const root = new URL("../models/embeddings/", import.meta.url);
function model() {
  const data = readFileSync(new URL("model.safetensors", root));
  return new StaticEmbeddings(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), JSON.parse(readFileSync(new URL("tokenizer.json", root), "utf8")), JSON.parse(readFileSync(new URL("tokenizer_config.json", root), "utf8")));
}
describe("downloaded static embeddings", () => {
  it("matches native tokenizer and NumPy mean pooling on real pinned weights", () => {
    const embeddings = model();
    for (const record of fixture) {
      const actual = embeddings.encode(record.text);
      expect(Math.max(...actual.map((value, i) => Math.abs(value - record.embedding[i])))).toBeLessThan(0.000002);
    }
  });
  it("ranks related wording above an unrelated recipe", () => {
    const embeddings = model();
    const query = embeddings.encode("resolving interpersonal conflict");
    expect(cosine(query, embeddings.encode("Mediation helps resolve disputes."))).toBeGreaterThan(cosine(query, embeddings.encode("A recipe for chocolate cake.")));
  });
  it("rejects truncated weights", () => {
    expect(() => new StaticEmbeddings(new ArrayBuffer(16), {}, {})).toThrow();
  });
});

it("combines semantic-only candidates with strong keyword matches deterministically", () => {
  const blocks = [...parseMarkdown("a.md", "Ochin community work."), ...parseMarkdown("b.md", "Neighbourhood collaboration."), ...parseMarkdown("c.md", "A cake recipe.")];
  const hits = [{id:blocks[1].id, score:0.8}];
  const result = hybridShortlist("Ochin", blocks, hits, 2);
  expect(result.map(row => row.path)).toEqual(["a.md", "b.md"]);
  expect(hybridShortlist("Ochin", blocks, hits, 2)).toEqual(result);
});
