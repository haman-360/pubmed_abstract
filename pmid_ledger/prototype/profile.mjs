// Local D1 metadata is diagnostic evidence, not cloud CPU time or an invoice estimate.
export function profiledDatabase(db, profile) {
  const unwrap = new WeakMap();
  function record(result) {
    const meta=result.meta;
    if(meta){profile.meta_samples++;profile.database_ms+=meta.duration??0;
      profile.rows_read+=meta.rows_read??0;profile.rows_written+=meta.rows_written??0;
      if(typeof meta.rows_read!=='number'||typeof meta.rows_written!=='number')profile.missing_rows_metadata++;}
    else profile.missing_rows_metadata++;
    return result;
  }
  function wrap(statement) {
    const wrapped={
      bind:(...values)=>wrap(statement.bind(...values)),
      all:async()=>{profile.statements++;return record(await statement.all());},
      run:async()=>{profile.statements++;return record(await statement.run());},
      first:async column=>{profile.statements++;const result=record(await statement.all());const row=result.results[0]??null;return column&&row?row[column]:row;}
    };
    unwrap.set(wrapped,statement);return wrapped;
  }
  return {prepare:sql=>wrap(db.prepare(sql)),batch:async statements=>{
    profile.statements+=statements.length;
    const result=await db.batch(statements.map(s=>unwrap.get(s)??s));return result.map(record);
  }};
}
export function newProfile() {
  return {statements:0,rows_read:0,rows_written:0,database_ms:0,meta_samples:0,missing_rows_metadata:0};
}
