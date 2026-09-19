import { Tokenizer } from "@huggingface/tokenizers";

/** POTION's published inference: token lookup, mean pooling, L2 normalization. */
export class StaticEmbeddings {
  private readonly values: Float32Array;
  private readonly tokenizer: Tokenizer;
  readonly dimensions: number;
  private readonly rows: number;
  constructor(weights: ArrayBuffer, tokenizer: object, config: object) {
    const view = new DataView(weights);
    const headerSize = Number(view.getBigUint64(0, true));
    if (!Number.isSafeInteger(headerSize) || headerSize < 1 || headerSize > 1_000_000 || headerSize + 8 > weights.byteLength) throw new Error("Invalid embedding model header.");
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(weights, 8, headerSize)));
    const tensor = header.embeddings;
    if (tensor?.dtype !== "F32" || tensor.shape?.length !== 2 || tensor.shape[1] !== 256 || tensor.shape[0] !== 29528 || tensor.data_offsets?.[0] !== 0 || tensor.data_offsets[1] !== tensor.shape[0] * tensor.shape[1] * 4) throw new Error("Unsupported embedding model. Expected pinned POTION-8M weights.");
    this.rows = tensor.shape[0]; this.dimensions = tensor.shape[1];
    const start = 8 + headerSize;
    if (start % 4 || start + tensor.data_offsets[1] !== weights.byteLength) throw new Error("Incomplete embedding model weights.");
    this.values = new Float32Array(weights, start);
    this.tokenizer = new Tokenizer(tokenizer, config);
  }

  encode(text: string): Float32Array {
    const ids = this.tokenizer.encode(text, { add_special_tokens: false }).ids;
    const result = new Float32Array(this.dimensions);
    let count = 0;
    for (const id of ids) {
      // Upstream Model2Vec omits the unknown token (id 1 in the pinned tokenizer).
      if (id === 1 || id < 0 || id >= this.rows) continue;
      const offset = id * this.dimensions;
      for (let j = 0; j < this.dimensions; j++) result[j] += this.values[offset + j];
      count++;
    }
    if (!count) return result;
    let norm = 0;
    for (let j = 0; j < result.length; j++) { result[j] /= count; norm += result[j] ** 2; }
    norm = Math.sqrt(norm);
    if (norm) for (let j = 0; j < result.length; j++) result[j] /= norm;
    return result;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}
