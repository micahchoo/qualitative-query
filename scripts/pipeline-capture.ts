/** Bundle for Obsidian's eval command. Reads only this plugin and the requested notes. */
import { parseQuery, resolveContext } from "../src/query";
import { TFile, type App } from "obsidian";
import type { QueryResult, QuerySpec } from "../src/types";
declare const app: App;
declare const require: (name:string)=>any;

(globalThis as any).captureQualitativePipeline = async (options:{queryPath:string;bakedPath?:string;output:string}) => {
  const plugin=(app as any).plugins.plugins['qualitative-query'];
  if(!plugin)throw Error('Enable Qualitative Query first.');
  const file=app.vault.getAbstractFileByPath(options.queryPath);
  if(!(file instanceof TFile))throw Error('Query note missing.');
  const queryText=await app.vault.read(file);
  if((queryText.match(/```(?:qq|qualitative-query)\b/g)||[]).length!==1)throw Error('Capture requires one query block.');
  const spec=parseQuery(file.path,queryText,plugin.settings.queryFolder);
  spec.contextPaths=[...resolveContext(app,file,spec.contextPaths)];
  await plugin.index.whenReady();
  const startedAt=new Date().toISOString();
  const candidates=await plugin.retrieve(spec.question,plugin.engine.getBlocks(),plugin.settings.candidateLimit);
  // Scoring criteria stay unchanged. Capture every score, not just the display slice.
  const result:QueryResult=await plugin.engine.run({...spec,limit:1000},plugin.settings.candidateLimit,1000,0);
  if(result.selection!=='jev')throw Error('Jev scoring did not complete; no successful capture recorded.');
  const threshold=spec.threshold??plugin.settings.threshold;
  const selected=result.judgements.filter(j=>j.score>=threshold).slice(0,spec.limit??plugin.settings.resultLimit);
  let baked:any=null;
  if(options.bakedPath){
    const bakedFile=app.vault.getAbstractFileByPath(options.bakedPath);
    if(!(bakedFile instanceof TFile))throw Error('Baked note missing.');
    const text=await app.vault.read(bakedFile);
    const refs=[];
    for(const match of text.matchAll(/!\[\[([^\]#]+)#\^([^\]|]+)(?:\|[^\]]+)?\]\]/g)){
      const source=app.metadataCache.getFirstLinkpathDest(match[1],bakedFile.path);
      const block=source&&app.metadataCache.getFileCache(source)?.blocks?.[match[2]];
      const sourceText=source?await app.vault.read(source):'';
      refs.push({link:match[0],path:source?.path,id:match[2],resolved:!!block,
        position:block?.position,text:block?sourceText.slice(block.position.start.offset,block.position.end.offset):null,
        surrounding:block?sourceText.split('\n').slice(Math.max(0,block.position.start.line-3),block.position.end.line+4).join('\n'):null});
    }
    baked={path:bakedFile.path,text,refs};
  }
  const data={startedAt,finishedAt:new Date().toISOString(),vault:app.vault.getName(),pluginVersion:plugin.manifest.version,
    model:plugin.settings.model,queryPath:file.path,queryText,spec,candidateLimit:plugin.settings.candidateLimit,
    corpusBlocks:plugin.engine.getBlocks().length,embeddingWarning:plugin.embeddingWarning,
    candidates:candidates.map((c:any,i:number)=>({id:c.id,rank:i+1,path:c.path,text:c.text,retrievalScore:c.retrievalScore})),
    evaluatedCandidates:result.candidates.length,warning:result.warning,judgements:result.judgements,selected,baked};
  require('node:fs').writeFileSync(options.output,JSON.stringify(data,null,2));
  return {output:options.output,scored:result.judgements.length,selected:selected.length};
};
