// JWT policy only. Keys come from trusted configuration/providers, never token URLs or claims.
import {decodeProtectedHeader,jwtVerify} from 'jose';
function deny(ok){if(!ok)throw new Error('identity_denied');}
function validateProject(projectId){deny(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId??''));}
export function validateIdentityConfig(config){
  deny(config);validateProject(config.projectId);
  deny(typeof config.ownerUid==='string'&&config.ownerUid.length>0&&config.ownerUid.length<=128);
  deny(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(config.accessIssuer??''));
  deny(/^[a-f0-9]{64}$/.test(config.accessAudience??'')&&/^[A-Za-z0-9._-]{1,240}\.access$/.test(config.syncClientId??''));
}
async function signedClaims(token,keys,options,now){
  deny(typeof token==='string'&&token.length>0&&token.length<=16384);
  const header=decodeProtectedHeader(token);
  deny(header.alg==='RS256'&&typeof header.kid==='string'&&header.kid.length>0&&header.kid.length<=256);
  deny(!header.jku&&!header.jwk&&!header.x5u&&(header.typ===undefined||header.typ==='JWT'));
  const date=now(),seconds=Math.floor(date.getTime()/1000);deny(Number.isSafeInteger(seconds));
  const {payload}=await jwtVerify(token,keys,{...options,algorithms:['RS256'],currentDate:date,clockTolerance:0});
  deny(Number.isSafeInteger(payload.iat)&&payload.iat>=0&&payload.iat<=seconds&&Number.isSafeInteger(payload.exp)&&payload.exp>payload.iat);
  return payload;
}
export function createOwnerVerifier(config,{ownerKeys,now=()=>new Date()}){
  validateProject(config?.projectId);deny(typeof ownerKeys==='function');
  deny(config.ownerUid===null||(typeof config.ownerUid==='string'&&config.ownerUid.length>0&&config.ownerUid.length<=128));
  async function probe(token){
    const p=await signedClaims(token,ownerKeys,{issuer:'https://securetoken.google.com/'+config.projectId,audience:config.projectId,
      requiredClaims:['iss','aud','sub','iat','exp','auth_time']},now);
    deny(p.aud===config.projectId&&typeof p.sub==='string'&&p.sub.length>0&&p.sub.length<=128);
    deny(Number.isSafeInteger(p.auth_time)&&p.auth_time>=0&&p.auth_time<=p.iat&&p.firebase?.sign_in_provider==='google.com');
    // An identity probe returns no permission. UID must be pinned separately by the local operator.
    return {uid:p.sub,email:typeof p.email==='string'?p.email:'',emailVerified:p.email_verified===true};
  }
  return {probe,verify:async token=>{deny(config.ownerUid!==null);const p=await probe(token);deny(p.uid===config.ownerUid);return {role:'owner'};}};
}
export function createIdentityVerifier(config,{ownerKeys,syncKeys,now=()=>new Date()}){
  validateIdentityConfig(config);deny(typeof syncKeys==='function');const owner=createOwnerVerifier(config,{ownerKeys,now});
  return {verify:async(token,role)=>{
    if(role==='owner')return owner.verify(token);deny(role==='sync');
    const p=await signedClaims(token,syncKeys,{issuer:config.accessIssuer,audience:config.accessAudience,
      requiredClaims:['iss','aud','sub','iat','exp','type','common_name']},now);
    deny(p.type==='app'&&p.sub===''&&p.common_name===config.syncClientId);return {role:'sync'};
  }};
}
const ownerRoutes=new Set(['listIssues','listIssuePapers','getPaperDetail','saveReviews','saveAndCompleteIssue','saveIssueReview','backup','backupStart','backupPage'].map(n=>'/api/'+n));
const syncRoutes=new Set(['status','begin','chunk','build','finish','read','stage','publish'].map(n=>'/sync/'+n));
export async function verifyIdentityRequest(request,verifier){
  const path=new URL(request.url).pathname,authorization=request.headers.get('Authorization'),access=request.headers.get('Cf-Access-Jwt-Assertion');
  if(ownerRoutes.has(path)){
    deny(!access&&typeof authorization==='string'&&authorization.startsWith('Bearer '));
    return verifier.verify(authorization.slice(7),'owner');
  }
  deny(syncRoutes.has(path)&&!authorization&&typeof access==='string');
  return verifier.verify(access,'sync');
}
