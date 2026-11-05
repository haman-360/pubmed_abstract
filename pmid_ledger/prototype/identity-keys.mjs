import {createLocalJWKSet,importX509} from 'jose';
import {validateIdentityConfig} from './identity.mjs';
export const FIREBASE_CERTS='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const MAX_BYTES=65536,REFRESH_COOLDOWN=30000;
function check(ok){if(!ok)throw new Error('identity_key_unavailable');}
function cacheMilliseconds(headers){
  const policy=headers.get('Cache-Control')??'';
  if(/(?:^|,)\s*(?:no-store|no-cache)(?:=|\s|,|$)/i.test(policy))return 0;
  const match=policy.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s|,|$)/i),age=Number(headers.get('Age')??0);
  if(!match||!Number.isSafeInteger(Number(match[1]))||!Number.isFinite(age)||age<0)return 0;
  return Math.max(0,Math.min(86400,Number(match[1])-age))*1000;
}
async function boundedJson(response){
  check(response.status===200&&response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()==='application/json');
  const length=Number(response.headers.get('Content-Length')??0);check(Number.isFinite(length)&&length>=0&&length<=MAX_BYTES);
  const reader=response.body?.getReader();check(reader);const parts=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;check(size<=MAX_BYTES);parts.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const buffer=new Uint8Array(size);let offset=0;for(const p of parts){buffer.set(p,offset);offset+=p.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
}
async function resolverFor(data,format){
  if(format==='firebase'){
    check(data&&typeof data==='object'&&!Array.isArray(data));const entries=Object.entries(data);
    check(entries.length>0&&entries.length<=16);const keys=new Map();
    for(const [kid,cert]of entries){check(kid.length>0&&kid.length<=256&&typeof cert==='string');keys.set(kid,await importX509(cert,'RS256'));}
    return {has:kid=>keys.has(kid),get:header=>keys.get(header.kid)};
  }
  check(Array.isArray(data?.keys)&&data.keys.length>0&&data.keys.length<=16);
  const ids=new Set();
  for(const k of data.keys){check(k&&k.kty==='RSA'&&typeof k.kid==='string'&&k.kid.length>0&&k.kid.length<=256&&!ids.has(k.kid)
    &&typeof k.n==='string'&&typeof k.e==='string'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig')
    &&!['d','p','q','dp','dq','qi','oth'].some(n=>n in k));ids.add(k.kid);}
  const get=createLocalJWKSet(data);return {has:kid=>ids.has(kid),get};
}
function source(url,format,{fetcher,now}){
  let cached,inflight,lastRefresh=-Infinity;
  async function refresh(){
    if(inflight)return inflight;
    const started=now();check(Number.isFinite(started));lastRefresh=started;
    inflight=(async()=>{
      let response;
      try{
        response=await fetcher(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000)});
        check(!response.redirected);const data=await boundedJson(response),resolve=await resolverFor(data,format);
        cached={...resolve,expires:started+cacheMilliseconds(response.headers)};
      }catch{await response?.body?.cancel().catch(()=>{});throw new Error('identity_key_unavailable');}
    })();
    try{await inflight;}finally{inflight=null;}
  }
  return async header=>{
    check(header?.alg==='RS256'&&typeof header.kid==='string'&&header.kid.length>0&&header.kid.length<=256);
    if(!cached||cached.expires<=now())await refresh();
    else if(!cached.has(header.kid)&&now()-lastRefresh>=REFRESH_COOLDOWN)await refresh();
    check(cached.has(header.kid));return cached.get(header);
  };
}
export function createPublicKeySources(config,{fetcher=fetch,now=()=>Date.now()}={}){
  validateIdentityConfig(config);
  return {ownerKeys:source(FIREBASE_CERTS,'firebase',{fetcher,now}),
    syncKeys:source(config.accessIssuer+'/cdn-cgi/access/certs','access',{fetcher,now})};
}
export function createOwnerKeySource({fetcher=fetch,now=()=>Date.now()}={}){
  return source(FIREBASE_CERTS,'firebase',{fetcher,now});
}
