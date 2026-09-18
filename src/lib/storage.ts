import type { CalendarEvent } from '../types';
import { toISODate } from './date-utils';

const STORAGE_KEY = 'calendar-app.events';

export function loadEvents(): CalendarEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedEvents();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedEvents();
    return parsed;
  } catch {
    return seedEvents();
  }
}

export function saveEvents(events: CalendarEvent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Storage may be unavailable (private browsing, quota); the in-memory state still works this session.
  }
}

/** A few relative-to-today demo events, so a first run isn't an empty grid. */
function seedEvents(): CalendarEvent[] {
  const today = new Date();
  const iso = (dayOffset: number) => {
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
