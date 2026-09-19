import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function checkVersions(manifest,pkg,lock,versions,tag) {
  if(!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Version must be bare semver.');
  if(pkg.version!==manifest.version || lock.version!==manifest.version || lock.packages[''].version!==manifest.version) throw Error('Package and manifest versions disagree.');
  if(versions[manifest.version]!==manifest.minAppVersion) throw Error('versions.json does not match minAppVersion.');
  if(tag && tag!==manifest.version) throw Error('Release tag does not match manifest.version.');
  if(!manifest.author.trim()) throw Error('Set manifest.author before release.');
}
export function checkAssetMap(files,model) {
  const required=['main.js','manifest.json','styles.css','embedding-worker.js','LICENSE','NOTICE','TOKENIZERS-LICENSE.txt','embeddings/manifest.json','embeddings/MODEL2VEC-LICENSE.txt',...Object.keys(model.files).map(n=>`embeddings/${n}`)];
  for(const name of required) if(!files.get(name)?.length) throw Error(`Missing release asset: ${name}`);
  for(const name of files.keys()) if(!required.includes(name)) throw Error(`Unexpected release asset: ${name}`);
  for(const [name,expected] of Object.entries(model.files)) {
    const data=files.get(`embeddings/${name}`);
    if(data.length!==expected.bytes||sha256(data)!==expected.sha256) throw Error(`Embedding checksum mismatch: ${name}`);
  }
}
export async function readTree(directory,prefix='') {
  const files=new Map();
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.isSymbolicLink()) throw Error(`Symlink in release: ${entry.name}`);
    const relative=prefix+entry.name;
    if(entry.isDirectory()) for(const [name,data] of await readTree(`${directory}/${entry.name}`,`${relative}/`))files.set(name,data);
    else files.set(relative,await readFile(`${directory}/${entry.name}`));
  }
  return files;
}
export async function checkRelease(tag) {
  const json=async path=>JSON.parse(await readFile(path,'utf8'));
  const manifest=await json('manifest.json');
  checkVersions(manifest,await json('package.json'),await json('package-lock.json'),await json('versions.json'),tag);
  const model=await json('models/embeddings/manifest.json');
  const files=await readTree('dist');
  checkAssetMap(files,model);
  if(files.get('manifest.json').toString()!==await readFile('manifest.json','utf8'))throw Error('Built manifest differs from source. Rebuild.');
  if(files.get('embeddings/manifest.json').toString()!==await readFile('models/embeddings/manifest.json','utf8'))throw Error('Built model manifest differs from source.');
  for(const name of ['LICENSE','NOTICE'])if(files.get(name).toString()!==await readFile(name,'utf8'))throw Error(`Built ${name} differs from source.`);
  console.log(`Release checked: ${manifest.version}, ${files.size} files, pinned embedding hashes match.`);
  return {manifest,files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkRelease(process.argv[2]);
