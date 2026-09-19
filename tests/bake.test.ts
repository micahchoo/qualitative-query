import {describe,it,expect} from 'vitest';
import {planBlockIds,safeTitle} from '../src/bake';
import {parseMarkdown} from '../src/markdown';
import {queryMarkdown,PRESETS} from '../src/builder';
import {parseQuery} from '../src/query';

describe('baked source references',()=>{
 it('adds IDs bottom-up, preserves CRLF, and reuses them on a second bake',()=>{
  const source='First paragraph.\r\n\r\nSecond paragraph.\r\n';
  let n=0;
  const first=planBlockIds(source,parseMarkdown('a.md',source),()=>`test-${++n}`);
  expect(first.text).toBe('First paragraph. ^test-1\r\n\r\nSecond paragraph. ^test-2\r\n');
  const second=planBlockIds(first.text,parseMarkdown('a.md',first.text),()=>{throw Error('Should reuse IDs');});
  expect(second.text).toBe(first.text);
  expect([...second.ids.values()]).toEqual(['test-1','test-2']);
 });
 it('puts structured block IDs outside the container and reuses existing IDs',()=>{
  const source='> First\n> second\n\n^existing\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const blocks=parseMarkdown('a.md',source).filter(b=>b.kind==='blockquote'||b.kind==='table');
  const result=planBlockIds(source,blocks,()=> 'table-id');
  expect([...result.ids.values()]).toEqual(['existing','table-id']);
  expect(result.text).toContain('| 1 | 2 |\n\n^table-id\n');
 });
 it('anchors a nested list item at its own first line',()=>{
  const source='- Parent\n  - Child\n    continuation\n';
  const child=parseMarkdown('a.md',source).find(b=>b.lineStart===2)!;
  const result=planBlockIds(source,[child],()=> 'child-id');
  expect(result.text).toContain('  - Child ^child-id\n    continuation');
  expect(result.text).not.toContain('Parent ^');
 });
 it('rejects stale passages and ID collisions without returning an edit',()=>{
  const blocks=parseMarkdown('a.md','Original');
  expect(()=>planBlockIds('Changed',blocks)).toThrow('Source changed');
  expect(()=>planBlockIds('Original\n\nOther ^taken',blocks,()=> 'taken')).toThrow('unique');
 });
 it('rejects unsupported heading embeds rather than embedding a whole section',()=>{
  const source='# Heading\n\nText';
  expect(()=>planBlockIds(source,[{...parseMarkdown('a.md',source)[0],kind:'heading'}])).toThrow('Headings');
 });
});

describe('query builder templates',()=>{
 it('creates parseable queries for every preset with explicit defaults',()=>{
  for(const preset of Object.keys(PRESETS)){
   const text=queryMarkdown('How do we live?',preset,'','');
   const q=parseQuery('Queries/test.md',text,'Queries');
   expect(q.question).toBe('How do we live?');expect(q.limit).toBe(6);expect(q.threshold).toBe(.5);
   expect(q.contextPaths).toEqual([]);expect(q.criteria.true).toBe(PRESETS[preset].yes);
  }
 });
 it('prevents multiline fields injecting query settings and sanitizes filenames',()=>{
  const text=queryMarkdown('Question?','relevant','Evidence\nlimit: 100','Mention only');
  expect(parseQuery('Queries/test.md',text,'Queries').limit).toBe(6);
  expect(safeTitle('../a/#b^c?')).not.toMatch(/[\/#^?]/);
 });
});

it('bakes in selection order with source and query links, without overwriting an existing note',async()=>{
 const {bakeNote}=await import('../src/bake');const {TFile}=await import('obsidian');
 const files=new Map<string,any>();const texts=new Map<string,string>();
 for(const [path,text] of [['a.md','First source'],['b.md','Second source'],['Queries/q.md','Query'],['Baked queries/Question.md','Keep me']]){
  files.set(path,new (TFile as any)(path));texts.set(path,text);
 }
 let indexed=false;
 const app:any={metadataCache:{getFileCache:(f:any)=>({blocks:indexed?Object.fromEntries([...texts.get(f.path)!.matchAll(/\^([a-z0-9-]+)/g)].map(m=>[m[1],{}])):{}})},vault:{getAbstractFileByPath:(p:string)=>files.get(p),read:async(f:any)=>texts.get(f.path),
  process:async(f:any,fn:any)=>{texts.set(f.path,fn(texts.get(f.path)));},
  createFolder:async(p:string)=>{files.set(p,{});},
  create:async(p:string,t:string)=>{expect(indexed,'Baked note must not open with unresolved block IDs').toBe(true);if(files.has(p))throw Error('exists');const f=new (TFile as any)(p);files.set(p,f);texts.set(p,t);return f;}},
  fileManager:{generateMarkdownLink:(f:any,_from:string,sub='')=>`[[${f.path}${sub}]]`}};
 const judgement=(path:string)=>({candidate:{...parseMarkdown(path,texts.get(path)!)[0],lexicalScore:1},score:.9,contribution:'other' as const,scores:{relevant:.9}});
 const result={status:'ready' as const,judgements:[judgement('b.md'),judgement('a.md')],candidates:[]};
 setTimeout(()=>{indexed=true;},30);
 const file=await bakeNote(app,result,{question:'Question',folder:'Queries',contextPaths:[],criteria:{mode:'generic'}},'Queries/q.md');
 const output=texts.get(file.path)!;
 expect(file.path).toBe('Baked queries/Question 2.md');expect(texts.get('Baked queries/Question.md')).toBe('Keep me');
 expect(output).toContain('[Saved question](Queries/q.md)');expect(output.indexOf('![[b.md#^qq-')).toBeLessThan(output.indexOf('![[a.md#^qq-'));
 for(const path of ['a.md','b.md'])expect(texts.get(path)).toMatch(/ \^qq-[a-f0-9-]+$/);
});
