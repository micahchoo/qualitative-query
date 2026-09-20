const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Element {
  constructor() { this.children = []; this.text = ''; this.isConnected = true; this.classes = new Set(); }
  empty() { this.children = []; this.text = ''; }
  addClass(...names) { names.forEach(n => this.classes.add(n)); }
  removeClass(...names) { names.forEach(n => this.classes.delete(n)); }
  createEl(tag, options = {}) { const child = new Element(); child.tag = tag; child.text = options.text || ''; if(options.cls) child.addClass(options.cls); this.children.push(child); return child; }
  createDiv(options = {}) { return this.createEl('div', typeof options === 'string' ? {cls:options} : options); }
  createSpan(options) { return this.createEl('span', options); }
  setText(text) { this.text = text; }
  setAttribute() {}
  addEventListener() {}
  prepend(child) { this.children.unshift(child); }
  set textContent(text) { this.text = text; }
  appendChild(child) { this.children.push(child); return child; }
  remove() { this.isConnected = false; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(' '); }
}
class Component {
  constructor() { this.children = []; this.cleanups = []; }
  addChild(child) { this.children.push(child); child.onload?.(); return child; }
  removeChild(child) { child.unload(); this.children = this.children.filter(c=>c!==child); }
  register(fn) { this.cleanups.push(fn); }
  registerDomEvent() {}
  load() { this.onload?.(); }
  unload() { this.onunload?.(); this.children.forEach(c=>c.unload()); this.cleanups.forEach(f=>f()); }
}
class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl=el; } }
class TFile { constructor(path) { this.path=path; this.extension='md'; this.basename=path.split('/').pop().replace(/\.md$/,''); this.stat={mtime:1}; } }
const source = new TFile('Sources/Conflict.md');
const query = new TFile('Queries/Conflict.md');
const contents = new Map([[source.path,'# Conflict\n\nA conflict is a clash of incompatible goals.'],[query.path,'# Conflict\n\n```qualitative-query\nWhat defines a conflict?\n```']]);
const callbacks = new Map();
const app = {
  secretStorage:{getSecret(){return '';},setSecret(){}},
  vault:{configDir:".custom-config",getMarkdownFiles(){return [source,query];},cachedRead:async f=>contents.get(f.path),read:async f=>contents.get(f.path),getAbstractFileByPath:p=>[source,query].find(f=>f.path===p),on:(event,fn)=>{callbacks.set(event,fn);return {};},offref(){}},
  metadataCache:{getFirstLinkpathDest:()=>null,on:()=>({}),offref(){}},
  workspace:{iterateAllLeaves(){},on:()=>({}),offref(){},onLayoutReady(fn){fn();},openLinkText:async()=>{},getLeavesOfType:()=>[]}
};
class Plugin extends Component {
  constructor(){super();this.app=app;this.processors={};this.postprocessors=[];}
  async loadData(){return {candidateLimit:1000,provider:'embedded',model:'kev-0.5b',endpoint:'http://127.0.0.1:8009',embeddedModelDir:'runtime/kev'};}
  async saveData(){}
  registerMarkdownCodeBlockProcessor(name,fn){this.processors[name]=fn;}
  registerMarkdownPostProcessor(fn){this.postprocessors.push(fn);}
  registerEvent(){}
  registerInterval(id){this.register(()=>clearInterval(id));}
  addSettingTab(){}
  addCommand(){}
  addRibbonIcon(){}
}
class MarkdownView {}
const requests=[];
let allowRequests=false;
const obsidian={Modal:class{},Plugin,Component,MarkdownRenderChild,TFile,MarkdownView,PluginSettingTab:class{},Setting:class{},Notice:class{},normalizePath:p=>p.replace(/\\/g,'/'),MarkdownRenderer:{render:async(app,text,el)=>{el.createDiv({text});}},requestUrl:async(options)=>{
  assert.ok(allowRequests,'Unexpected network call without credentials');
  requests.push(options);
  const body=JSON.parse(options.body); const answers={};
  for(const [id,q] of Object.entries(body.questions)) answers[id]=q.type==='choice'?{type:'choice',choice:'definition',probabilities:{definition:1,condition:0,distinction:0,other:0},confidence:1}:{type:'noul',noul:.9};
  return {status:200,json:{model:body.model,answers,usage:{input_tokens:20,output_tokens:0}},headers:{}};
},parseYaml:()=>({})};
const moduleObject={exports:{}};
vm.runInNewContext(fs.readFileSync(process.argv[2],'utf8'),{module:moduleObject,exports:moduleObject.exports,require:(name)=>{assert.equal(name,'obsidian');return obsidian;},console,setTimeout,clearTimeout,setInterval,clearInterval,window:{setTimeout,clearTimeout,setInterval,clearInterval},createEl:()=>new Element(),createDiv:()=>new Element(),document:{createElement:()=>{throw new Error("Use Obsidian createEl helpers");}},URL,AbortController,TextEncoder,performance,crypto:require('node:crypto').webcrypto});
(async()=>{
  const plugin=new moduleObject.exports.default();
  await plugin.onload();
  assert.equal(plugin.settings.candidateLimit,1000);
  const el=new Element(); const children=[];
  const ctx={sourcePath:query.path,docId:'smoke',addChild:c=>{children.push(c);c.load();},getSectionInfo:()=>({lineStart:0,lineEnd:0,text:contents.get(query.path)})};
  await plugin.processors['qualitative-query']('What defines a conflict?',el,ctx);
  await new Promise(r=>setTimeout(r,60));
  assert.match(el.textContent,/key|provider|configure/i);
  assert.equal(requests.length,0);
  // A store install has no sibling worker file. Exercise the worker carried in main.js.
  const workerSource = await plugin.retrieval.semantic.assets.readWorker();
  assert.ok(workerSource.length > 1000);
  const responses = [];
  const workerContext = vm.createContext({ArrayBuffer,TextEncoder,TextDecoder,postMessage:message=>responses.push(message)});
  workerContext.self = workerContext;
  vm.runInContext(workerSource, workerContext);
  const weights = fs.readFileSync('models/embeddings/model.safetensors');
  workerContext.onmessage({data:{id:1,type:'load',weights:weights.buffer.slice(weights.byteOffset,weights.byteOffset+weights.byteLength),tokenizer:JSON.parse(fs.readFileSync('models/embeddings/tokenizer.json','utf8')),config:JSON.parse(fs.readFileSync('models/embeddings/tokenizer_config.json','utf8'))}});
  workerContext.onmessage({data:{id:2,type:'update',rows:[{id:'conflict',text:'Mediation resolves disputes.'},{id:'cake',text:'A chocolate cake recipe.'}]}});
  workerContext.onmessage({data:{id:3,type:'search',question:'resolving interpersonal conflict',limit:2}});
  assert.ok(responses.every(message=>!message.error),JSON.stringify(responses));
  assert.equal(responses.at(-1).result[0].id,'conflict');
  assert.match(el.textContent,/incompatible goals/);
  assert.match(el.textContent,/Local match/);
  allowRequests=true;
  plugin.settings.apiKey='synthetic-smoke-key';
  plugin.rebuildClient();
  const connectedEl=new Element();
  await plugin.processors['qualitative-query']('What defines a conflict?',connectedEl,ctx);
  await new Promise(r=>setTimeout(r,100));
  assert.match(connectedEl.textContent,/incompatible goals/);
  assert.ok(requests.length>0);
  assert.equal(requests.at(-1).url,'https://api.typesafe.ai/v1/systemone');
  contents.set(source.path,'# Conflict\n\nA conflict is a revised definition of incompatible goals.');
  source.stat.mtime++;
  callbacks.get('modify')(source);
  await new Promise(r=>setTimeout(r,700));
  assert.match(connectedEl.textContent,/revised definition/);
  assert.equal(plugin.settings.provider,undefined);
  assert.equal(plugin.settings.endpoint,undefined);
  assert.equal(plugin.settings.embeddedModelDir,undefined);
  assert.equal(plugin.settings.model,'jev-1.13.0');
  assert.ok(requests.every(request=>request.url==='https://api.typesafe.ai/v1/systemone'));
  // A modify timer must not reintroduce a source renamed to a non-Markdown file.
  callbacks.get('modify')(source);
  const previousPath = source.path;
  source.path = 'Sources/Conflict.txt'; source.extension = 'txt';
  callbacks.get('rename')(source, previousPath);
  await new Promise(r=>setTimeout(r,700));
  assert.equal(plugin.index.blocks.length,0);
  assert.doesNotMatch(connectedEl.textContent,/revised definition/);
  assert.equal(plugin.indexError,'');
  plugin.unload(); children.forEach(c=>c.unload());
  console.log('Bundled plugin smoke passed: startup, no-key guard, hosted rendering, live source refresh, legacy-settings migration, Jev-only transport, unload. Embedded worker executes from main.js with real model weights. All transport mocked.');
})().catch(error=>{console.error(error);process.exitCode=1;});
