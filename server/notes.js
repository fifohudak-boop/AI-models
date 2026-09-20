import { randomUUID } from 'node:crypto';
import { client } from './db.js';

function rowToNote(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt,
  };
}

export async function listNotes(userId) {
  const { rows } = await client.execute({
    sql: 'SELECT * FROM notes WHERE userId = ? ORDER BY updatedAt DESC',
    args: [userId],
  });
  return rows.map(rowToNote);
}

export async function createNote(userId, { title, body }) {
  const note = { id: randomUUID(), title, body, updatedAt: new Date().toISOString() };
  await client.execute({
    sql: 'INSERT INTO notes (id, userId, title, body, updatedAt) VALUES (?, ?, ?, ?, ?)',
    args: [note.id, userId, note.title, note.body, note.updatedAt],
  });
  return note;
}

export async function updateNote(userId, id, { title, body }) {
  const updatedAt = new Date().toISOString();
  const result = await client.execute({
    sql: 'UPDATE notes SET title = ?, body = ?, updatedAt = ? WHERE id = ? AND userId = ?',
    args: [title, body, updatedAt, id, userId],
  });
  if (Number(result.rowsAffected) === 0) return null;
  return { id, title, body, updatedAt };
}

export async function deleteNote(userId, id) {
  const result = await client.execute({ sql: 'DELETE FROM notes WHERE id = ? AND userId = ?', args: [id, userId] });
  return Number(result.rowsAffected) > 0;
}
