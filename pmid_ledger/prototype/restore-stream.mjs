import {backupColumns} from './backup-data.mjs';
import {validateSnapshot} from './backup-pages.mjs';
import {consumeBackup} from './backup-client.mjs';
import {requireThat,hash,canonical} from './metadata.mjs';
import {operationRequest} from './operations.mjs';
import {rebuildGeneration} from './chunked.mjs';

async function validateHistory(db){
  let cursor=0;
  while(true){
    const {results}=await db.prepare('SELECT rowid cursor,id,request_hash,request_json FROM operations WHERE rowid>? ORDER BY rowid LIMIT 32').bind(cursor).all();
    if(!results.length)break;
    for(const o of results){const r=JSON.parse(o.request_json);requireThat(['reviews','complete','issue'].includes(r.kind),'invalid_operation_kind');
      requireThat(canonical(operationRequest(r,r.kind))===canonical(r)&&r.operation_id===o.id&&await hash(r)===o.request_hash,'invalid_operation_hash');cursor=o.cursor;}
  }
  const errors=await db.prepare(`SELECT
    EXISTS(SELECT 1 FROM review_events GROUP BY pmid HAVING min(version)<>1 OR count(*)<>max(version)) paper_sequence,
    EXISTS(SELECT 1 FROM issue_events GROUP BY issue_key HAVING min(version)<>1 OR count(*)<>max(version)) issue_sequence,
    EXISTS(SELECT 1 FROM review_events e LEFT JOIN review_events p ON p.pmid=e.pmid AND p.version=e.version-1
      WHERE e.status_updated_at IS NOT CASE WHEN COALESCE(p.status,'unreviewed')=e.status THEN COALESCE(p.status_updated_at,'') ELSE e.updated_at END) status_time,
    EXISTS(SELECT 1 FROM operations o WHERE
      NOT EXISTS(SELECT 1 FROM generations g WHERE g.id=json_extract(o.request_json,'$.revision')) OR
      (SELECT count(*) FROM review_events e WHERE e.operation_id=o.id)<>json_array_length(o.request_json,'$.changes') OR
      EXISTS(SELECT 1 FROM json_each(o.request_json,'$.changes') c WHERE NOT EXISTS(
        SELECT 1 FROM review_events e WHERE e.operation_id=o.id AND e.pmid=json_extract(c.value,'$.pmid')
        AND e.version=json_extract(c.value,'$.expected_version')+1 AND e.status=json_extract(c.value,'$.status')
        AND e.note=json_extract(c.value,'$.note') AND e.updated_at=o.created_at)) OR
      (SELECT count(*) FROM issue_events e WHERE e.operation_id=o.id)<>CASE WHEN json_extract(o.request_json,'$.kind')='reviews' THEN 0 ELSE 1 END OR
      EXISTS(SELECT 1 FROM issue_events e WHERE e.operation_id=o.id AND (e.issue_key IS NOT json_extract(o.request_json,'$.issue_key')
        OR e.version IS NOT json_extract(o.request_json,'$.expected_version')+1 OR e.status IS NOT json_extract(o.request_json,'$.status')
        OR e.content_version IS NOT json_extract(o.request_json,'$.content_version') OR e.updated_at IS NOT o.created_at)) OR
      (SELECT count(*) FROM operation_ids i WHERE i.operation_id=o.id)<>1+(json_extract(o.request_json,'$.review_operation_id') IS NOT NULL) OR
      NOT EXISTS(SELECT 1 FROM operation_ids i WHERE i.id=o.id AND i.operation_id=o.id) OR
      (json_extract(o.request_json,'$.review_operation_id') IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM operation_ids i WHERE i.id=json_extract(o.request_json,'$.review_operation_id') AND i.operation_id=o.id))) operation_links`).first();
  requireThat(Object.values(errors).every(n=>n===0),'invalid_backup_history');
  requireThat(!(await db.prepare('PRAGMA foreign_key_check').all()).results.length,'backup_foreign_key_failure');
}

export async function restoreStream(db,lines,triggers,{afterRows=async()=>{}}={}){
  const empty=Object.keys(backupColumns).map(n=>`(SELECT count(*) FROM ${n})`).join('+');
  await db.batch([db.prepare(`INSERT INTO publish_guard VALUES((SELECT CASE WHEN generation IS NULL AND (${empty})=0 THEN 1 ELSE 0 END FROM settings WHERE id=1))`),
    db.prepare('DROP TRIGGER apply_operation'),db.prepare('DROP TRIGGER operation_hash_guard'),db.prepare('DELETE FROM publish_guard')]);
  try{
    const receipt=await consumeBackup(lines,{
      onHeader:async s=>validateSnapshot(s),
      onRows:async part=>{
        const columns=backupColumns[part.table],before=(await db.prepare(`SELECT COALESCE(max(rowid),0) cursor FROM ${part.table}`).first()).cursor;
        const data=JSON.stringify(part.rows);
        if(new TextEncoder().encode(data).byteLength<=1900000){
          await db.prepare(`INSERT INTO ${part.table} (${columns.join(',')}) SELECT ${columns.map((_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`).bind(data).run();
        }else{
          // Old archives may contain one near-limit legacy JSON cell; bind it without another JSON envelope.
          await db.batch(part.rows.map(row=>db.prepare(`INSERT INTO ${part.table} (${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...row)));
        }
        const rows=(await db.prepare(`SELECT ${columns.join(',')} FROM ${part.table} WHERE rowid>? ORDER BY rowid`).bind(before).all()).results.map(r=>columns.map(c=>r[c]));
        requireThat(await hash(rows)===part.sha256,'restore_page_readback_mismatch');await afterRows(part);
      }
    });
    requireThat((await db.prepare('SELECT count(*) n FROM generations').first()).n===receipt.snapshot.generations.length,'restore_generation_count_mismatch');
    for(const g of receipt.snapshot.generations)await rebuildGeneration(db,g);
    await validateHistory(db);
    await db.batch([
      db.prepare(`INSERT INTO review_current SELECT e.pmid,e.version,e.status,e.note,e.status_updated_at,e.updated_at FROM review_events e
        WHERE NOT EXISTS(SELECT 1 FROM review_events n WHERE n.pmid=e.pmid AND n.version>e.version)`),
      db.prepare(`INSERT INTO issue_current SELECT e.issue_key,e.version,e.status,e.content_version,e.updated_at FROM issue_events e
        WHERE NOT EXISTS(SELECT 1 FROM issue_events n WHERE n.issue_key=e.issue_key AND n.version>e.version)`),
      ...triggers.map(sql=>db.prepare(sql)),
      db.prepare('UPDATE settings SET generation=? WHERE id=1').bind(receipt.snapshot.active_revision)
    ]);
    return {restored:true,revision:receipt.snapshot.active_revision,archive_hash:receipt.chain};
  }catch(e){
    // Only a fresh, private target is allowed. Nothing is published on failure; the CLI removes it.
    await db.batch(triggers.map(sql=>db.prepare(sql)));throw e;
  }
}
