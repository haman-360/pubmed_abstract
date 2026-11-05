// Public fixture identifiers only. Private keys/tokens are created in memory for each test run.
import {generateKeyPair,exportJWK,SignJWT,exportPKCS8} from 'jose';
import {spawn} from 'node:child_process';
export const now=new Date('2026-11-05T03:00:00.000Z'),seconds=Math.floor(now.getTime()/1000);
export async function identityFixture({extractable=false}={}){
  const owner=await generateKeyPair('RS256',{extractable}),sync=await generateKeyPair('RS256',{extractable});
  const ownerJwk={...await exportJWK(owner.publicKey),kid:'synthetic-owner',alg:'RS256',use:'sig'};
  const syncJwk={...await exportJWK(sync.publicKey),kid:'synthetic-sync',alg:'RS256',use:'sig'};
  const config={projectId:'synthetic-ledger-auth',ownerUid:'synthetic-owner-uid',accessIssuer:'https://synthetic-ledger.cloudflareaccess.com',accessAudience:'a'.repeat(64),syncClientId:'synthetic-sync.access'};
  const ownerPayload={iss:'https://securetoken.google.com/'+config.projectId,aud:config.projectId,sub:config.ownerUid,
    iat:seconds-10,exp:seconds+300,auth_time:seconds-100,firebase:{sign_in_provider:'google.com'}};
  const syncPayload={iss:config.accessIssuer,aud:[config.accessAudience],sub:'',iat:seconds-10,exp:seconds+300,type:'app',common_name:config.syncClientId};
  const sign=(payload,privateKey,kid,header={})=>new SignJWT(payload).setProtectedHeader({alg:'RS256',typ:'JWT',kid,...header}).sign(privateKey);
  return {fixture:{config,ownerJwks:{keys:[ownerJwk]},syncJwks:{keys:[syncJwk]}},owner,ownerJwk,sync,ownerPayload,syncPayload,sign,
    ownerToken:(changes={},header={})=>sign({...ownerPayload,...changes},owner.privateKey,ownerJwk.kid,header),
    syncToken:(changes={},header={})=>sign({...syncPayload,...changes},sync.privateKey,syncJwk.kid,header)};
}

export async function certificate(key){
  const pem=await exportPKCS8(key);
  return new Promise((resolve,reject)=>{
    // The test-only private key travels via stdin, never argv or a temporary file.
    const child=spawn('/usr/bin/openssl',['req','-new','-x509','-key','/dev/stdin','-subj','/CN=synthetic-identity-test','-days','2'],{stdio:['pipe','pipe','ignore']});
    const output=[];child.stdout.on('data',b=>output.push(b));child.on('error',reject);
    child.on('close',code=>code===0?resolve(Buffer.concat(output).toString('utf8')):reject(new Error('synthetic certificate generation failed')));
    child.stdin.end(pem);
  });
}
