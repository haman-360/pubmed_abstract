// Local experiment only. Never deploy this mock-authentication entrypoint.
import {requireThat} from './metadata.mjs';
import {profiledDatabase,newProfile} from './profile.mjs';
import {readLimit} from './browse.mjs';
import {runLedgerAction} from './ledger-api.mjs';
export {backfillLists} from './ledger-api.mjs';

export default {
  async fetch(request, env) {
    const started=performance.now();let profile=null;
    const url = new URL(request.url);
    const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
    try {
      requireThat(env.LOCAL_PROTOTYPE === '1' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'local_only', 403);
      if (request.method === 'GET' && url.pathname === '/') return new Response(env.LOCAL_HTML, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
      if(request.method==='GET'&&['/backup-client.mjs','/metadata.mjs'].includes(url.pathname))return new Response(url.pathname==='/metadata.mjs'?env.LOCAL_METADATA:env.LOCAL_BACKUP_CLIENT,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}});
      requireThat(request.method === 'POST', 'post_required', 405);
      const origin = request.headers.get('Origin');
      requireThat(!origin || origin === url.origin, 'origin_denied', 403);
      requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'json_required', 415);
      const token = request.headers.get('Authorization');
      const syncing = url.pathname.startsWith('/sync/');
      requireThat(token === (syncing ? 'Bearer local-synthetic-sync' : 'Bearer local-synthetic-owner'), 'local_identity_denied', 403);
      const text = await request.text();
      requireThat(new TextEncoder().encode(text).byteLength <= 2000000, 'request_too_large', 413);
      const body = JSON.parse(text);
      profile=request.headers.get('X-Local-Profile')==='1'?newProfile():null;
      let db=profile?profiledDatabase(env.DB,profile):env.DB;
      const fault=request.headers.get('X-Local-Fault'),saving=['/api/saveReviews','/api/saveAndCompleteIssue','/api/saveIssueReview'].includes(url.pathname);
      if(fault==='read-limit')throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");
      if(saving&&fault==='rollback'){
        const base=db;
        db={prepare:sql=>base.prepare(sql),batch:statements=>base.batch([...statements,base.prepare('INSERT INTO publish_guard VALUES(0)')])};
      }
      const value=await runLedgerAction(db,url.pathname,body,{now:env.LOCAL_NOW?new Date(env.LOCAL_NOW):new Date()});
      if(saving&&fault==='drop-response')throw Object.assign(new Error('local_response_lost_retry_same_request'),{status:503});
      if(profile)profile.worker_wall_ms=performance.now()-started;
      return new Response(JSON.stringify({value,...(profile?{profile}:{})}), {headers});
    } catch (e) {
      const limited=readLimit(e,env.LOCAL_NOW?new Date(env.LOCAL_NOW):new Date());
      if(limited)return new Response(JSON.stringify(limited),{status:429,headers:{...headers,'Retry-After':String(limited.retry_after_seconds)}});
      const status = e.status ?? (/operation_id_reused|UNIQUE|conflict|remaining|CHECK|missing/.test(e.message) ? 409 : 400);
      return new Response(JSON.stringify({error: e.status ? e.message : status === 409 ? 'conflict_or_invalid_atomic_operation' : 'invalid_request_or_database_failure'}), {status, headers});
    }
  }
};
