import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readEvents, writeEvents } from './store.js';
import { CATEGORIES, CATEGORY_IDS } from './categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 3001;

const app = express();
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

app.get('/api/events', (_req, res) => {
  res.json(readEvents());
});

app.post('/api/events', (req, res) => {
  const error = validateEventInput(req.body);
  if (error) return res.status(400).json({ error });

  const events = readEvents();
  const event = {
    id: randomUUID(),
    title: req.body.title.trim(),
    date: req.body.date,
    time: req.body.time?.trim() ?? '',
    location: req.body.location?.trim() || undefined,
    categoryId: req.body.categoryId,
  };
  events.push(event);
  writeEvents(events);
  res.status(201).json(event);
});

app.put('/api/events/:id', (req, res) => {
  const error = validateEventInput(req.body);
  if (error) return res.status(400).json({ error });

  const events = readEvents();
  const index = events.findIndex((e) => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'event not found' });

  const updated = {
    id: req.params.id,
    title: req.body.title.trim(),
    date: req.body.date,
    time: req.body.time?.trim() ?? '',
    location: req.body.location?.trim() || undefined,
    categoryId: req.body.categoryId,
  };
  events[index] = updated;
  writeEvents(events);
  res.json(updated);
});

app.delete('/api/events/:id', (req, res) => {
  const events = readEvents();
  const next = events.filter((e) => e.id !== req.params.id);
  if (next.length === events.length) return res.status(404).json({ error: 'event not found' });
  writeEvents(next);
  res.status(204).end();
});

app.use(express.static(DIST_DIR));

// SPA fallback: any non-API GET that isn't a static file gets index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Calendar server running at http://localhost:${PORT}`);
  console.log('On your phone (same Tailscale network or LAN), open this Mac\'s address at that port.');
});
