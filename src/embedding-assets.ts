import { requestUrl, type DataAdapter } from "obsidian";
export const EMBEDDING_REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23";
const FILES = {
  "model.safetensors": {
    "bytes": 30236760,
    "sha256": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
  },
  "tokenizer.json": {
    "bytes": 683666,
    "sha256": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"
  },
  "tokenizer_config.json": {
    "bytes": 1431,
    "sha256": "6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567"
  }
} as const;

/** Explicit download only. Requests contain no vault text or Jev credentials. */
export async function downloadEmbeddings(adapter: DataAdapter, directory: string): Promise<void> {
  if (!await adapter.exists(`${directory}/embeddings`)) await adapter.mkdir(`${directory}/embeddings`);
  for (const [name, expected] of Object.entries(FILES)) {
    const response = await requestUrl({ url: `https://huggingface.co/minishlab/potion-base-8M/resolve/${EMBEDDING_REVISION}/${name}`, method: "GET", throw: false });
    if (response.status !== 200 || response.arrayBuffer.byteLength !== expected.bytes) throw new Error(`Embedding download failed: ${name}.`);
    const digest = await crypto.subtle.digest("SHA-256", response.arrayBuffer);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== expected.sha256) throw new Error(`Embedding download checksum failed: ${name}.`);
    const target = `${directory}/embeddings/${name}`;
    await adapter.writeBinary(`${target}.download`, response.arrayBuffer);
    await adapter.rename(`${target}.download`, target);
  }
}
