-- Statements are separated by the marker below; triggers remain single statements.
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, tables_json TEXT NOT NULL
);
-- statement
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT REFERENCES generations(id)
);
-- statement
INSERT OR IGNORE INTO settings VALUES(1,NULL);
-- statement
CREATE TABLE IF NOT EXISTS papers (
  generation TEXT REFERENCES generations(id), pmid TEXT, title TEXT NOT NULL,
  PRIMARY KEY(generation,pmid)
);
-- statement
CREATE TABLE IF NOT EXISTS issues (
  generation TEXT REFERENCES generations(id), issue_key TEXT, content_version TEXT NOT NULL,
  PRIMARY KEY(generation,issue_key)
);
-- statement
CREATE TABLE IF NOT EXISTS members (
  generation TEXT, issue_key TEXT, pmid TEXT,
  PRIMARY KEY(generation,issue_key,pmid),
  FOREIGN KEY(generation,issue_key) REFERENCES issues(generation,issue_key),
  FOREIGN KEY(generation,pmid) REFERENCES papers(generation,pmid)
);
-- statement
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, created_at TEXT NOT NULL
);
-- statement
CREATE TABLE IF NOT EXISTS operation_ids (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id)
);
-- statement
CREATE TABLE IF NOT EXISTS review_events (
  operation_id TEXT REFERENCES operations(id), pmid TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL, note TEXT NOT NULL, status_updated_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(pmid,version)
);
-- statement
CREATE TABLE IF NOT EXISTS review_current (
  pmid TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
  status_updated_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- statement
CREATE TABLE IF NOT EXISTS issue_events (
  operation_id TEXT REFERENCES operations(id), issue_key TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL, content_version TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(issue_key,version)
);
-- statement
CREATE TABLE IF NOT EXISTS issue_current (
  issue_key TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL,
  content_version TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- statement
CREATE INDEX IF NOT EXISTS review_events_operation ON review_events(operation_id);
-- statement
CREATE INDEX IF NOT EXISTS issue_events_operation ON issue_events(operation_id);
-- statement
CREATE TABLE IF NOT EXISTS publish_guard (ok INTEGER CHECK(ok=1));
-- statement
CREATE TABLE IF NOT EXISTS issue_lists (
  generation TEXT, issue_key TEXT, info_json TEXT NOT NULL, items_json TEXT NOT NULL,
  PRIMARY KEY(generation,issue_key),
  FOREIGN KEY(generation,issue_key) REFERENCES issues(generation,issue_key)
);
-- statement
CREATE VIEW IF NOT EXISTS issue_states AS
SELECT s.generation AS revision,l.issue_key,
  json_patch(l.info_json,json_object(
    'unreviewed',(SELECT count(*) FROM members m LEFT JOIN review_current p ON p.pmid=m.pmid
      WHERE m.generation=s.generation AND m.issue_key=l.issue_key AND COALESCE(p.status,'unreviewed')='unreviewed'),
    'status',CASE WHEN r.status='completed' AND rtrim(r.content_version,'=')<>rtrim(i.content_version,'=')
      THEN 'in_progress' ELSE COALESCE(r.status,'unreviewed') END,
    'content_changed',json(CASE WHEN r.status='completed' AND rtrim(r.content_version,'=')<>rtrim(i.content_version,'=') THEN 'true' ELSE 'false' END),
    'version',COALESCE(r.version,0),'updated_at',COALESCE(r.updated_at,''))) AS item_json
FROM settings s JOIN issue_lists l ON l.generation=s.generation
JOIN issues i ON i.generation=l.generation AND i.issue_key=l.issue_key
LEFT JOIN issue_current r ON r.issue_key=l.issue_key WHERE s.id=1;
-- statement
CREATE TRIGGER IF NOT EXISTS operation_hash_guard BEFORE INSERT ON operations
WHEN EXISTS(SELECT 1 FROM operations WHERE id=NEW.id AND request_hash<>NEW.request_hash)
BEGIN
  SELECT RAISE(ABORT,'operation_id_reused');
END;
-- statement
CREATE TRIGGER IF NOT EXISTS apply_operation AFTER INSERT ON operations
BEGIN
  INSERT INTO operation_ids VALUES(NEW.id,NEW.id);
  INSERT INTO operation_ids SELECT json_extract(NEW.request_json,'$.review_operation_id'),NEW.id
    WHERE json_extract(NEW.request_json,'$.review_operation_id') IS NOT NULL;

  SELECT CASE WHEN json_extract(NEW.request_json,'$.revision') IS NOT
    (SELECT generation FROM settings WHERE id=1) THEN RAISE(ABORT,'metadata_conflict') END;
  SELECT CASE WHEN json_extract(NEW.request_json,'$.issue_key') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM issues WHERE generation=(SELECT generation FROM settings WHERE id=1)
      AND issue_key=json_extract(NEW.request_json,'$.issue_key')) THEN RAISE(ABORT,'issue_missing') END;
  SELECT CASE WHEN json_extract(NEW.request_json,'$.kind') IN ('complete','issue') AND NOT EXISTS(
    SELECT 1 FROM issues i LEFT JOIN issue_current r ON r.issue_key=i.issue_key
    WHERE i.generation=(SELECT generation FROM settings WHERE id=1)
      AND i.issue_key=json_extract(NEW.request_json,'$.issue_key')
      AND i.content_version=json_extract(NEW.request_json,'$.content_version')
      AND COALESCE(r.version,0)=json_extract(NEW.request_json,'$.expected_version')
    ) THEN RAISE(ABORT,'issue_conflict') END;

  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(NEW.request_json,'$.changes') c
    LEFT JOIN review_current r ON r.pmid=json_extract(c.value,'$.pmid')
    WHERE COALESCE(r.version,0)<>json_extract(c.value,'$.expected_version')
      OR NOT EXISTS(SELECT 1 FROM papers p WHERE p.generation=(SELECT generation FROM settings WHERE id=1)
        AND p.pmid=json_extract(c.value,'$.pmid'))
      OR (json_extract(NEW.request_json,'$.issue_key') IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM members m WHERE m.generation=(SELECT generation FROM settings WHERE id=1)
          AND m.issue_key=json_extract(NEW.request_json,'$.issue_key') AND m.pmid=json_extract(c.value,'$.pmid')))
    ) THEN RAISE(ABORT,'review_conflict') END;

  INSERT INTO review_events
    SELECT NEW.id,json_extract(c.value,'$.pmid'),json_extract(c.value,'$.expected_version')+1,
      json_extract(c.value,'$.status'),json_extract(c.value,'$.note'),
      CASE WHEN r.status=json_extract(c.value,'$.status') THEN r.status_updated_at
        WHEN r.pmid IS NULL AND json_extract(c.value,'$.status')='unreviewed' THEN '' ELSE NEW.created_at END,
      NEW.created_at
    FROM json_each(NEW.request_json,'$.changes') c
    LEFT JOIN review_current r ON r.pmid=json_extract(c.value,'$.pmid');
  INSERT INTO review_current
    SELECT pmid,version,status,note,status_updated_at,updated_at FROM review_events WHERE operation_id=NEW.id
    ON CONFLICT(pmid) DO UPDATE SET version=excluded.version,status=excluded.status,note=excluded.note,
      status_updated_at=excluded.status_updated_at,updated_at=excluded.updated_at;

  SELECT CASE WHEN json_extract(NEW.request_json,'$.status')='completed' AND EXISTS(
    SELECT 1 FROM members m LEFT JOIN review_current r ON r.pmid=m.pmid
    WHERE m.generation=(SELECT generation FROM settings WHERE id=1)
      AND m.issue_key=json_extract(NEW.request_json,'$.issue_key') AND COALESCE(r.status,'unreviewed')='unreviewed'
    ) THEN RAISE(ABORT,'unreviewed_remaining') END;
  INSERT INTO issue_events
    SELECT NEW.id,json_extract(NEW.request_json,'$.issue_key'),json_extract(NEW.request_json,'$.expected_version')+1,
      json_extract(NEW.request_json,'$.status'),json_extract(NEW.request_json,'$.content_version'),NEW.created_at
    WHERE json_extract(NEW.request_json,'$.kind') IN ('complete','issue');
  INSERT INTO issue_current
    SELECT issue_key,version,status,content_version,updated_at FROM issue_events WHERE operation_id=NEW.id
    ON CONFLICT(issue_key) DO UPDATE SET version=excluded.version,status=excluded.status,
      content_version=excluded.content_version,updated_at=excluded.updated_at;
END;
