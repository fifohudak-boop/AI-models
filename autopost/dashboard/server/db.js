// Fifofarm's own database: the people who use it (team accounts), who owns
// which connected social account, and the analytics history. SQLite is built
// into Node, so it's one file in the data folder and nothing extra to run.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

// Each entry upgrades the database by one version. Never edit an entry that
// has shipped; add a new one.
const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
     password_hash TEXT NOT NULL,
     session_version INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     last_login_at TEXT
   );
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE account_owners (
     account_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     assigned_at TEXT NOT NULL
   );
   CREATE TABLE pending_connects (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     known_ids TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE post_metrics (
     post_id TEXT PRIMARY KEY,
     batch_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     identifier TEXT NOT NULL,
     published_at TEXT,
     url TEXT,
     views INTEGER,
     likes INTEGER,
     comments INTEGER,
     shares INTEGER,
     saves INTEGER,
     reach INTEGER,
     extra TEXT,
     status TEXT NOT NULL DEFAULT 'waiting',
     error TEXT,
     fetched_at INTEGER,
     next_fetch_at INTEGER
   );
   CREATE INDEX post_metrics_account ON post_metrics (account_id);
   CREATE INDEX post_metrics_due ON post_metrics (next_fetch_at);
   CREATE TABLE post_daily (
     post_id TEXT NOT NULL,
     day TEXT NOT NULL,
     views INTEGER,
     likes INTEGER,
     comments INTEGER,
     shares INTEGER,
     saves INTEGER,
     reach INTEGER,
     PRIMARY KEY (post_id, day)
   );
   CREATE TABLE account_stats (
     account_id TEXT NOT NULL,
     metric TEXT NOT NULL,
     label TEXT NOT NULL,
     kind TEXT NOT NULL,
     day TEXT NOT NULL,
     value REAL NOT NULL,
     PRIMARY KEY (account_id, metric, day)
   );
   CREATE TABLE account_stats_fetch (
     account_id TEXT PRIMARY KEY,
     fetched_at INTEGER NOT NULL,
     error TEXT
   );`,
];

export const DB_FILE = path.join(DATA_DIR, 'fifofarm.db');
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const current = db.prepare('PRAGMA user_version').get().user_version;
for (let version = current; version < MIGRATIONS.length; version += 1) {
  tx(() => {
    db.exec(MIGRATIONS[version]);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  });
}

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value)
  );
}
