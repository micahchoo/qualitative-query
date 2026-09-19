// Electron probe: populate one million synthetic scores, then run again with QQ_CACHE_PHASE=verify.
const {app,BrowserWindow,ipcMain,protocol,net}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {build}=require('esbuild');
const output=process.env.QQ_CACHE_DIR||'/tmp/qq-million-cache';
const phase=process.env.QQ_CACHE_PHASE||'seed';
const project=path.resolve(__dirname,'..');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(output,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{secure:true,standard:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 await build({stdin:{contents:`import { ScoreCache } from './src/score-cache'; globalThis.ScoreCache=ScoreCache;`,resolveDir:project},bundle:true,platform:'browser',format:'iife',outfile:path.join(output,'cache.js')});
 const nameFile=path.join(output,'database.txt');
 const name=phase==='seed'?'million-cache-'+Date.now():fs.readFileSync(nameFile,'utf8');
 if(phase==='seed')fs.writeFileSync(nameFile,name);
 const html=`<!doctype html><script src="cache.js"></script><script>
 const {ipcRenderer}=require('electron');
 const name=${JSON.stringify(name)},phase=${JSON.stringify(phase)};
 const assert=(x,message)=>{if(!x)throw Error(message)};
 const value={score:0.9,contribution:'other',scores:{relevant:0.9}};
 const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 const commit=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
 const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
 const errorList=[];
 const cache=()=>new ScoreCache({read:async()=>null},{databaseName:name,onError:e=>errorList.push(String(e))});
 (async()=>{
  let last=performance.now(),gap=0;const beat=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now},16);
  const start=performance.now();
  if(phase==='seed'){
   const c=cache();await c.set('retained-first-query',value);await c.close();
   const db=await request(indexedDB.open(name,1));
   for(let first=1;first<1000000;first+=2000){
    const tx=db.transaction(['scores','meta'],'readwrite');const done=commit(tx);const scores=tx.objectStore('scores');const end=Math.min(first+2000,1000000);
    for(let i=first;i<end;i++)scores.put({hash:i.toString(16).padStart(64,'0'),value,accessed:i+10});
    tx.objectStore('meta').put({count:end,clock:end+10},'state');await done;
    if(end%100000<2000)ipcRenderer.send('progress',{records:end});
   }
   db.close();
   const restored=cache();const readStart=performance.now();assert((await restored.get('retained-first-query')).score===.9,'First score evicted before cap');const readMs=performance.now()-readStart;
   await restored.set('overflow-query',{...value,score:.8});await restored.close();
   clearInterval(beat);ipcRenderer.send('result',{success:true,phase,records:1000000,seconds:(performance.now()-start)/1000,readMs,maxHeartbeatGapMs:gap,errors:errorList});
  }else{
   const c=cache();assert((await c.get('retained-first-query')).score===.9,'Retained score missing after application restart');assert((await c.get('overflow-query')).score===.8,'New score missing after application restart');await c.close();
   const db=await request(indexedDB.open(name,1));const tx=db.transaction('scores','readonly');const done=commit(tx);const store=tx.objectStore('scores');
   const countPromise=request(store.count()),evictedPromise=request(store.get('1'.padStart(64,'0')));
   const count=await countPromise;const evicted=await evictedPromise;await done;db.close();
   assert(count===1000000,'Cache capacity incorrect');assert(!evicted,'Oldest entry was not evicted');assert(!errorList.length,'Cache reported errors');
   clearInterval(beat);ipcRenderer.send('result',{success:true,phase,records:count,restartReadMs:performance.now()-start,errors:errorList});
  }
 })().catch(e=>ipcRenderer.send('result',{success:false,error:String(e),stack:e.stack,errors:errorList}));
 </script>`;
 fs.writeFileSync(path.join(output,'index.html'),html);
 protocol.handle('app',request=>net.fetch(pathToFileURL(path.join(output,path.basename(new URL(request.url).pathname))).toString()));
 ipcMain.on('progress',(_,x)=>console.log(JSON.stringify(x)));
 ipcMain.on('result',(_,x)=>{console.log(JSON.stringify(x));fs.writeFileSync(path.join(output,phase+'-result.json'),JSON.stringify(x,null,2));app.exit(x.success?0:1)});
 const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
 await win.loadURL('app://qq-cache/index.html');
 setTimeout(()=>{console.error('Cache probe timed out');app.exit(2)},300000);
});
