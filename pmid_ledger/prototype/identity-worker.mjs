// Disposable local verification harness. This is NOT a deployable cloud entry point.
import {createLocalJWKSet} from 'jose';
import {createIdentityVerifier,verifyIdentityRequest} from './identity.mjs';
import ledger from './worker.mjs';
import {createPublicKeySources} from './identity-keys.mjs';
let cached;
function verifier(env){
  if(cached?.source===env.LOCAL_IDENTITY_FIXTURE)return cached.value;
  const fixture=JSON.parse(env.LOCAL_IDENTITY_FIXTURE);
  let keys;
  if(fixture.remoteKeys)keys=createPublicKeySources(fixture.config);
  else{
    for(const set of [fixture.ownerJwks,fixture.syncJwks]){
      if(!Array.isArray(set?.keys)||!set.keys.length||set.keys.length>8||set.keys.some(k=>k.kty!=='RSA'||!k.kid||['d','p','q','dp','dq','qi','oth'].some(n=>n in k)))throw new Error('invalid_public_keys');
    }
    keys={ownerKeys:createLocalJWKSet(fixture.ownerJwks),syncKeys:createLocalJWKSet(fixture.syncJwks)};
  }
  const value=createIdentityVerifier(fixture.config,{...keys,now:()=>env.LOCAL_NOW?new Date(env.LOCAL_NOW):new Date()});
  cached={source:env.LOCAL_IDENTITY_FIXTURE,value};return value;
}
export default {
  async fetch(request,env){
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    const error=(code,status)=>new Response(JSON.stringify({error:code}),{status,headers});
    if(env.LOCAL_PROTOTYPE!=='1'||!['127.0.0.1','localhost'].includes(new URL(request.url).hostname))return error('local_only',403);
    let check;try{check=verifier(env);}catch{return error('identity_configuration_invalid',503);}
    let identity;try{identity=await verifyIdentityRequest(request,check);}catch{return error('identity_denied',403);}
    // The existing local ledger keeps its own mock gate; only a verified JWT reaches this adapter.
    const forwarded=new Headers(request.headers);forwarded.delete('Cf-Access-Jwt-Assertion');forwarded.delete('X-Local-Fault');
    forwarded.set('Authorization',identity.role==='sync'?'Bearer local-synthetic-sync':'Bearer local-synthetic-owner');
    return ledger.fetch(new Request(request,{headers:forwarded}),env);
  }
};
