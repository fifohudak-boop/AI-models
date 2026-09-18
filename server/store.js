import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// With TURSO_DATABASE_URL set, this talks to a real Turso database (production).
// Without it, it falls back to a local SQLite file — same client, same SQL, so
// local dev/testing exercises the exact same code path as production.
const url = process.env.TURSO_DATABASE_URL ?? `file:${path.join(__dirname, 'data', 'local.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient({ url, authToken });

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISODate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A few relative-to-today demo events, so a first run isn't an empty calendar. */
function seedEvents() {
  const today = new Date();
  const iso = (dayOffset) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset);
    return toISODate(d);
  };

  return [
    { id: 'seed-1', title: 'Team sync', date: iso(0), time: '09:00–09:30', location: 'Conference room B', categoryId: 'team' },
    { id: 'seed-2', title: 'Design review', date: iso(0), time: '11:00–12:00', categoryId: 'work' },
    { id: 'seed-3', title: 'Dentist appointment', date: iso(2), time: '14:00–15:00', location: 'Maple St. Dental', categoryId: 'health' },
    { id: 'seed-4', title: 'Flight to Denver', date: iso(5), time: '07:30–10:15', location: 'Gate C14', categoryId: 'travel' },
    { id: 'seed-5', title: "Priya's birthday dinner", date: iso(5), time: '19:00–21:00', categoryId: 'social' },
    { id: 'seed-6', title: 'Quarterly planning', date: iso(-3), time: '10:00–11:30', categoryId: 'work' },
    { id: 'seed-7', title: 'Grocery run', date: iso(1), time: '18:00–18:45', categoryId: 'personal' },
  ];
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    location: row.location ?? undefined,
    categoryId: row.categoryId,
  };
}

async function insertRow(event) {
  await client.execute({
    sql: 'INSERT INTO events (id, title, date, time, location, categoryId) VALUES (?, ?, ?, ?, ?, ?)',
    args: [event.id, event.title, event.date, event.time ?? '', event.location ?? null, event.categoryId],
  });
}

/** Creates the table if needed and seeds it once, on an empty table. Call before serving traffic. */
export async function init() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      location TEXT,
      categoryId TEXT NOT NULL
    )
  `);

  const { rows } = await client.execute('SELECT COUNT(*) as count FROM events');
  if (Number(rows[0].count) === 0) {
    for (const event of seedEvents()) {
      await insertRow(event);
    }
  }
}

export async function listEvents() {
  const { rows } = await client.execute('SELECT * FROM events ORDER BY date, time');
  return rows.map(rowToEvent);
}

export async function createEventRow(event) {
  await insertRow(event);
  return event;
}

export async function updateEventRow(id, patch) {
  const result = await client.execute({
    sql: 'UPDATE events SET title = ?, date = ?, time = ?, location = ?, categoryId = ? WHERE id = ?',
    args: [patch.title, patch.date, patch.time ?? '', patch.location ?? null, patch.categoryId, id],
  });
  return Number(result.rowsAffected) > 0;
}

export async function deleteEventRow(id) {
  const result = await client.execute({ sql: 'DELETE FROM events WHERE id = ?', args: [id] });
  return Number(result.rowsAffected) > 0;
}
