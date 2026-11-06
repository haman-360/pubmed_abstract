// Existing TEST only: fictional data or an explicitly bounded real-data copy. Owner APIs require signed Google identity.
import {createIdentityVerifier,createOwnerVerifier,verifyIdentityRequest} from './identity.mjs';
import {createPublicKeySources,createOwnerKeySource} from './identity-keys.mjs';
import {runLedgerAction} from './ledger-api.mjs';
import {newProfile,profiledDatabase} from './profile.mjs';
import {requireThat} from './metadata.mjs';
import {readLimit} from './browse.mjs';
import {onlineResponse} from './online-static.mjs';

const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...headers,...extra}});
let cached;
function configuration(env){
  requireThat(env.LEDGER_TEST_ONLY==='synthetic'&&env.DB&&
    /^https:\/\/pmid-ledger-test\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(env.LEDGER_ORIGIN??''),'test_configuration_invalid',503);
  requireThat(env.LEDGER_SYNC_ENABLED===undefined||['0','1'].includes(env.LEDGER_SYNC_ENABLED),'test_configuration_invalid',503);
  const source=env.LEDGER_IDENTITY,enabled=env.LEDGER_SYNC_ENABLED==='1';
  if(cached?.source===source&&cached.enabled===enabled)return cached.verifier;
  const config=JSON.parse(source);
  requireThat(typeof config.ownerUid==='string'&&config.ownerUid.length>0,'test_configuration_invalid',503);
  let verifier;
  if(enabled)verifier=createIdentityVerifier(config,createPublicKeySources(config));
  else{
    const owner=createOwnerVerifier(config,{ownerKeys:createOwnerKeySource()});
    verifier={verify:(token,role)=>{requireThat(role==='owner','sync_disabled',403);return owner.verify(token);}};
  }
  cached={source,enabled,verifier};return verifier;
}
async function bodyJson(request){
  const declared=request.headers.get('Content-Length');
  requireThat(declared===null||(/^\d+$/.test(declared)&&Number(declared)<=2000000),'request_too_large',413);
  const reader=request.body?.getReader();requireThat(reader,'json_required');
  const chunks=[];let size=0;
  try{
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
      requireThat(size<=2000000,'request_too_large',413);chunks.push(value);}
  }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  requireThat(value&&typeof value==='object'&&!Array.isArray(value),'json_object_required');return value;
}
export default {
  async fetch(request,env){
    const started=performance.now();let verifier;
    try{verifier=configuration(env);}catch{return json({error:'test_configuration_invalid'},503);}
    try{
      const url=new URL(request.url);
      requireThat(url.origin===env.LEDGER_ORIGIN&&!url.search,'test_origin_required',403);
      requireThat(!request.headers.has('Origin')||request.headers.get('Origin')===url.origin,'origin_denied',403);
      if(request.method==='GET'&&url.pathname.startsWith('/api/app/'))return onlineResponse(url.pathname,JSON.parse(env.LEDGER_IDENTITY).projectId);
      requireThat(request.method==='POST','post_required',405);
      requireThat(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()==='application/json','json_required',415);
      // Only signature-verified identities reach D1. Client ID/Secret alone never grants permission.
      try{await verifyIdentityRequest(request,verifier);}catch{return json({error:'identity_denied'},403);}
      const body=await bodyJson(request),profile=env.LEDGER_TEST_DIAGNOSTICS==='1'?newProfile():null;
      const value=await runLedgerAction(profile?profiledDatabase(env.DB,profile):env.DB,url.pathname,body);
      if(profile)profile.worker_wall_ms=performance.now()-started; // Not CPU time.
      return json({value,...(profile?{profile}:{})});
    }catch(e){
      const limited=readLimit(e,new Date());
      if(limited)return json(limited,429,{'Retry-After':String(limited.retry_after_seconds)});
      const status=e.status??(/operation_id_reused|UNIQUE|conflict|remaining|CHECK|missing/.test(e.message)?409:400);
      return json({error:e.status?e.message:status===409?'conflict_or_invalid_atomic_operation':'invalid_request_or_database_failure'},status);
    }
  }
};
