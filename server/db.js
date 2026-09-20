import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// With TURSO_DATABASE_URL set, this talks to a real Turso database (production).
// Without it, it falls back to a local SQLite file — same client, same SQL, so
// local dev/testing exercises the exact same code path as production.
const url = process.env.TURSO_DATABASE_URL ?? `file:${path.join(__dirname, 'data', 'local.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

export const client = createClient({ url, authToken });

async function hasColumn(table, column) {
  const { rows } = await client.execute(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

/** Creates tables as needed and migrates an older single-user `events` table. Call before serving traffic. */
export async function init() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      salt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      location TEXT,
      categoryId TEXT NOT NULL
    )
  `);

  // Migration: an events table from before accounts existed has no userId column.
  // Those rows can't be attributed to any account, so they're dropped once the
  // column is added — this only affects data from before this feature shipped.
  if (!(await hasColumn('events', 'userId'))) {
    await client.execute('ALTER TABLE events ADD COLUMN userId TEXT');
    await client.execute('DELETE FROM events WHERE userId IS NULL');
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL
    )
  `);
}
