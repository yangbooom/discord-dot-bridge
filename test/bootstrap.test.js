import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,createFetchMock} from 'miniflare';
test('initial template has no credential prompts and all operational paths fail closed',async()=>{
 const c=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
 assert.deepEqual(Object.values(c.vars),Array(5).fill('false'));
 assert.equal(c.workers_dev,false); assert.equal(c.preview_urls,false);
 assert.equal(readFileSync('.dev.vars.example','utf8').split('\n').some(x=>x.trim()&&!x.startsWith('#')),false);
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({modules:true,scriptPath:'build/index.js',compatibilityDate:c.compatibility_date,compatibilityFlags:c.compatibility_flags,bindings:c.vars,fetchMock:mock,modulesRules:[{type:'CompiledWasm',include:['**/*.wasm'],fallthrough:true}]});
 try {
  assert.equal((await mf.dispatchFetch('https://example.com/health')).status,200);
  for(const path of ['/mcp','/v1/inbox','/v1/reply','/interactions','/event-authorization']) {
   const r=await mf.dispatchFetch('https://example.com'+path,{method:'POST',body:'{}'});assert.ok(r.status>=400,path+' must deny');
  }
 }finally{await mf.dispose()}
});
