import { cosine, StaticEmbeddings } from "./static-embeddings";
let model: StaticEmbeddings | undefined;
const vectors = new Map<string, Float32Array>();
const worker = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (value: unknown) => void };
worker.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    let result: unknown = null;
    if (type === "load") {
      model = new StaticEmbeddings(data.weights, data.tokenizer, data.config);
      vectors.clear();
    } else if (!model) throw new Error("Embeddings are not loaded.");
    else if (type === "update") {
      for (const row of data.rows as Array<{ id: string; text: string }>) vectors.set(row.id, model.encode(row.text));
    } else if (type === "remove") {
      for (const key of data.ids as string[]) vectors.delete(key);
    } else if (type === "search") {
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
