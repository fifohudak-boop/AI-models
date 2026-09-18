import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'events.json');

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

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(seedEvents(), null, 2));
  }
}

export function readEvents() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeEvents(events) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2));
}
