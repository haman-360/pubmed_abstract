// JWT policy only. Keys come from trusted configuration/providers, never token URLs or claims.
import {decodeProtectedHeader,jwtVerify} from 'jose';
function deny(ok){if(!ok)throw new Error('identity_denied');}
export function validateIdentityConfig(config){
  deny(config&&/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId??''));
  deny(typeof config.ownerUid==='string'&&config.ownerUid.length>0&&config.ownerUid.length<=128);
  deny(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(config.accessIssuer??''));
  deny(/^[a-f0-9]{64}$/.test(config.accessAudience??'')&&/^[A-Za-z0-9._-]{1,240}\.access$/.test(config.syncClientId??''));
}
export function createIdentityVerifier(config,{ownerKeys,syncKeys,now=()=>new Date()}){
  validateIdentityConfig(config);deny(typeof ownerKeys==='function'&&typeof syncKeys==='function');
  const ownerIssuer='https://securetoken.google.com/'+config.projectId;
  async function verify(token,role){
    deny(typeof token==='string'&&token.length>0&&token.length<=16384);
    const header=decodeProtectedHeader(token);
    deny(header.alg==='RS256'&&typeof header.kid==='string'&&header.kid.length>0&&header.kid.length<=256);
    deny(!header.jku&&!header.jwk&&!header.x5u&&(header.typ===undefined||header.typ==='JWT'));
    const date=now(),seconds=Math.floor(date.getTime()/1000);deny(Number.isSafeInteger(seconds));
    const owner=role==='owner';deny(owner||role==='sync');
    const {payload}=await jwtVerify(token,owner?ownerKeys:syncKeys,{
      algorithms:['RS256'],issuer:owner?ownerIssuer:config.accessIssuer,audience:owner?config.projectId:config.accessAudience,
      requiredClaims:owner?['iss','aud','sub','iat','exp','auth_time']:['iss','aud','sub','iat','exp','type','common_name'],
      currentDate:date,clockTolerance:0
    });
    deny(Number.isSafeInteger(payload.iat)&&payload.iat>=0&&payload.iat<=seconds&&Number.isSafeInteger(payload.exp)&&payload.exp>payload.iat);
    if(owner){
      deny(payload.aud===config.projectId&&payload.sub===config.ownerUid);
      deny(Number.isSafeInteger(payload.auth_time)&&payload.auth_time>=0&&payload.auth_time<=payload.iat);
      deny(payload.firebase?.sign_in_provider==='google.com');
      return {role:'owner'};
    }
    deny(payload.type==='app'&&payload.sub===''&&payload.common_name===config.syncClientId);
    return {role:'sync'};
  }
  return {verify};
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
