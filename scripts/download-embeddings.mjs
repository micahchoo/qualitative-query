import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('../models/embeddings/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
await mkdir(directory, { recursive: true });
for (const [name, expected] of Object.entries(manifest.files)) {
  const response = await fetch(`https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${name}`);
  if (!response.ok) throw new Error(`Download failed: ${name} (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length !== expected.bytes || createHash('sha256').update(data).digest('hex') !== expected.sha256) throw new Error(`Checksum mismatch: ${name}`);
  await writeFile(new URL(name, directory), data);
  console.log(`Downloaded ${name}: ${data.length} bytes`);
}
