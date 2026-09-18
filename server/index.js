import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { init, listEvents, createEventRow, updateEventRow, deleteEventRow } from './store.js';
import { CATEGORIES, CATEGORY_IDS } from './categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 3001;

const app = express();

// Gate everything behind a shared password when APP_PASSWORD is set (e.g. in
// production). Unset locally, so day-to-day dev stays frictionless.
app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();

  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const suppliedPassword = decoded.slice(decoded.indexOf(':') + 1);
    if (suppliedPassword === password) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Calendar"');
  res.status(401).send('Authentication required.');
});

app.use(express.json());

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEventInput(body) {
  if (!isNonEmptyString(body?.title)) return 'title is required';
  if (!isNonEmptyString(body?.date) || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return 'date must be an ISO date (YYYY-MM-DD)';
  if (body.time !== undefined && typeof body.time !== 'string') return 'time must be a string';
  if (body.location !== undefined && typeof body.location !== 'string') return 'location must be a string';
  if (!isNonEmptyString(body?.categoryId) || !CATEGORY_IDS.has(body.categoryId)) return 'categoryId is invalid';
  return null;
}

app.get('/api/categories', (_req, res) => {
  res.json(CATEGORIES);
});

app.get('/api/events', async (_req, res, next) => {
  try {
    res.json(await listEvents());
  } catch (err) {
    next(err);
  }
});

app.post('/api/events', async (req, res, next) => {
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
    await createEventRow(event);
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

app.put('/api/events/:id', async (req, res, next) => {
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
    const existed = await updateEventRow(req.params.id, updated);
    if (!existed) return res.status(404).json({ error: 'event not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const existed = await deleteEventRow(req.params.id);
    if (!existed) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
