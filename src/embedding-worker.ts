import { record } from "./validation";
import { cosine, StaticEmbeddings } from "./static-embeddings";
let model: StaticEmbeddings | undefined;
const vectors = new Map<string, Float32Array>();
const worker = self as unknown as { onmessage: (event: MessageEvent<unknown>) => void; postMessage: (value: unknown) => void };
worker.onmessage = ({ data }) => {
  if (!record(data) || typeof data.id !== "number") return;
  const { id, type } = data;
  try {
    let result: unknown = null;
    if (type === "load") {
      if (!(data.weights instanceof ArrayBuffer) || !record(data.tokenizer) || !record(data.config)) throw new Error("Invalid model data.");
      model = new StaticEmbeddings(data.weights, data.tokenizer, data.config);
      vectors.clear();
    } else if (!model) throw new Error("Embeddings are not loaded.");
    else if (type === "update") {
      if (!Array.isArray(data.rows)) throw new Error("Invalid passage list.");
      for (const row of data.rows as unknown[]) {
        if (!record(row) || typeof row.id !== "string" || typeof row.text !== "string") throw new Error("Invalid passage.");
        vectors.set(row.id, model.encode(row.text));
      }
    } else if (type === "remove") {
      if (!Array.isArray(data.ids)) throw new Error("Invalid passage IDs.");
      for (const key of data.ids as unknown[]) {
        if (typeof key !== "string") throw new Error("Invalid passage ID.");
        vectors.delete(key);
      }
    } else if (type === "search") {
      if (typeof data.question !== "string" || typeof data.limit !== "number" || !Number.isInteger(data.limit) || data.limit < 1) throw new Error("Invalid search request.");
      const query = model.encode(data.question);
      const best: Array<{ id: string; score: number }> = [];
      for (const [key, vector] of vectors) {
        const score = cosine(query, vector);
        if (score < 0.15) continue;
        const hit = { id: key, score };
        let index = best.findIndex(other => score > other.score || score === other.score && key < other.id);
        if (index < 0) index = best.length;
        if (index < data.limit) { best.splice(index, 0, hit); if (best.length > data.limit) best.pop(); }
      }
      result = best;
    } else throw new Error("Unknown embedding request.");
    worker.postMessage({ id, result });
  } catch (error) { worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
