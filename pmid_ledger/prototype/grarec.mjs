import {requireThat} from './metadata.mjs';

// Create the additive tables in the authenticated owner's transaction, including on existing D1 databases.
export async function updateGrarec(db, action, body) {
  const schema = [
    'CREATE TABLE IF NOT EXISTS grarec_receiver (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS grarec_queue (pmid TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0)',
    'CREATE INDEX IF NOT EXISTS grarec_pending ON grarec_queue(received,pmid)'
  ].map(sql => db.prepare(sql));
  if (action === 'pair') {
    requireThat(typeof body.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(body.fingerprint), 'invalid_mac_code');
    await db.batch([...schema, db.prepare('INSERT OR REPLACE INTO grarec_receiver VALUES (1,?)').bind(body.fingerprint)]);
    return {paired:true};
  }
  const results = await db.batch([...schema, db.prepare(`INSERT OR IGNORE INTO grarec_queue(pmid)
    SELECT pmid FROM review_current WHERE status='want_fulltext'`),
    db.prepare('SELECT count(*) pending FROM grarec_queue WHERE received=0')]);
  return {added:results.at(-2).meta.changes, pending:results.at(-1).results[0].pending};
}

export async function receiveGrarec(db, authorization, body) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '');
  requireThat(match, 'mac_pairing_required', 403);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
  const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  const ack = body.received ?? [];
  requireThat(Array.isArray(ack) && ack.length <= 100 && ack.every(id => typeof id === 'string' && /^[1-9][0-9]{0,8}$/.test(id)), 'invalid_receipt');
  const authorized = 'EXISTS (SELECT 1 FROM grarec_receiver WHERE id=1 AND fingerprint=?)';
  // Check the active Mac in the same transaction as both acknowledgement and read.
  const statements = [db.prepare('SELECT 1 ok FROM grarec_receiver WHERE id=1 AND fingerprint=?').bind(fingerprint)];
  if (ack.length) statements.push(db.prepare(`UPDATE grarec_queue SET received=1 WHERE received=0 AND ${authorized}
    AND pmid IN (SELECT value FROM json_each(?))`).bind(fingerprint, JSON.stringify(ack)));
  statements.push(db.prepare(`SELECT pmid FROM grarec_queue WHERE ${authorized} AND received=0 ORDER BY pmid LIMIT 100`).bind(fingerprint));
  const results = await db.batch(statements);
  requireThat(results[0].results.length === 1, 'mac_pairing_required', 403);
  return {pmids:results.at(-1).results.map(row => row.pmid)};
}
