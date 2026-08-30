// OFFLINE UI verification only. No Google credentials, external calls, or disk state writes.
// Deploy only Code.gs, Index.html and appsscript.json to GAS; never deploy this file.
import http from 'node:http';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { papers, appearances, settings, title } from './fixtures.mjs';
const ctx = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('./Code.gs', import.meta.url), 'utf8'), ctx);
const clone = v => JSON.parse(JSON.stringify(v));
const values = { Papers: [clone(ctx.Phase0.paperHeaders), ...papers.map(p => clone(ctx.Phase0.paperHeaders).map(h => p[h]))],
  Appearances: [clone(ctx.Phase0.snapshotHeaders), ...appearances.map(p => clone(ctx.Phase0.snapshotHeaders).map(h => p[h]))], _Settings: clone(settings) };
const sheet = name => ({ getLastRow: () => values[name].length, getRange: (r, c, nr = 1, nc = 1) => {
  if (r === 'A1:B3') [r,c,nr,nc] = [1,1,3,2];
  const get = () => values[name].slice(r-1,r-1+nr).map(row=>row.slice(c-1,c-1+nc));
  return { getValues: () => clone(get()), getDisplayValues: () => get().map(row=>row.map(String)), setValues: data => {
    if(name !== 'Papers' || c !== 5 || nc !== 4 || nr !== 1) throw new Error('Unsafe preview write');
    values[name][r-1].splice(c-1,nc,...data[0]);
  }};
}});
ctx.PropertiesService = {getScriptProperties: () => ({getProperty: () => 'preview@example.test'})};
ctx.Session = {getActiveUser: () => ({getEmail: () => 'preview@example.test'}), getEffectiveUser: () => ({getEmail: () => 'preview@example.test'})};
ctx.SpreadsheetApp = {openById: () => ({getName: () => title, getSheetByName: sheet}), flush() {}};
ctx.LockService = {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})};
ctx.Utilities = {formatDate: () => '2026-08-30'};
const bridge = `<script>
window.google = {script:{get run(){
  let success=()=>{},failure=()=>{};
  return new Proxy({}, {get(target,key){
    if(key==='withSuccessHandler')return fn=>{success=fn;return new Proxy(target,this)};
    if(key==='withFailureHandler')return fn=>{failure=fn;return new Proxy(target,this)};
    return arg=>fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:key,arg})})
      .then(r=>r.json()).then(r=>r.error?failure({message:r.error}):success(r.result)).catch(failure);
  }});
}}};
</script>`;
const server = http.createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.headers.host !== '127.0.0.1:8765') {res.writeHead(403);res.end();return;}
  if(req.method === 'GET' && ['/tablet','/narrow'].includes(req.url)) {
    const width=req.url==='/tablet'?768:390;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="ja"><title>Offline ${width}px layout test</title><body><p>幅${width}pxのChrome表示試験（iPad実機ではありません）</p><iframe title="TEST layout" src="/" width="${width}" height="1050" style="border:1px solid #ccc"></iframe></body></html>`); return;
  }
  if(req.method === 'GET' && req.url === '/') {
    let html=await fs.readFile(new URL('./Index.html',import.meta.url),'utf8');
    html=html.replace('<script>',bridge+'<script>').replace('TEST ONLY · PHASE 0','OFFLINE PREVIEW · Google認証・実保存の検証ではありません');
    res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return;
  }
  if(req.method === 'POST' && req.url === '/rpc' && req.headers.origin === 'http://127.0.0.1:8765') {
    res.setHeader('Content-Type','application/json; charset=utf-8');
    try {
      let body=''; for await(const chunk of req){body+=chunk;if(body.length>10000)throw new Error('Too large');}
      const {name,arg}=JSON.parse(body);
      if(!['listPapers','getPaperDetail','changeStatus','exportWanted'].includes(name)) throw new Error('Unsupported operation');
      res.end(JSON.stringify({result:ctx[name](arg)}));
    } catch(e) {res.end(JSON.stringify({error:e.message}));} return;
  }
  res.writeHead(404);res.end();
});
server.listen(8765,'127.0.0.1',()=>console.log('Offline preview: http://127.0.0.1:8765 (sample state held in memory; Ctrl-C stops)'));
