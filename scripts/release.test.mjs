import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkAssetMap,checkVersions,sha256} from './check-release.mjs';
const manifest={version:'1.2.3',minAppVersion:'1.11.4',author:'Author'};
const lock={version:'1.2.3',packages:{'':{version:'1.2.3'}}};
test('rejects wrong tags, package versions, and missing compatibility entries',()=>{
 assert.doesNotThrow(()=>checkVersions(manifest,manifest,lock,{'1.2.3':'1.11.4'},'1.2.3'));
 for(const tag of ['v1.2.3','1.2.4'])assert.throws(()=>checkVersions(manifest,manifest,lock,{'1.2.3':'1.11.4'},tag));
 assert.throws(()=>checkVersions(manifest,{version:'1.2.4'},lock,{'1.2.3':'1.11.4'}));
 assert.throws(()=>checkVersions(manifest,manifest,lock,{}));
});
function fixture(){
 const weight=Buffer.from('test weights');
 const model={files:{'model.safetensors':{bytes:weight.length,sha256:sha256(weight)}}};
 const files=new Map(['main.js','manifest.json','styles.css','embedding-worker.js','LICENSE','NOTICE','TOKENIZERS-LICENSE.txt','embeddings/manifest.json','embeddings/MODEL2VEC-LICENSE.txt'].map(n=>[n,Buffer.from('fixture')]));
 files.set('embeddings/model.safetensors',weight);return {files,model};
}
test('requires the worker, model, and licence notices',()=>{
 for(const missing of ['embedding-worker.js','embeddings/model.safetensors','NOTICE','TOKENIZERS-LICENSE.txt']){
  const {files,model}=fixture();files.delete(missing);assert.throws(()=>checkAssetMap(files,model),/Missing/);
 }
});
test('rejects modified weights and accidental vault data',()=>{
 let {files,model}=fixture();assert.doesNotThrow(()=>checkAssetMap(files,model));
 files.set('embeddings/model.safetensors',Buffer.from('changed'));assert.throws(()=>checkAssetMap(files,model),/checksum/);
 ({files,model}=fixture());files.set('data.json',Buffer.from('private'));assert.throws(()=>checkAssetMap(files,model),/Unexpected/);
});
