import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {eventsRpc,dispatchEvent,SubscriptionStore} from '../support/subscription-store.js';
const channel='123456789012345678';
const secret=n=>'whsec_'+Buffer.alloc(32,n).toString('base64');
async function setup(){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("unused")}}',r2Buckets:['SUBSCRIPTIONS']});
 const bucket=await mf.getR2Bucket('SUBSCRIPTIONS');
 const env={SUBSCRIPTIONS:bucket,MCP_EVENTS_ENABLED:'true',EVENTS_TRANSPORT_VERIFIED:'true',SUBSCRIPTION_ENCRYPTION_KEY:'07'.repeat(32),EVENT_CALLBACK_HOSTS:'callback.example',MCP_HOST:'mcp.example.com',ACCESS_ISSUER:'https://test.cloudflareaccess.com',ACCESS_SUBJECT:'owner',DISCORD_CHANNEL_ID:channel};
 const p={subject:'owner',authorization:'Bearer oauth:synthetic-only',expiresAt:Math.floor(Date.now()/1000)+300};
 const subscribe=key=>eventsRpc(env,JSON.stringify(p),JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'discord.task.created',arguments:{channel_id:channel},delivery:{mode:'webhook',url:'https://callback.example/event',secret:key}}})).then(JSON.parse);
 const store=await SubscriptionStore.open(bucket,new Uint8Array(32).fill(7));return {mf,env,subscribe,store};
}
const event={eventId:'evt_test',name:'discord.task.created',timestamp:'2026-11-16T00:00:00Z',data:{channel_id:channel,interaction_id:'123456789012345679',user_id:'123456789012345680'},cursor:null};
test('Same-key refresh preserves live rotation overlap',async()=>{
 const c=await setup(),originalFetch=globalThis.fetch;let lastSignature;
 globalThis.fetch=async (url,options)=>{
  if(String(url).includes('/event-authorization'))return Response.json({issuer:c.env.ACCESS_ISSUER,subject:'owner'});
  const body=JSON.parse(options.body);if(body.type==='verification')return Response.json({challenge:body.challenge});
  lastSignature=options.headers['webhook-signature'];return Response.json({});
 };
 try{
  const a=await c.subscribe(secret(1));assert.ok(a.result);
  assert.ok((await c.subscribe(secret(2))).result);const rotated=(await c.store.read(a.result.id)).record.delivery;
  assert.ok((await c.subscribe(secret(2))).result);const refreshed=(await c.store.read(a.result.id)).record.delivery;
  assert.equal(refreshed.previousSecret,secret(1));assert.equal(refreshed.rotateUntil,rotated.rotateUntil);
  await dispatchEvent(c.env,JSON.stringify(event));assert.equal(lastSignature.split(' ').length,2);
 }finally{globalThis.fetch=originalFetch;await c.mf.dispose();}
});
test('Terminal callback statuses survive oversized or invalid UTF-8 bodies without retry',async()=>{
 for(const status of [410,413]){
  const c=await setup(),originalFetch=globalThis.fetch;let attempts=0;
  globalThis.fetch=async(url,options)=>{
   if(String(url).includes('/event-authorization'))return Response.json({issuer:c.env.ACCESS_ISSUER,subject:'owner'});
   const body=JSON.parse(options.body);if(body.type==='verification')return Response.json({challenge:body.challenge});
   attempts++;return new Response(status===413?'x'.repeat(17000):new Uint8Array([255]),{status});
  };
  try{
   const sub=await c.subscribe(secret(1));assert.ok(sub.result);await dispatchEvent(c.env,JSON.stringify(event));assert.equal(attempts,1);
   assert.equal((await c.store.read(sub.result.id)).record.state,status===410?'revoked':'active');
  }finally{globalThis.fetch=originalFetch;await c.mf.dispose();}
 }
});
