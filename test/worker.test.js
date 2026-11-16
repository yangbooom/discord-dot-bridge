import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,createFetchMock} from 'miniflare';

const app='123456789012345678',user='123456789012345679',channel='123456789012345680',guild='123456789012345681',taskId='123456789012345682',interaction='123456789012345683',resultId='123456789012345684';
const token='local-test-only-'.repeat(3);
const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');
const request={id:interaction,application_id:app,type:2,guild_id:guild,channel_id:channel,member:{user:{id:user}},data:{name:'dot',options:[{name:'task',type:3,value:'hello'}]}};
const original={id:taskId,application_id:app,channel_id:channel,author:{id:app,bot:true},interaction_metadata:{id:interaction,type:2,user:{id:user}},content:`[dot-task:${interaction}]\nhello\n\n답변은 이 채널에 공개됩니다.`,timestamp:'2026-11-16T12:00:00Z'};
const result={id:resultId,channel_id:channel,author:{id:app,bot:true},message_reference:{message_id:taskId},content:`[dot-result:${taskId}]\nanswer`};
async function setup(overrides={}) {
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({modules:true,scriptPath:'build/index.js',compatibilityDate:'2026-08-06',fetchMock:mock,r2Buckets:['SUBSCRIPTIONS'],compatibilityFlags:['global_fetch_strictly_public'],
 modulesRules:[{type:'CompiledWasm',include:['**/*.wasm'],fallthrough:true}],
 bindings:{LEGACY_HTTP_ENABLED:"true",DISCORD_APPLICATION_ID:app,DISCORD_PUBLIC_KEY:publicKey,DISCORD_BOT_USER_ID:app,DISCORD_GUILD_ID:guild,DISCORD_CHANNEL_ID:channel,ALLOWED_USER_IDS:user,ACCEPT_TASKS:'true',BRIDGE_API_TOKEN:token,DISCORD_BOT_TOKEN:'fake-not-a-real-token',...overrides}});
 return {mf,mock,pool:mock.get('https://discord.com')};
}
async function signed(mf,payload=request,stale=false) {
 const body=JSON.stringify(payload),ts=String(Math.floor(Date.now()/1000)-(stale?301:0));
 const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(ts+body))).toString('hex');
 return mf.dispatchFetch('https://bridge/interactions',{method:'POST',credentials:'omit',headers:{'x-signature-timestamp':ts,'x-signature-ed25519':signature},body});
}
function consumer(mf,path,body) { return mf.dispatchFetch(`https://bridge/v1/${path}`,{method:body?'POST':'GET',credentials:'omit',headers:{authorization:`Bearer ${token}`},...(body?{body:JSON.stringify(body)}:{})}); }
const history=`/api/v10/channels/${channel}/messages?limit=100`;
const getTask=`/api/v10/channels/${channel}/messages/${taskId}`;
test('compiled Rust WASM validates PING, rejects unsigned/stale, bounds body',async()=>{
 const {mf}=await setup();try{
  assert.deepEqual(await (await signed(mf,{application_id:app,type:1})).json(),{type:1});
  assert.equal((await signed(mf,request,true)).status,401);
  assert.equal((await mf.dispatchFetch('https://bridge/interactions',{method:'POST',credentials:'omit',body:'{}'})).status,401);
  assert.equal((await mf.dispatchFetch('https://bridge/interactions',{method:'POST',body:'a'.repeat(16385)})).status,413);
 }finally{await mf.dispose();}
});
test('public task response persists in Discord contract; disabled and unauthorized fail closed',async()=>{
 const {mf}=await setup();try{
  const response=await (await signed(mf)).json();assert.equal(response.type,4);assert.equal(response.data.flags,4);assert.deepEqual(response.data.allowed_mentions,{parse:[]});assert.match(response.data.content,/\[dot-task:/);
  const changed=structuredClone(request);changed.member.user.id='999999999999999999';assert.match((await(await signed(mf,changed)).json()).data.content,/권한/);
 }finally{await mf.dispose();}
 const off=await setup({ACCEPT_TASKS:'false'});try{assert.match((await(await signed(off.mf)).json()).data.content,/준비되지/);}finally{await off.mf.dispose();}
});
test('inbox authenticates origin and suppresses completed requests and user forgery',async()=>{
 const {mf,pool}=await setup();try{
  const forged={...original,id:'223456789012345682',author:{id:user,bot:false}};
  pool.intercept({path:history,method:'GET'}).reply(200,[original,forged]);
  const inbox=await(await consumer(mf,'inbox')).json();assert.equal(inbox.tasks.length,1);assert.equal(inbox.tasks[0].task,'hello');
  pool.intercept({path:history,method:'GET'}).reply(200,[result,original]);
  assert.deepEqual((await(await consumer(mf,'inbox')).json()).tasks,[]);
  assert.equal((await mf.dispatchFetch('https://bridge/v1/inbox',{credentials:'omit'})).status,401);
 }finally{await mf.dispose();}
});
test('reply checks original, disables mentions, sends normal bot message, detects duplicate/conflict',async()=>{
 const {mf,pool}=await setup();try{
  pool.intercept({path:getTask,method:'GET'}).reply(200,original);
  pool.intercept({path:history,method:'GET'}).reply(200,[original]);
  pool.intercept({path:`/api/v10/channels/${channel}/messages`,method:'POST'}).reply(200,async options=>{
   const body=JSON.parse(await new Response(options.body).text());assert.equal(body.nonce,taskId);assert.equal(body.enforce_nonce,true);assert.deepEqual(body.allowed_mentions,{parse:[]});assert.equal(body.message_reference.message_id,taskId);
   return JSON.stringify(result);
  });
  const sent=await consumer(mf,'reply',{messageId:taskId,text:'answer'});assert.equal(sent.status,201);assert.equal((await sent.json()).messageId,resultId);
  for(const text of ['answer','different']){
   pool.intercept({path:getTask,method:'GET'}).reply(200,original);
   pool.intercept({path:history,method:'GET'}).reply(200,[result,original]);
   assert.equal((await consumer(mf,'reply',{messageId:taskId,text})).status,text==='answer'?200:409);
  }
 }finally{await mf.dispose();}
});
test('403 stops without alternative routing; 429 remains visible',async()=>{
 const {mf,pool}=await setup();try{
  for(const status of [403,429]){
   pool.intercept({path:history,method:'GET'}).reply(status,{code:status===403?40333:0});
   const r=await consumer(mf,'inbox');assert.equal(r.status,status===429?429:502);assert.equal((await r.json()).upstreamStatus,status);
  }
 }finally{await mf.dispose();}
});
test('inbox warns at scan limit and reply refuses when prior delivery cannot be checked',async()=>{
 const {mf,pool}=await setup();
 const pages=Array.from({length:5},(_,p)=>Array.from({length:100},(_,i)=>({id:String(323456789012345999n-BigInt(p*100+i)),author:{id:user},content:'ordinary chat'})));
 function mocks(){let path=history;for(const page of pages){pool.intercept({path,method:'GET'}).reply(200,page);path=history+`&before=${page.at(-1).id}`;}}
 try{
  mocks();assert.equal((await(await consumer(mf,'inbox')).json()).truncated,true);
  pool.intercept({path:getTask,method:'GET'}).reply(200,original);mocks();
  assert.equal((await consumer(mf,'reply',{messageId:taskId,text:'answer'})).status,409);
 }finally{await mf.dispose();}
});

async function mcpSetup(overrides={}) {
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='test-key';jwk.alg='RS256';jwk.use='sig';
 const now=Math.floor(Date.now()/1000);
 const claims={iss:'https://test.cloudflareaccess.com',aud:['test-aud'],sub:'owner',type:'app',iat:now-1,exp:now+300,...overrides.claims};
 const data=[{alg:'RS256',kid:'test-key'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data))).toString('base64url');
 const ctx=await setup({MCP_ENABLED:'true',MCP_HOST:'mcp.example.com',ACCESS_ISSUER:'https://test.cloudflareaccess.com',ACCESS_AUD:'test-aud',ACCESS_SUBJECT:'owner',LEGACY_HTTP_ENABLED:'false',...overrides.bindings});
 ctx.mock.get('https://test.cloudflareaccess.com').intercept({path:'/cdn-cgi/access/certs',method:'GET'}).reply(200,{keys:[jwk]}).persist();
 return {...ctx,jwt:data+'.'+signature};
}
function mcp(ctx,method,params={},extras={}) {
 return ctx.mf.dispatchFetch('https://mcp.example.com/mcp',{method:'POST',headers:{'Content-Type':'application/json','Cf-Access-Jwt-Assertion':ctx.jwt,...extras},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
}
test('MCP validates signed Access identity, denies alternative origin and legacy bypass, advertises no events',async()=>{
 const c=await mcpSetup();try {
  const result=await(await mcp(c,'initialize',{protocolVersion:'2025-03-26'})).json();
  assert.ok(result.result,JSON.stringify(result));assert.equal(result.result.protocolVersion,'2025-03-26');assert.deepEqual(result.result.capabilities,{tools:{}});
  assert.equal((await c.mf.dispatchFetch('https://wrong.workers.dev/mcp',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':c.jwt},body:'{}'})).status,403);
  assert.equal((await c.mf.dispatchFetch('https://mcp.example.com/mcp',{method:'POST',body:'{}'})).status,401);
  assert.equal((await mcp(c,'ping',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await consumer(c.mf,'inbox')).status,404);
  assert.equal((await(await mcp(c,'events/subscribe')).json()).error.code,-32601);
  assert.equal((await(await mcp(c,'tools/list')).json()).result.tools.length,3);
 }finally{await c.mf.dispose();}
 const expired=await mcpSetup({claims:{exp:1}});try{assert.equal((await mcp(expired,'ping')).status,401);}finally{await expired.mf.dispose();}
 const other=await mcpSetup({claims:{sub:'someone-else'}});try{assert.equal((await mcp(other,'ping')).status,401);}finally{await other.mf.dispose();}
});
test('MCP reads task and replies with existing duplicate/authorization protections',async()=>{
 const c=await mcpSetup();try{
  c.pool.intercept({path:getTask,method:'GET'}).reply(200,original);
  const read=await(await mcp(c,'tools/call',{name:'discord_get_task',arguments:{messageId:taskId}})).json();
  assert.ok(read.result,JSON.stringify(read));assert.equal(JSON.parse(read.result.content[0].text).task,'hello');
  c.pool.intercept({path:getTask,method:'GET'}).reply(200,original);
  c.pool.intercept({path:history,method:'GET'}).reply(200,[result,original]);
  const reply=await(await mcp(c,'tools/call',{name:'discord_reply',arguments:{messageId:taskId,text:'answer'}})).json();
  assert.equal(JSON.parse(reply.result.content[0].text).status,'already_sent');
  assert.equal(reply.result.isError,false);
 }finally{await c.mf.dispose();}
});

test('MCP Events verifies challenge, encrypts subscription, emits signed minimal event and honors unsubscribe',async()=>{
 const c=await mcpSetup({bindings:{MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',EVENT_CALLBACK_HOSTS:'callback.example',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32)}});
 const {createHmac}=await import('node:crypto');
 const secret='whsec_'+Buffer.alloc(32,9).toString('base64');let delivered=0,challenges=0;
 const auth={Authorization:'Bearer oauth:synthetic-no-access'};
 c.mock.get('https://mcp.example.com').intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'}).persist();
 c.mock.get('https://callback.example').intercept({path:'/event',method:'POST'}).reply(200,async options=>{
  const raw=await new Response(options.body).text();
  const h=new Headers(options.headers);const expected='v1,'+createHmac('sha256',Buffer.alloc(32,9)).update(h.get('webhook-id')+'.'+h.get('webhook-timestamp')+'.'+raw).digest('base64');
  assert.equal(h.get('webhook-signature'),expected);assert.ok(h.get('x-mcp-subscription-id'));
  assert.equal(h.get('authorization'),null);
  const data=JSON.parse(raw);if(data.type==='verification'){challenges++;return JSON.stringify({challenge:data.challenge});}
  delivered++;assert.equal(data.name,'discord.task.created');assert.equal(data.data.interaction_id,interaction);assert.equal(data.data.text,undefined);return '{}';
 }).persist();
 try{
  assert.ok((await(await mcp(c,'initialize')).json()).result.capabilities.events);
  assert.equal((await(await mcp(c,'events/list')).json()).result.events[0].name,'discord.task.created');
  const params={name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret},ttlMs:60000};
  const subscribed=await(await mcp(c,'events/subscribe',params,auth)).json();assert.ok(subscribed.result,JSON.stringify(subscribed));
  const bucket=await c.mf.getR2Bucket('SUBSCRIPTIONS');const raw=await(await bucket.get('subscriptions/'+subscribed.result.id)).text();assert.ok(!raw.includes(secret));assert.ok(!raw.includes('synthetic-no-access'));
  const {SubscriptionStore}=await import('../support/subscription-store.js');
  const store=await SubscriptionStore.open(bucket,new Uint8Array(32).fill(7));
  let snapshot=await store.read(subscribed.result.id);const fixedVerifiedAt=Math.floor(Date.now()/1000)-30;
  await store.refreshVerified(subscribed.result.id,snapshot.record.owner,snapshot.etag,{...snapshot.record.delivery,verifiedAt:fixedVerifiedAt},snapshot.record.expiresAt,Math.floor(Date.now()/1000));
  assert.ok((await(await mcp(c,'events/subscribe',params,auth)).json()).result);assert.equal(challenges,1);
  assert.equal((await store.read(subscribed.result.id)).record.delivery.verifiedAt,fixedVerifiedAt);
  snapshot=await store.read(subscribed.result.id);
  await store.refreshVerified(subscribed.result.id,snapshot.record.owner,snapshot.etag,{...snapshot.record.delivery,verifiedAt:Math.floor(Date.now()/1000)-61},snapshot.record.expiresAt,Math.floor(Date.now()/1000));
  assert.ok((await(await mcp(c,'events/subscribe',params,auth)).json()).result);assert.equal(challenges,2);
  await signed(c.mf);for(let i=0;i<40&&delivered===0;i++)await new Promise(r=>setTimeout(r,50));assert.equal(delivered,1);
  assert.deepEqual((await(await mcp(c,'events/unsubscribe',{name:params.name,arguments:params.arguments,delivery:{mode:'webhook',url:params.delivery.url}},auth)).json()).result,{});
  await signed(c.mf);await new Promise(r=>setTimeout(r,200));assert.equal(delivered,1);
  const bad=await(await mcp(c,'events/subscribe',{...params,delivery:{...params.delivery,url:'https://127.0.0.1/private'}},auth)).json();assert.ok(bad.error);
 }finally{await c.mf.dispose();}
});
test('MCP Events rejects wrong challenge and missing opaque authorization without saving state',async()=>{
 const c=await mcpSetup({bindings:{MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',EVENT_CALLBACK_HOSTS:'callback.example',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32)}});
 c.mock.get('https://mcp.example.com').intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'}).persist();
 c.mock.get('https://callback.example').intercept({path:'/event',method:'POST'}).reply(200,{challenge:'wrong'});
 const params={name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
 try{
  assert.equal((await(await mcp(c,'events/subscribe',params)).json()).error.code,-32001);
  assert.equal((await(await mcp(c,'events/subscribe',params,{Authorization:'Bearer oauth:synthetic-no-access'})).json()).error.code,-32015);
  assert.equal((await(await c.mf.getR2Bucket('SUBSCRIPTIONS')).list()).objects.length,0);
 }finally{await c.mf.dispose();}
});

test('MCP Events refuses redirect verification and revoked Access; no callback delivery follows',async()=>{
 const c=await mcpSetup({bindings:{MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',EVENT_CALLBACK_HOSTS:'callback.example',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32)}});
 const params={name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
 const auth={Authorization:'Bearer oauth:synthetic-no-access'};
 try{
  c.mock.get('https://mcp.example.com').intercept({path:'/event-authorization',method:'GET'}).reply(403,{});
  assert.equal((await(await mcp(c,'events/subscribe',params,auth)).json()).error.code,-32001);
  c.mock.get('https://mcp.example.com').intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'});
  c.mock.get('https://callback.example').intercept({path:'/event',method:'POST'}).reply(302,'',{headers:{location:'https://evil.example/steal'}});
  assert.equal((await(await mcp(c,'events/subscribe',params,auth)).json()).error.code,-32015);
  assert.equal((await(await c.mf.getR2Bucket('SUBSCRIPTIONS')).list()).objects.length,0);
 }finally{await c.mf.dispose();}
});

test('Transient Access recheck failure retries without revoking a healthy subscription',async()=>{
 const c=await mcpSetup({bindings:{MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',EVENT_CALLBACK_HOSTS:'callback.example',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32)}});let delivered=0;
 const access=c.mock.get('https://mcp.example.com');
 access.intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'});
 access.intercept({path:'/event-authorization',method:'GET'}).reply(503,{});
 access.intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'});
 c.mock.get('https://callback.example').intercept({path:'/event',method:'POST'}).reply(200,async options=>{
  const value=JSON.parse(await new Response(options.body).text());
  if(value.type==='verification')return JSON.stringify({challenge:value.challenge});delivered++;return '{}';
 }).persist();
 try{
  const params={name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
  const sub=await(await mcp(c,'events/subscribe',params,{Authorization:'Bearer oauth:synthetic-no-access'})).json();assert.ok(sub.result);
  await signed(c.mf);for(let i=0;i<40&&!delivered;i++)await new Promise(r=>setTimeout(r,50));assert.equal(delivered,1);
  const {SubscriptionStore}=await import('../support/subscription-store.js');
  const store=await SubscriptionStore.open(await c.mf.getR2Bucket('SUBSCRIPTIONS'),new Uint8Array(32).fill(7));assert.equal((await store.read(sub.result.id)).record.state,'active');
 }finally{await c.mf.dispose();}
});

test('Unsubscribe racing first callback verification prevents later activation',async()=>{
 const c=await mcpSetup({bindings:{MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',EVENT_CALLBACK_HOSTS:'callback.example',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32)}});
 let entered,release;const started=new Promise(r=>entered=r),paused=new Promise(r=>release=r);
 c.mock.get('https://mcp.example.com').intercept({path:'/event-authorization',method:'GET'}).reply(200,{issuer:'https://test.cloudflareaccess.com',subject:'owner'}).persist();
 c.mock.get('https://callback.example').intercept({path:'/event',method:'POST'}).reply(200,async options=>{const data=JSON.parse(await new Response(options.body).text());entered();await paused;return JSON.stringify({challenge:data.challenge});});
 const params={name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
 const auth={Authorization:'Bearer oauth:synthetic-no-access'};
 try{
  const pending=mcp(c,'events/subscribe',params,auth);await started;
  const stopped=await(await mcp(c,'events/unsubscribe',{name:params.name,arguments:params.arguments,delivery:{mode:'webhook',url:params.delivery.url}},auth)).json();assert.deepEqual(stopped.result,{});
  release();const outcome=await(await pending).json();assert.equal(outcome.error.code,-32000);
  const bucket=await c.mf.getR2Bucket('SUBSCRIPTIONS');const {SubscriptionStore}=await import('../support/subscription-store.js');const store=await SubscriptionStore.open(bucket,new Uint8Array(32).fill(7));
  const listing=await bucket.list();assert.equal(listing.objects.length,1);assert.equal((await store.read(listing.objects[0].key.slice('subscriptions/'.length))).record.state,'revoked');
 }finally{release?.();await c.mf.dispose();}
});
