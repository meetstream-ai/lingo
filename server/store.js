import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cues (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), kind TEXT NOT NULL, start REAL NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cues_meeting ON cues(meeting_id,kind,start);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,run_at);
    CREATE TABLE IF NOT EXISTS receipts (cue_id TEXT, target TEXT, client_id TEXT, data TEXT NOT NULL, PRIMARY KEY(cue_id,target,client_id));
    CREATE TABLE IF NOT EXISTS reviews (cue_id TEXT, target TEXT, data TEXT NOT NULL, PRIMARY KEY(cue_id,target));`);
  // ponytail: one worker process; a restart safely replays idempotent jobs. Use a leased queue before adding replicas.
  db.exec("UPDATE jobs SET status='queued' WHERE status='running'");
  const parse = (row) => (row ? JSON.parse(row.data) : null);
  return {
    db,
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    meeting: (id) =>
      parse(db.prepare("SELECT data FROM meetings WHERE id=?").get(id)),
    meetings: () =>
      db
        .prepare("SELECT data FROM meetings ORDER BY rowid DESC")
        .all()
        .map(parse),
    meetingPage(page = 1, query = "", pageSize = 10, status = "all") {
      const needle = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      const statuses = {
        all: "1=1",
        active:
          "json_extract(data,'$.endedAt') IS NULL AND json_extract(data,'$.status') IN ('live','connecting','joining','waiting','stopping')",
        finished: "json_extract(data,'$.endedAt') IS NOT NULL",
        attention:
          "json_extract(data,'$.status')='failed' OR json_extract(data,'$.postCallStatus')='failed' OR json_extract(data,'$.lastError') IS NOT NULL",
      };
      if (!Object.hasOwn(statuses, status))
        throw new Error("Invalid meeting status filter.");
      const filter =
        "lower(json_extract(data,'$.title')) LIKE lower(?) ESCAPE '\\'" +
        ` AND (${statuses[status]})`;
      const total = db
        .prepare(`SELECT count(*) AS total FROM meetings WHERE ${filter}`)
        .get(needle).total;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      page = Math.min(pages, Math.max(1, page));
      const items = db
        .prepare(
          `SELECT data FROM meetings WHERE ${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(needle, pageSize, (page - 1) * pageSize)
        .map(parse);
      return { items, page, pages, total, pageSize, query, status };
    },
    saveMeeting: (m) =>
      db
        .prepare(
          "INSERT INTO meetings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(m.id, JSON.stringify(m)),
    cue: (id) => parse(db.prepare("SELECT data FROM cues WHERE id=?").get(id)),
    cues: (id) =>
      db
        .prepare(
          "SELECT data FROM cues WHERE meeting_id=? ORDER BY start,rowid",
        )
        .all(id)
        .map(parse),
    insertCue: (c) =>
      db
        .prepare("INSERT OR IGNORE INTO cues VALUES (?,?,?,?,?)")
        .run(c.id, c.meetingId, c.kind, c.start, JSON.stringify(c)).changes > 0,
    saveCue: (c) =>
      db
        .prepare("UPDATE cues SET data=? WHERE id=?")
        .run(JSON.stringify(c), c.id),
    enqueue(id, kind, payload, runAt = Date.now()) {
      return (
        db
          .prepare(
            "INSERT OR IGNORE INTO jobs(id,kind,payload,run_at) VALUES (?,?,?,?)",
          )
          .run(id, kind, JSON.stringify(payload), runAt).changes > 0
      );
    },
    claim() {
      const row = db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY run_at,rowid LIMIT 1",
        )
        .get(Date.now());
      if (!row) return null;
      db.prepare(
        "UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?",
      ).run(row.id);
      return {
        ...row,
        attempts: row.attempts + 1,
        payload: JSON.parse(row.payload),
      };
    },
    done: (id) =>
      db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=?").run(id),
    retry: (id, delay, error) =>
      db
        .prepare("UPDATE jobs SET status='queued',run_at=?,error=? WHERE id=?")
        .run(Date.now() + delay, error, id),
    fail: (id, error) =>
      db
        .prepare("UPDATE jobs SET status='failed',error=? WHERE id=?")
        .run(error, id),
    requeueFailed: (id) =>
      db
        .prepare(
          "UPDATE jobs SET status='queued',attempts=0,run_at=?,error=NULL WHERE id=? AND status='failed'",
        )
        .run(Date.now(), id),
    retryFailed: (id) =>
      db
        .prepare(
          "UPDATE jobs SET status='queued',attempts=0,run_at=?,error=NULL WHERE status='failed' AND json_extract(payload,'$.meetingId')=?",
        )
        .run(Date.now(), id),
    failed: (id) =>
      db
        .prepare(
          "SELECT kind,error FROM jobs WHERE status='failed' AND json_extract(payload,'$.meetingId')=?",
        )
        .all(id),
    receipt: (r) =>
      db
        .prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,?,?)")
        .run(r.cueId, r.target, r.clientId, JSON.stringify(r)),
    receipts: (id) =>
      db
        .prepare(
          "SELECT r.data FROM receipts r JOIN cues c ON r.cue_id=c.id WHERE c.meeting_id=?",
        )
        .all(id)
        .map(parse),
    review: (r) =>
      db
        .prepare(
          "INSERT INTO reviews VALUES (?,?,?) ON CONFLICT(cue_id,target) DO UPDATE SET data=excluded.data",
        )
        .run(r.cueId, r.target, JSON.stringify(r)),
    reviews: (id) =>
      db
        .prepare(
          "SELECT r.data FROM reviews r JOIN cues c ON r.cue_id=c.id WHERE c.meeting_id=?",
        )
        .all(id)
        .map(parse),
    close: () => db.close(),
  };
}
