import esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
const production = process.argv[2] === 'production';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const options = {bundle:true,platform:'browser',target:'es2022',minify:production,sourcemap:production?false:'inline',logLevel:'info'};
const worker = await esbuild.build({...options,entryPoints:['src/embedding-worker.ts'],format:'iife',write:false});
const workerSource = worker.outputFiles[0].text;
await writeFile('dist/embedding-worker.js',workerSource);
const notices = await Promise.all(['LICENSE','NOTICE','node_modules/@huggingface/tokenizers/LICENSE','models/embeddings/MODEL2VEC-LICENSE.txt'].map(name=>readFile(name,'utf8')));
// Store installs receive only main.js, manifest.json, and styles.css.
// Include the worker and licence notices in main.js; model data is an explicit download.
const banner = '/*!\n'+notices.join('\n\n').replace(/\*\//g,'* /')+'\n*/';
await esbuild.build({...options,entryPoints:['src/main.ts'],external:['obsidian'],format:'cjs',outfile:'dist/main.js',define:{EMBEDDING_WORKER_SOURCE:JSON.stringify(workerSource)},banner:{js:banner}});
for (const name of ['manifest.json','styles.css','LICENSE','NOTICE']) await cp(name,`dist/${name}`);
await cp('models/embeddings','dist/embeddings',{recursive:true});
await cp('node_modules/@huggingface/tokenizers/LICENSE','dist/TOKENIZERS-LICENSE.txt');
