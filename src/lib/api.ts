import type { CalendarEvent, Category } from '../types';

export interface EventInput {
  title: string;
  date: string;
  time: string;
  location?: string;
  categoryId: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error("Couldn't reach the calendar server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export function fetchEvents(): Promise<CalendarEvent[]> {
  return request('/api/events');
}

export function fetchCategories(): Promise<Category[]> {
  return request('/api/categories');
}

export function createEvent(input: EventInput): Promise<CalendarEvent> {
  return request('/api/events', { method: 'POST', body: JSON.stringify(input) });
}

export function updateEvent(id: string, input: EventInput): Promise<CalendarEvent> {
  return request(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function deleteEvent(id: string): Promise<void> {
  return request(`/api/events/${id}`, { method: 'DELETE' });
}
