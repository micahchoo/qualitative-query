import {mkdir,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {checkRelease,sha256} from './check-release.mjs';
const {manifest,files}=await checkRelease(process.env.RELEASE_TAG);
await rm('release',{recursive:true,force:true});await mkdir('release');
const zipName=`${manifest.id}-${manifest.version}.zip`;
// A fixed ZIP timestamp and sorted paths make identical assets produce identical archives.
execFileSync('python3',['-c',`
import sys,zipfile,pathlib,hashlib
root=pathlib.Path('dist')
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for path in sorted(root.rglob('*')):
  if path.is_file():
   info=zipfile.ZipInfo(path.relative_to(root).as_posix(),(1980,1,1,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   info.external_attr=0o100644<<16
   archive.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
with zipfile.ZipFile(sys.argv[1]) as archive:
 assert archive.testzip() is None
 for name in archive.namelist():
  assert archive.read(name)==(root/name).read_bytes(),name
`, `release/${zipName}`],{stdio:'inherit'});
const {readFile}=await import('node:fs/promises');
await writeFile('release/SHA256SUMS',`${sha256(await readFile(`release/${zipName}`))}  ${zipName}\n`);
await writeFile('release/INSTALLATION.json',JSON.stringify({version:manifest.version,installation:'Optional offline ZIP; store installations use main.js, manifest.json, styles.css and explicitly download model data in settings',files:Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>[name,{bytes:data.length,sha256:sha256(data)}]))},null,2)+'\n');
console.log(`Packaged and read back every file: release/${zipName}`);

for (const name of ['main.js','manifest.json','styles.css']) await writeFile(`release/${name}`,files.get(name));
const assets=[zipName,'main.js','manifest.json','styles.css','INSTALLATION.json'];
await writeFile('release/SHA256SUMS',(await Promise.all(assets.map(async name=>`${sha256(await readFile(`release/${name}`))}  ${name}`))).join('\n')+'\n');
