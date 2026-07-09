// SQLite persistence for projects. One row per Slack thread (thread_ts = id).
// Swap this module for a Postgres-backed one without touching the rest of the app.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const dir = path.dirname(config.app.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.app.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    thread_ts        TEXT PRIMARY KEY,
    channel_id       TEXT NOT NULL,
    status           TEXT NOT NULL,
    current_video    INTEGER NOT NULL DEFAULT 1,
    render_mode      TEXT NOT NULL DEFAULT 'one_by_one',
    brief            TEXT NOT NULL DEFAULT '{}',
    storyboard       TEXT NOT NULL DEFAULT '{}',
    videos           TEXT NOT NULL DEFAULT '[]',
    notion_page_id   TEXT,
    drive_folder_id  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
`);

const JSON_FIELDS = ["brief", "storyboard", "videos"];

function hydrate(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of JSON_FIELDS) out[f] = JSON.parse(row[f] || (f === "videos" ? "[]" : "{}"));
  return out;
}

export const store = {
  create({ thread_ts, channel_id }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (thread_ts, channel_id, status, created_at, updated_at)
       VALUES (?, ?, 'INTAKE', ?, ?)`
    ).run(thread_ts, channel_id, now, now);
    return this.get(thread_ts);
  },

  get(thread_ts) {
    return hydrate(db.prepare(`SELECT * FROM projects WHERE thread_ts = ?`).get(thread_ts));
  },

  list() {
    return db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all().map(hydrate);
  },

  findByHiggsfieldRequest(requestId) {
    // linear scan is fine at this volume; index videos JSON if it grows.
    return this.list().find((p) => (p.videos || []).some((v) => v.request_id === requestId)) || null;
  },

  update(thread_ts, patch) {
    const current = this.get(thread_ts);
    if (!current) throw new Error(`No project ${thread_ts}`);
    const merged = { ...current, ...patch, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE projects SET
        channel_id=@channel_id, status=@status, current_video=@current_video,
        render_mode=@render_mode, brief=@brief, storyboard=@storyboard, videos=@videos,
        notion_page_id=@notion_page_id, drive_folder_id=@drive_folder_id, updated_at=@updated_at
       WHERE thread_ts=@thread_ts`
    ).run({
      thread_ts,
      channel_id: merged.channel_id,
      status: merged.status,
      current_video: merged.current_video,
      render_mode: merged.render_mode,
      brief: JSON.stringify(merged.brief || {}),
      storyboard: JSON.stringify(merged.storyboard || {}),
      videos: JSON.stringify(merged.videos || []),
      notion_page_id: merged.notion_page_id || null,
      drive_folder_id: merged.drive_folder_id || null,
      updated_at: merged.updated_at,
    });
    return this.get(thread_ts);
  },
};

// `node src/store.js --init` just ensures the schema exists.
if (process.argv.includes("--init")) {
  console.log(`DB ready at ${config.app.dbPath}`);
}
