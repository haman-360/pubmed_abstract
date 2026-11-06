// Loopback login test only. Forward a fixed fictional review, never arbitrary cloud writes.
export const CLOUD_TEST_ISSUE='["synthetic-small","感染症"]';
export const CLOUD_TEST_MAIN='["synthetic-main","感染症"]';
export const CLOUD_TEST_NOTE='クラウドTEST保存確認';
export const cloudOwnerPaths=new Set(['/api/listIssues','/api/listIssuePapers','/api/getPaperDetail','/api/saveReviews']);
export function validateCloudOrigin(value){
  if(!/^https:\/\/pmid-ledger-test\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(value??''))throw new Error('test_origin_required');
  return value;
}
function allowed(path,body){
  if(!body||typeof body!=='object'||Array.isArray(body))return false;
  if(path==='/api/listIssues')return Object.keys(body).length===1&&['all','recent'].includes(body.scope);
  if(path==='/api/listIssuePapers')return Object.keys(body).length===1&&[CLOUD_TEST_ISSUE,CLOUD_TEST_MAIN].includes(body.issue_key);
  if(path==='/api/getPaperDetail')return Object.keys(body).length===2&&body.issue_key===CLOUD_TEST_ISSUE&&body.pmid==='1';
  if(path!=='/api/saveReviews'||Object.keys(body).sort().join(',')!=='changes,operation_id,revision')return false;
  if(!Array.isArray(body.changes)||body.changes.length!==1)return false;
  const change=body.changes?.[0];
  return /^[A-Za-z0-9-]{16,80}$/.test(body.operation_id??'')&&/^[a-f0-9]{64}$/.test(body.revision??'')
    &&change&&Object.keys(change).sort().join(',')==='expected_version,note,pmid,status'
    &&change.pmid==='1'&&change.status==='want_fulltext'&&change.note===CLOUD_TEST_NOTE
    &&Number.isSafeInteger(change.expected_version)&&change.expected_version>=0;
}
export async function cloudLoginForward(request,origin){
  const fail=(error,status=403)=>new Response(JSON.stringify({error}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  try{validateCloudOrigin(origin);}catch{return fail('test_origin_required');}
  const path=new URL(request.url).pathname;
  if(!cloudOwnerPaths.has(path))return fail('cloud_test_route_denied');
  let bytes=0;const reader=request.body?.getReader(),parts=[];
  if(!reader)return fail('json_required',400);
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>8192){await reader.cancel();return fail('request_too_large',413);}parts.push(value);}}
  catch{return fail('request_body_unavailable',400);}
  finally{reader.releaseLock();}
  const buffer=new Uint8Array(bytes);let offset=0;for(const p of parts){buffer.set(p,offset);offset+=p.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{return fail('json_required',400);}
  if(!allowed(path,body))return fail('fixed_synthetic_test_only');
  try{
    const response=await fetch(origin+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json',Authorization:request.headers.get('Authorization'),'User-Agent':'PMIDLedgerTest/1.0'},body:JSON.stringify(body)});
    if(response.status>=300&&response.status<400)return fail('cloud_redirect_denied',502);
    if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return fail('cloud_response_unavailable',502);
    return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch{return fail('cloud_request_result_unknown_no_automatic_retry',502);}
}
