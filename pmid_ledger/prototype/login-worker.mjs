// Local Google-login diagnostic only; no cloud deployment and no automatic owner enrollment.
import {createOwnerVerifier} from './identity.mjs';
import {createOwnerKeySource} from './identity-keys.mjs';
import ledger from './worker.mjs';
import {cloudLoginForward} from './cloud-login-proxy.mjs';
const ownerKeys=createOwnerKeySource();
const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:jsonHeaders});
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(env.LOCAL_PROTOTYPE!=='1'||!['localhost','127.0.0.1'].includes(url.hostname))return json({error:'local_only'},403);
    if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'origin_denied'},403);
    if(request.method==='GET'&&url.pathname==='/')return new Response(env.LOCAL_LOGIN_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    if(request.method==='GET'&&['/login-client.mjs','/firebase-sdk.mjs'].includes(url.pathname))return new Response(url.pathname==='/login-client.mjs'?env.LOCAL_LOGIN_CLIENT:env.LOCAL_LOGIN_SDK,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}});
    let settings;try{const r=await env.LOCAL_LOGIN_SETTINGS.fetch('http://local-settings/');if(!r.ok)throw new Error();settings=await r.json();}catch{return json({error:'local_settings_unavailable'},503);}
    if(request.method==='GET'&&url.pathname==='/login-config')return json({firebase:settings.firebase});
    if(request.method!=='POST'||request.headers.get('Content-Type')?.split(';')[0]!=='application/json')return json({error:'json_post_required'},400);
    if(!url.pathname.startsWith('/api/')&&url.pathname!=='/identity/probe')return json({error:'route_denied'},403);
    if(request.headers.has('Cf-Access-Jwt-Assertion'))return json({error:'identity_denied'},403);
    const authorization=request.headers.get('Authorization');
    if(!authorization?.startsWith('Bearer '))return json({error:'identity_denied'},403);
    const token=authorization.slice(7);let verifier;
    try{verifier=createOwnerVerifier({projectId:settings.firebase.projectId,ownerUid:settings.ownerUid},{ownerKeys,now:()=>env.LOCAL_NOW?new Date(env.LOCAL_NOW):new Date()});}
    catch{return json({error:'local_settings_unavailable'},503);}
    if(url.pathname==='/identity/probe'){
      try{const identity=await verifier.probe(token);return json({...identity,ownerConfigured:settings.ownerUid!==null,ownerAllowed:settings.ownerUid!==null&&identity.uid===settings.ownerUid});}
      catch{return json({error:'identity_denied'},403);}
    }
    if(settings.ownerUid===null)return json({error:'owner_not_configured'},403);
    try{await verifier.verify(token);}catch{return json({error:'identity_denied'},403);}
    if(env.LOCAL_CLOUD_ORIGIN)return cloudLoginForward(request,env.LOCAL_CLOUD_ORIGIN);
    const headers=new Headers(request.headers);headers.set('Authorization','Bearer local-synthetic-owner');headers.delete('X-Local-Fault');
    return ledger.fetch(new Request(request,{headers}),env);
  }
};
