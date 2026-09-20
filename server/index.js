import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { init } from './db.js';
import {
  clearSessionCookie,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  getUserBySessionToken,
  normalizeUsername,
  parseCookies,
  sessionCookie,
  verifyLogin,
} from './auth.js';
import { createEventRow, deleteEventRow, listEvents, updateEventRow } from './events.js';
import { createNote, deleteNote, listNotes, updateNote } from './notes.js';
import { CATEGORIES, CATEGORY_IDS } from './categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(express.json());

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Attaches req.userId when a valid session cookie is present; never rejects on its own.
app.use(async (req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = await getUserBySessionToken(cookies.session);
  if (user) {
    req.userId = user.id;
    req.username = user.username;
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

// ---- Auth ----

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const rawUsername = req.body?.username;
    const password = req.body?.password;
    if (!isNonEmptyString(rawUsername) || rawUsername.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }
    if (!isNonEmptyString(password) || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const username = normalizeUsername(rawUsername);
    if (!/^[a-z0-9._-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, dashes and underscores.' });
    }
    if (await findUserByUsername(username)) {
      return res.status(409).json({ error: 'That username is taken.' });
    }

    const user = await createUser(username, password);
    const token = await createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const rawUsername = req.body?.username;
    const password = req.body?.password;
    if (!isNonEmptyString(rawUsername) || !isNonEmptyString(password)) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await verifyLogin(normalizeUsername(rawUsername), password);
    if (!user) return res.status(401).json({ error: 'Wrong username or password.' });

    const token = await createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.json(user);
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) await deleteSession(cookies.session);
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ id: req.userId, username: req.username });
});

// ---- Categories (static, public) ----

app.get('/api/categories', (_req, res) => {
  res.json(CATEGORIES);
});

// ---- Events (per account) ----

function validateEventInput(body) {
  if (!isNonEmptyString(body?.title)) return 'title is required';
  if (!isNonEmptyString(body?.date) || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return 'date must be an ISO date (YYYY-MM-DD)';
  if (body.time !== undefined && typeof body.time !== 'string') return 'time must be a string';
  if (body.location !== undefined && typeof body.location !== 'string') return 'location must be a string';
  if (!isNonEmptyString(body?.categoryId) || !CATEGORY_IDS.has(body.categoryId)) return 'categoryId is invalid';
  return null;
}

app.get('/api/events', requireAuth, async (req, res, next) => {
  try {
    res.json(await listEvents(req.userId));
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', requireAuth, async (req, res, next) => {
  const error = validateEventInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const event = {
      id: randomUUID(),
      title: req.body.title.trim(),
      date: req.body.date,
      time: req.body.time?.trim() ?? '',
      location: req.body.location?.trim() || undefined,
      categoryId: req.body.categoryId,
    };
    await createEventRow(req.userId, event);
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', requireAuth, async (req, res, next) => {
  const error = validateEventInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const updated = {
      id: req.params.id,
      title: req.body.title.trim(),
      date: req.body.date,
      time: req.body.time?.trim() ?? '',
      location: req.body.location?.trim() || undefined,
      categoryId: req.body.categoryId,
    };
    const existed = await updateEventRow(req.userId, req.params.id, updated);
    if (!existed) return res.status(404).json({ error: 'event not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', requireAuth, async (req, res, next) => {
  try {
    const existed = await deleteEventRow(req.userId, req.params.id);
    if (!existed) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Notes (per account) ----

function validateNoteInput(body) {
  if (body?.title !== undefined && typeof body.title !== 'string') return 'title must be a string';
  if (body?.body !== undefined && typeof body.body !== 'string') return 'body must be a string';
  return null;
}

app.get('/api/notes', requireAuth, async (req, res, next) => {
  try {
    res.json(await listNotes(req.userId));
  } catch (err) {
    next(err);
  }
});

app.post('/api/notes', requireAuth, async (req, res, next) => {
  const error = validateNoteInput(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const note = await createNote(req.userId, { title: req.body.title?.trim() ?? '', body: req.body.body ?? '' });
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

app.put('/api/notes/:id', requireAuth, async (req, res, next) => {
  const error = validateNoteInput(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const note = await updateNote(req.userId, req.params.id, { title: req.body.title?.trim() ?? '', body: req.body.body ?? '' });
    if (!note) return res.status(404).json({ error: 'note not found' });
    res.json(note);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res, next) => {
  try {
    const existed = await deleteNote(req.userId, req.params.id);
    if (!existed) return res.status(404).json({ error: 'note not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- Static frontend ----

app.use(express.static(DIST_DIR));

// SPA fallback: any non-API GET that isn't a static file gets index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

async function main() {
  await init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Calendar server running at http://localhost:${PORT}`);
    console.log(process.env.TURSO_DATABASE_URL ? 'Using Turso database.' : 'Using local SQLite file (server/data/local.db).');
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
