// LOCAL_PREVIEW_ONLY. Disposable fictional data/identity; never reads workplace secrets or reaches Cloudflare.
import http from 'node:http';
import {runtime,fixture,seedDatabase} from './runtime.mjs';
import {onlineAssets} from './online-build.mjs';
import {identityFixture,certificate} from './tests/identity-fixture.mjs';
import {hash} from './metadata.mjs';
const f=await identityFixture({extractable:true}),cert=await certificate(f.owner.privateKey),seconds=Math.floor(Date.now()/1000);
const token=await f.ownerToken({iat:seconds-1,exp:seconds+7200,auth_time:seconds-10}),origin='https://pmid-ledger-test.synthetic.workers.dev';
const firebase={apiKey:'AIza'+'x'.repeat(35),projectId:f.fixture.config.projectId,authDomain:f.fixture.config.projectId+'.firebaseapp.com',appId:'1:123:web:abc123'};
const assets=await onlineAssets(firebase);
assets['']=assets[''].replace('TEST · 架空データ','ローカル画面試験').replace('Googleでログイン','画面試験ログイン').replace('本人専用 · オンライン接続が必要です','架空の署名と一時DBだけを使用。クラウドへ接続しません。');
assets['sdk.mjs']=`// LOCAL_PREVIEW_ONLY
let changed;const user={getIdToken:async()=>${JSON.stringify(token)}};
export const initializeApp=x=>x,inMemoryPersistence={},browserPopupRedirectResolver={};
export const initializeAuth=()=>({}),GoogleAuthProvider=class{setCustomParameters(){}};
export function onAuthStateChanged(a,fn){changed=fn;fn(null);}
export async function signInWithPopup(){changed(user);}export async function signOut(){changed(null);}`;
const rt=await runtime({cloudTest:{onlineAssets:assets,bindings:{LEDGER_TEST_ONLY:'synthetic',LEDGER_ORIGIN:origin,LEDGER_SYNC_ENABLED:'0',LEDGER_IDENTITY:JSON.stringify({projectId:firebase.projectId,ownerUid:f.fixture.config.ownerUid})},keyResponses:()=>Response.json({[f.ownerJwk.kid]:cert},{headers:{'Cache-Control':'max-age=3600'}})}});
const data=fixture(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
for(const row of data.tables.Issues.slice(1))if(row[3]==='2026-08-20')row[3]=today;
for(const row of data.tables.Appearances.slice(1))if(row[4]==='2026-08-20')row[4]=today;
data.generation=await hash(data.tables);await seedDatabase(rt.db,data);
const server=http.createServer(async(req,res)=>{
  try{
    if(!['127.0.0.1:8790','localhost:8790'].includes(req.headers.host))throw Error();
    if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)throw Error();
    if(req.url==='/'){res.writeHead(302,{Location:'/api/app/'});res.end();return;}
    const headers=new Headers(req.headers);headers.delete('Host');headers.delete('Origin');let size=0;const parts=[];
    for await(const part of req){size+=part.length;if(size>300000)throw Error();parts.push(part);}
    const response=await rt.mf.dispatchFetch(origin+req.url,{method:req.method,headers,...(parts.length?{body:Buffer.concat(parts)}:{})});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(403,{'Content-Type':'text/plain'});res.end('Local preview only');}
});
server.listen(8790,'127.0.0.1',()=>console.log('ローカル画面試験: http://localhost:8790/api/app/ （架空署名・一時DBのみ）'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{server.close();await rt.mf.dispose();process.exit(0);});
