import { client } from './db.js';

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

export async function listEvents(userId) {
  const { rows } = await client.execute({
    sql: 'SELECT * FROM events WHERE userId = ? ORDER BY date, time',
    args: [userId],
  });
  return rows.map(rowToEvent);
}

export async function createEventRow(userId, event) {
  await client.execute({
    sql: 'INSERT INTO events (id, userId, title, date, time, location, categoryId) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [event.id, userId, event.title, event.date, event.time ?? '', event.location ?? null, event.categoryId],
  });
  return event;
}

export async function updateEventRow(userId, id, patch) {
  const result = await client.execute({
    sql: 'UPDATE events SET title = ?, date = ?, time = ?, location = ?, categoryId = ? WHERE id = ? AND userId = ?',
    args: [patch.title, patch.date, patch.time ?? '', patch.location ?? null, patch.categoryId, id, userId],
  });
  return Number(result.rowsAffected) > 0;
}

export async function deleteEventRow(userId, id) {
  const result = await client.execute({ sql: 'DELETE FROM events WHERE id = ? AND userId = ?', args: [id, userId] });
  return Number(result.rowsAffected) > 0;
}
