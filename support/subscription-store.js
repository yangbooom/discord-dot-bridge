/**
 * Private R2 subscription persistence adapter, NOT a public endpoint.
 * Caller must authenticate owner and verify the callback before create/refresh.
 * Invoked by the Rust Worker only behind explicit Events activation gates.
 * Hosted transport and Managed OAuth behavior require live verification.
 * WebCrypto and R2 conditional put are platform APIs; no custom cryptography.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const from64 = text => Uint8Array.from(atob(text), c=>c.charCodeAt(0));
export class SubscriptionConflict extends Error { constructor(){super('Subscription changed; do not retry a stale operation');} }
export class SubscriptionStore {
  #bucket; #key;
  constructor(bucket,key){this.#bucket=bucket;this.#key=key;}
  static async open(bucket,keyBytes){
    if(!(keyBytes instanceof Uint8Array)||keyBytes.byteLength!==32)throw new Error('32-byte encryption key required');
    const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
    return new SubscriptionStore(bucket,key);
  }
  #path(id){if(!/^sub_[0-9a-f]{64}$/.test(id))throw new Error('Invalid subscription id');return `subscriptions/${id}`;}
  async #encode(id,record){
    const bytes=encoder.encode(JSON.stringify(record));
    if(bytes.length>8192)throw new Error('Subscription record too large');
    const nonce=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(this.#path(id))},this.#key,bytes);
    return JSON.stringify({format:1,nonce:b64(nonce),ciphertext:b64(new Uint8Array(encrypted))});
  }
  async read(id){
    const obj=await this.#bucket.get(this.#path(id));
    if(!obj)return null;
    if(obj.size>16384)throw new Error('Invalid subscription record size');
    const envelope=await obj.json();
    if(envelope.format!==1||typeof envelope.nonce!=='string'||typeof envelope.ciphertext!=='string')throw new Error('Invalid envelope');
    const nonce=from64(envelope.nonce);if(nonce.byteLength!==12)throw new Error('Invalid nonce');
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(this.#path(id))},this.#key,from64(envelope.ciphertext));
    const record=JSON.parse(decoder.decode(plaintext));
    if(record.id!==id||!['active','revoked'].includes(record.state)||!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.owner!=='string'||!Number.isSafeInteger(record.expiresAt))throw new Error('Invalid subscription record');
    return {record,etag:obj.etag};
  }
  async createVerified(id,owner,delivery,expiresAt,now){
    // A successful callback challenge is an external precondition, not simulated here.
    if(typeof owner!=='string'||!owner||owner.length>512||!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw new Error('Invalid subscription');
    const record={id,owner,delivery,expiresAt,state:'active',revision:1};
    const result=await this.#bucket.put(this.#path(id),await this.#encode(id,record),{onlyIf:{etagDoesNotMatch:'*'}});
    if(!result)throw new SubscriptionConflict();
    return {record,etag:result.etag};
  }
  async refreshVerified(id,owner,expectedEtag,delivery,expiresAt,now){
    const snapshot=await this.read(id);
    if(!snapshot||snapshot.etag!==expectedEtag)throw new SubscriptionConflict();
    if(snapshot.record.owner!==owner)throw new Error('Wrong owner');
    if(snapshot.record.state==='revoked')throw new Error('Revoked subscription cannot be refreshed');
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw new Error('Invalid expiry');
    const record={...snapshot.record,delivery,expiresAt,revision:snapshot.record.revision+1};
    const result=await this.#bucket.put(this.#path(id),await this.#encode(id,record),{onlyIf:{etagMatches:expectedEtag}});
    if(!result)throw new SubscriptionConflict();
    return {record,etag:result.etag};
  }
  async revoke(id,owner,expectedEtag){
    const snapshot=await this.read(id);
    if(!snapshot)throw new SubscriptionConflict();
    if(snapshot.record.owner!==owner)throw new Error('Wrong owner');
    if(snapshot.record.state==='revoked')return {revoked:true};
    if(snapshot.etag!==expectedEtag)throw new SubscriptionConflict();
    // Remove secret and callback when retaining the tombstone. Never delete and recreate.
    const record={id,owner,expiresAt:0,state:'revoked',revision:snapshot.record.revision+1};
    const result=await this.#bucket.put(this.#path(id),await this.#encode(id,record),{onlyIf:{etagMatches:expectedEtag}});
    if(!result)throw new SubscriptionConflict();
    return {revoked:true};
  }
  async revokeIdentity(id,owner){
    for(let attempt=0;attempt<3;attempt++){
      const snapshot=await this.read(id);
      if(snapshot){
        try{return await this.revoke(id,owner,snapshot.etag);}catch(e){if(e instanceof SubscriptionConflict)continue;throw e;}
      }
      // An unsubscribe racing first-time callback verification must leave a tombstone.
      const record={id,owner,expiresAt:0,state:'revoked',revision:1};
      const result=await this.#bucket.put(this.#path(id),await this.#encode(id,record),{onlyIf:{etagDoesNotMatch:'*'}});
      if(result)return {revoked:true};
    }
    throw new SubscriptionConflict();
  }
  async readActive(id,owner,now){
    const snapshot=await this.read(id);
    if(!snapshot||snapshot.record.owner!==owner||snapshot.record.state!=='active'||!Number.isSafeInteger(now)||snapshot.record.expiresAt<=now)return null;
    // This does NOT prove current Access authorization. Caller must revalidate it.
    return snapshot;
  }
}

// MCP Events adapter. The runtime public-network enforcement must be verified
// separately before EVENTS_TRANSPORT_VERIFIED is enabled in production.
const eventName='discord.task.created';
export function eventsReady(env){
 return env.MCP_EVENTS_ENABLED==='true' && env.EVENTS_TRANSPORT_VERIFIED==='true'
  && !!env.SUBSCRIPTIONS && /^[0-9a-f]{64}$/.test(env.SUBSCRIPTION_ENCRYPTION_KEY||'')
  && !!env.EVENT_CALLBACK_HOSTS;
}
function callbackUrl(raw,env){
 if(typeof raw!=='string'||raw.length>2048||/[\x00-\x20\x7f]/.test(raw))throw new Error('callback_url');
 const u=new URL(raw),hosts=(env.EVENT_CALLBACK_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean);
 if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||!hosts.includes(u.hostname)||u.hostname.includes(':')||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local')||/^\d+(\.\d+){3}$/.test(u.hostname))throw new Error('callback_url');
 return u.href;
}
function decodeSecret(secret){
 if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw new Error('secret');
 const key=from64(secret.slice(6));if(key.length<24||key.length>64)throw new Error('secret');return key;
}
async function storeFor(env){return SubscriptionStore.open(env.SUBSCRIPTIONS,Uint8Array.from(env.SUBSCRIPTION_ENCRYPTION_KEY.match(/../g),x=>parseInt(x,16)));}
async function signature(secret,id,time,body){
 const key=await crypto.subtle.importKey('raw',decodeSecret(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return 'v1,'+b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(`${id}.${time}.${body}`))));
}
async function boundedFetch(url,options,maxBytes=16384,readBody=true){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
 try{
  const r=await fetch(url,{...options,redirect:'manual',signal:controller.signal,cache:'no-store'});
  if(r.status>=300&&r.status<400)throw new Error('redirect');
  if(!readBody||r.status===410||r.status===413){if(r.body)await r.body.cancel();return {status:r.status,text:''};}
  let size=0;const chunks=[];const reader=r.body?.getReader();
  if(reader)for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new Error('response_size');}chunks.push(value);}
  const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}
  return {status:r.status,text:decoder.decode(out)};
 }finally{clearTimeout(timer);}
}
async function signedPost(env,record,eventId,body){
 const now=Math.floor(Date.now()/1000),url=callbackUrl(record.delivery.url,env);
 let signatures=await signature(record.delivery.secret,eventId,now,body);
 if(record.delivery.previousSecret&&record.delivery.rotateUntil>now)signatures+=' '+await signature(record.delivery.previousSecret,eventId,now,body);
 return boundedFetch(url,{method:'POST',headers:{'Content-Type':'application/json','webhook-id':eventId,'webhook-timestamp':String(now),'webhook-signature':signatures,'X-MCP-Subscription-Id':record.id},body},16384,eventId.startsWith('verification_'));
}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=encoder.encode(a),y=encoder.encode(b);let diff=x.length^y.length;for(let i=0;i<x.length;i++)diff|=x[i]^(y[i]||0);return diff===0;}
async function verifyCallback(env,record){
 const challenge=crypto.randomUUID()+crypto.randomUUID();
 const r=await signedPost(env,record,'verification_'+crypto.randomUUID(),JSON.stringify({type:'verification',challenge}));
 if(r.status<200||r.status>=300)throw new Error('challenge_failed');
 let value;try{value=JSON.parse(r.text);}catch{throw new Error('challenge_failed');}
 if(!equal(value.challenge,challenge))throw new Error('challenge_failed');
}
async function currentTokenAccepted(env,record){
 // This checks token acceptance, not proof of immediate policy reevaluation.
 // Cloudflare documents policy checks at token refresh; residual token lifetime applies.
 // Opaque Managed OAuth bearer is encrypted in R2 and only sent to its own
 // canonical Access-protected application, never the callback or another host.
 const r=await boundedFetch(`https://${env.MCP_HOST}/event-authorization`,{method:'GET',headers:{Authorization:record.delivery.authorization}});
 if(r.status===429||r.status>=500)throw new Error('authorization_temporarily_unavailable');
 if(r.status!==200)return false;
 try{const v=JSON.parse(r.text);return v.subject===record.delivery.subject&&v.issuer===env.ACCESS_ISSUER;}catch{return false;}
}
const definition=channel=>({name:eventName,description:'An authorized owner submitted a Discord /dot task in the configured channel.',delivery:['webhook'],inputSchema:{type:'object',properties:{channel_id:{type:'string',enum:[channel]}},required:['channel_id'],additionalProperties:false},payloadSchema:{type:'object',properties:{channel_id:{type:'string'},interaction_id:{type:'string'},user_id:{type:'string'}},required:['channel_id','interaction_id','user_id'],additionalProperties:false}});
export async function eventsRpc(env,principalJson,rpcJson){
 const rpc=JSON.parse(rpcJson),p=JSON.parse(principalJson),id=rpc.id;
 const fail=(code,message,reason)=>JSON.stringify({jsonrpc:'2.0',id,error:{code,message,...(reason?{data:{reason}}:{})}});
 if(!eventsReady(env))return fail(-32601,'Events are disabled');
 const owner=JSON.stringify([env.ACCESS_ISSUER,p.subject]),now=Math.floor(Date.now()/1000),params=rpc.params||{};
 const store=await storeFor(env);
 try{
  if(rpc.method==='events/list')return JSON.stringify({jsonrpc:'2.0',id,result:{events:[definition(env.DISCORD_CHANNEL_ID)]}});
  if(rpc.method==='events/unsubscribe'){
   if(params.name!==eventName||params.arguments?.channel_id!==env.DISCORD_CHANNEL_ID||Object.keys(params.arguments||{}).length!==1||params.delivery?.mode!=='webhook')return fail(-32602,'Invalid event or arguments');
   const url=callbackUrl(params.delivery.url,env);
   const identity=JSON.stringify([env.ACCESS_ISSUER,p.subject,url,eventName,{channel_id:env.DISCORD_CHANNEL_ID}]);
   const subId='sub_'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(identity))),x=>x.toString(16).padStart(2,'0')).join('');
   await store.revokeIdentity(subId,owner);
   return JSON.stringify({jsonrpc:'2.0',id,result:{}});
  }
  if(rpc.method!=='events/subscribe')return fail(-32601,'Method not found');
  if(params.name!==eventName||params.arguments?.channel_id!==env.DISCORD_CHANNEL_ID||Object.keys(params.arguments||{}).length!==1||params.delivery?.mode!=='webhook'||params.cursor!=null)return fail(-32602,'Invalid event or arguments');
  if(typeof p.authorization!=='string'||!p.authorization.startsWith('Bearer oauth:'))return fail(-32001,'Managed OAuth bearer is required for later authorization rechecks');
  const url=callbackUrl(params.delivery.url,env);decodeSecret(params.delivery.secret);
  let ttl=params.ttlMs==null?300000:params.ttlMs;
  if(!Number.isSafeInteger(ttl)||ttl<1000)return fail(-32602,'Invalid ttlMs');
  const expiresAt=Math.min(now+Math.floor(Math.min(ttl,900000)/1000),p.expiresAt);
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now)return fail(-32001,'Authorization expired');
  const identity=JSON.stringify([env.ACCESS_ISSUER,p.subject,url,eventName,{channel_id:env.DISCORD_CHANNEL_ID}]);
  const subId='sub_'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(identity))),x=>x.toString(16).padStart(2,'0')).join('');
  const previous=await store.read(subId);
  if(previous?.record.state==='revoked')return fail(-32000,'Subscription was revoked; reconnect requires explicit reset');
  const delivery={url,secret:params.delivery.secret,authorization:p.authorization,subject:p.subject,verifiedAt:now};
  if(previous?.record.delivery.secret!==delivery.secret&&previous?.record.delivery.secret){delivery.previousSecret=previous.record.delivery.secret;delivery.rotateUntil=now+60;}
  else if(previous?.record.delivery.previousSecret&&previous.record.delivery.rotateUntil>now){delivery.previousSecret=previous.record.delivery.previousSecret;delivery.rotateUntil=previous.record.delivery.rotateUntil;}
  const record={id:subId,owner,delivery,expiresAt};
  if(!await currentTokenAccepted(env,record))return fail(-32001,'Current Access authorization could not be verified');
  if(!previous && (await env.SUBSCRIPTIONS.list({prefix:'subscriptions/',limit:16})).objects.length>=16)return fail(-32000,'Subscription limit reached; reconcile stored subscriptions');
  const cached=previous?.record.delivery.secret===delivery.secret && Number.isSafeInteger(previous.record.delivery.verifiedAt) && previous.record.delivery.verifiedAt<=now && now-previous.record.delivery.verifiedAt<60;
  if(cached)delivery.verifiedAt=previous.record.delivery.verifiedAt;else await verifyCallback(env,record);
  if(previous)await store.refreshVerified(subId,owner,previous.etag,delivery,expiresAt,now);else await store.createVerified(subId,owner,delivery,expiresAt,now);
  return JSON.stringify({jsonrpc:'2.0',id,result:{id:subId,refreshBefore:new Date(expiresAt*1000).toISOString(),cursor:null,truncated:false}});
 }catch(e){
  if(e instanceof SubscriptionConflict)return fail(-32000,'Subscription changed; retry explicitly');
  // Never include upstream errors, URLs, tokens or caller-controlled text.
  return fail(-32015,'Callback or subscription validation failed','challenge_failed');
 }
}
export async function dispatchEvent(env,eventJson){
 if(!eventsReady(env))return;
 const event=JSON.parse(eventJson),store=await storeFor(env),listing=await env.SUBSCRIPTIONS.list({prefix:'subscriptions/',limit:16});
 // Bounded single-owner MVP, no silent partial fanout.
 if(listing.truncated)throw new Error('Subscription limit exceeded');
 const owner=JSON.stringify([env.ACCESS_ISSUER,env.ACCESS_SUBJECT]);
 for(const object of listing.objects){
  const id=object.key.slice('subscriptions/'.length);
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await store.readActive(id,owner,Math.floor(Date.now()/1000));if(!snapshot)break;
   let retry=false;
   try{
    if(!await currentTokenAccepted(env,snapshot.record)){await store.revoke(id,owner,snapshot.etag);break;}
    // Re-read after authorization round trip; respect concurrent revocation/rotation.
    const fresh=await store.readActive(id,owner,Math.floor(Date.now()/1000));if(!fresh)break;
    const r=await signedPost(env,fresh.record,event.eventId,JSON.stringify(event));
    if(r.status>=200&&r.status<300)break;
    if(r.status===410){await store.revoke(id,owner,fresh.etag);break;}
    retry=r.status===429||r.status>=500;
   }catch{retry=true;}
   if(!retry||attempt===2)break;
   await new Promise(resolve=>setTimeout(resolve,200*(2**attempt)));
  }
 }
}
