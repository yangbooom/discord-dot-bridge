import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {SubscriptionStore,SubscriptionConflict} from '../support/subscription-store.js';
const id='sub_'+'a'.repeat(64),otherId='sub_'+'b'.repeat(64);
const delivery={url:'https://callback.example/fake',secret:'whsec_synthetic-only-not-real'};
async function setup(){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("unused")}}',r2Buckets:['SUBSCRIPTIONS']});
 const bucket=await mf.getR2Bucket('SUBSCRIPTIONS');
 const store=await SubscriptionStore.open(bucket,new Uint8Array(32).fill(7));
 return {mf,bucket,store};
}
test('R2 encrypts state, binds ciphertext to ID and fails closed on wrong key',async()=>{
 const {mf,bucket,store}=await setup();try{
  await store.createVerified(id,'owner',delivery,200,100);
  const raw=await(await bucket.get('subscriptions/'+id)).text();
  assert.ok(!raw.includes(delivery.secret));assert.ok(!raw.includes(delivery.url));
  assert.equal((await store.readActive(id,'owner',199)).record.delivery.secret,delivery.secret);
  assert.equal(await store.readActive(id,'other',150),null);
  assert.equal(await store.readActive(id,'owner',200),null);
  const wrong=await SubscriptionStore.open(bucket,new Uint8Array(32).fill(8));
  await assert.rejects(wrong.read(id));
  await bucket.put('subscriptions/'+otherId,raw);await assert.rejects(store.read(otherId));
 }finally{await mf.dispose();}
});
test('R2 compare-and-swap prevents duplicate creation and stale refresh after revocation',async()=>{
 const {mf,store}=await setup();try{
  const creates=await Promise.allSettled([store.createVerified(id,'owner',delivery,200,100),store.createVerified(id,'owner',delivery,200,100)]);
  assert.equal(creates.filter(x=>x.status==='fulfilled').length,1);
  const original=await store.read(id);
  await assert.rejects(store.revoke(id,'other',original.etag),/Wrong owner/);
  assert.deepEqual(await store.revoke(id,'owner',original.etag),{revoked:true});
  await assert.rejects(store.refreshVerified(id,'owner',original.etag,delivery,300,100),SubscriptionConflict);
  const tombstone=await store.read(id);assert.equal(tombstone.record.delivery,undefined);
  await assert.rejects(store.refreshVerified(id,'owner',tombstone.etag,delivery,300,100),/Revoked/);
  await assert.rejects(store.createVerified(id,'owner',delivery,300,100),SubscriptionConflict);
  assert.deepEqual(await store.revoke(id,'owner',original.etag),{revoked:true});
  assert.equal(await store.readActive(id,'owner',101),null);
 }finally{await mf.dispose();}
});
test('Concurrent refresh has one winner and never silently overwrites',async()=>{
 const {mf,store}=await setup();try{
  const first=await store.createVerified(id,'owner',delivery,200,100);
  const updates=await Promise.allSettled([store.refreshVerified(id,'owner',first.etag,delivery,300,110),store.refreshVerified(id,'owner',first.etag,delivery,400,110)]);
  assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await store.read(id)).record.revision,2);
 }finally{await mf.dispose();}
});
