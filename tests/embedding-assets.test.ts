import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('obsidian',()=>({requestUrl:request}));
import {downloadEmbeddings,EMBEDDING_REVISION} from '../src/embedding-assets';

describe('explicit model-data download',()=>{
 it('installs only pinned data through a custom config directory without credentials',async()=>{
  const files=new Map<string,ArrayBuffer>();
  const folders=new Set<string>();
  const adapter:any={exists:async(p:string)=>folders.has(p),mkdir:async(p:string)=>{folders.add(p);},writeBinary:async(p:string,b:ArrayBuffer)=>{files.set(p,b);},rename:async(a:string,b:string)=>{files.set(b,files.get(a)!);files.delete(a);}};
  request.mockImplementation(async({url})=>{
   const name=url.split('/').at(-1);
   const data=readFileSync(new URL(`../models/embeddings/${name}`,import.meta.url));
   return {status:200,arrayBuffer:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};
  });
  request.mockClear();
  await downloadEmbeddings(adapter,'.custom/plugins/qualitative-query');
  expect(files.size).toBe(3);
  expect([...files.keys()].every(k=>k.startsWith('.custom/plugins/qualitative-query/embeddings/')&&!k.endsWith('.download'))).toBe(true);
  for(const [options] of request.mock.calls){expect(options.url).toContain(`/resolve/${EMBEDDING_REVISION}/`);expect(options.headers).toBeUndefined();expect(options.body).toBeUndefined();expect(options.url).not.toMatch(/\.js$/);}
 });
 it('rejects a corrupted weight file before installing it',async()=>{
  const weights=readFileSync(new URL('../models/embeddings/model.safetensors',import.meta.url));weights[100]^=1;
  request.mockResolvedValue({status:200,arrayBuffer:weights.buffer.slice(weights.byteOffset,weights.byteOffset+weights.byteLength)});
  const writeBinary=vi.fn();
  await expect(downloadEmbeddings({exists:async()=>true,writeBinary} as any,'.custom/plugins/qualitative-query')).rejects.toThrow('checksum');
  expect(writeBinary).not.toHaveBeenCalled();
 });
});
