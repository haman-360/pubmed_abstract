import {hash,requireThat} from './metadata.mjs';
// Bounded pages; the complete archive is never assembled in a Worker or a SQL value.
export async function* downloadBackup(call){
  const snapshot=await call('backupStart',{}),header={type:'header',snapshot};
  let chain=await hash(header),sequence=0;const counts={};yield JSON.stringify(header);
  for(const table of Object.keys(snapshot.columns)){
    counts[table]=0;let cursor=0;
    while(true){const page=await call('backupPage',{snapshot,table,cursor});
      requireThat(await hash(page.rows)===page.sha256,'backup_page_hash_mismatch');
      if(page.rows.length){const line={type:'rows',table,sequence,rows:page.rows,sha256:page.sha256};
        chain=await hash([chain,table,sequence,page.sha256,page.rows.length]);sequence++;counts[table]+=page.rows.length;yield JSON.stringify(line);}
      if(page.done)break;requireThat(page.next>cursor,'backup_cursor_stalled');cursor=page.next;
    }
    requireThat(counts[table]===snapshot.counts[table],'backup_count_mismatch');
  }
  yield JSON.stringify({type:'footer',chain,counts});
}
export async function consumeBackup(lines,{onHeader=async()=>{},onRows=async()=>{}}={}){
  let header=null,chain=null,sequence=0,footer=false;const counts={};
  for await(const text of lines){
    requireThat(!footer&&text.length>0&&new TextEncoder().encode(text).byteLength<=8000000,'invalid_backup_line');const line=JSON.parse(text);
    if(!header){requireThat(line.type==='header','backup_header_required');header=line;chain=await hash(line);await onHeader(line.snapshot);continue;}
    if(line.type==='rows'){
      requireThat(Object.hasOwn(header.snapshot.columns,line.table)&&line.sequence===sequence&&Array.isArray(line.rows)&&line.rows.length>0,'invalid_backup_rows');
      requireThat(line.rows.every(r=>Array.isArray(r)&&r.length===header.snapshot.columns[line.table].length&&r.every(v=>typeof v==='string'||Number.isSafeInteger(v))),'invalid_backup_values');
      requireThat(await hash(line.rows)===line.sha256,'backup_chunk_checksum_mismatch');
      chain=await hash([chain,line.table,sequence,line.sha256,line.rows.length]);sequence++;counts[line.table]=(counts[line.table]??0)+line.rows.length;await onRows(line);
    }else{
      requireThat(line.type==='footer'&&line.chain===chain,'backup_footer_checksum_mismatch');
      for(const table of Object.keys(header.snapshot.columns))requireThat((counts[table]??0)===header.snapshot.counts[table]&&line.counts[table]===header.snapshot.counts[table],'backup_footer_count_mismatch');
      footer=true;
    }
  }
  requireThat(header&&footer,'backup_truncated');return {snapshot:header.snapshot,chain};
}
