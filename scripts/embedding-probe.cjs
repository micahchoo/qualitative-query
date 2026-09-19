// Run with Electron and a display (or xvfb-run). All inputs and assets stay local.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { build } = require('esbuild');
const project = path.resolve(__dirname, '..');
const output = process.env.QQ_PROBE_DIR || '/tmp/qq-embedding-probe';
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.whenReady().then(async () => {
  await build({ stdin: { contents: `import { EmbeddingIndex } from './src/embeddings'; globalThis.EmbeddingIndex=EmbeddingIndex;`, resolveDir: project }, bundle:true, platform:'browser', format:'iife', outfile:path.join(output,'client.js') });
  const html = `<!doctype html><script src="client.js"></script><script>
  const {ipcRenderer}=require('electron'),fs=require('node:fs/promises');
  const root=${JSON.stringify(project)};
  const read=async name=>{const b=await fs.readFile(root+'/dist/embeddings/'+name);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
  const index=new EmbeddingIndex({read,readWorker:()=>fs.readFile(root+'/dist/embedding-worker.js','utf8')});
  const block=(id,text)=>({id,path:id+'.md',text,searchText:text,lineStart:1,lineEnd:1,kind:'paragraph',headingPath:[]});
  const assert=(value,message)=>{if(!value)throw Error(message)};
  (async()=>{
   let maxGap=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},10);
   const start=performance.now();
   let blocks=[block('mediation','Mediation helps resolve disputes.'),block('cake','The recipe calls for flour, butter and sugar.')];
   const first=await index.search('resolving interpersonal conflict',blocks,5);
   assert(first[0].id==='mediation','Semantic relevance failed');
   const coldMs=performance.now()-start;
   blocks=[block('mediation','An oven bakes chocolate cake.'),blocks[1]];
   await index.search('chocolate cake',blocks,5);
   blocks=[blocks[1]];
   assert((await index.search('chocolate cake',blocks,5)).every(hit=>hit.id!=='mediation'),'Deleted passage retained');
   blocks=Array.from({length:5000},(_,i)=>block('p'+i,i%2?'Mediation resolves disagreements through discussion and shared agreements.':'A recipe for a rich chocolate cake uses butter, flour and sugar.'));
   const indexingStart=performance.now();await index.search('resolving disagreements',blocks,12);const indexingMs=performance.now()-indexingStart;
   const warmStart=performance.now();const results=await Promise.all([index.search('resolving disagreements',blocks,12),index.search('baking cake',blocks,12)]);const warmMs=performance.now()-warmStart;
   assert(results[0].every(hit=>Number(hit.id.slice(1))%2===1),'First concurrent query mismatch');
   assert(results[1].every(hit=>Number(hit.id.slice(1))%2===0),'Second concurrent query mismatch');
   clearInterval(timer);index.dispose();ipcRenderer.send('result',{success:true,coldMs,indexingMs,warmTwoQueriesMs:warmMs,maxHeartbeatGapMs:maxGap,blocks:5000});
  })().catch(error=>{index.dispose();ipcRenderer.send('result',{success:false,error:String(error),stack:error.stack})});
  </script>`;
  fs.writeFileSync(path.join(output,'index.html'),html);
  ipcMain.on('result',(_,result)=>{console.log(JSON.stringify(result));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));app.exit(result.success?0:1)});
  const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,nodeIntegrationInWorker:true,contextIsolation:false,sandbox:false}});
  await win.loadFile(path.join(output,'index.html'));
  setTimeout(()=>{console.error('Probe timed out');app.exit(2)},60000);
});
