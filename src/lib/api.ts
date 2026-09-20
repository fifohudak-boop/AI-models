import type { CalendarEvent, Category, Note, User } from '../types';

export interface EventInput {
  title: string;
  date: string;
  time: string;
  location?: string;
  categoryId: string;
}

export interface NoteInput {
  title: string;
  body: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error("Couldn't reach the calendar server. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- Auth ----

export function signup(username: string, password: string): Promise<User> {
  return request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function login(username: string, password: string): Promise<User> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function logout(): Promise<void> {
  return request('/api/auth/logout', { method: 'POST' });
}

export function fetchMe(): Promise<User> {
  return request('/api/auth/me');
}

// ---- Categories ----

export function fetchCategories(): Promise<Category[]> {
  return request('/api/categories');
}

// ---- Events ----

export function fetchEvents(): Promise<CalendarEvent[]> {
  return request('/api/events');
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

// ---- Notes ----

export function fetchNotes(): Promise<Note[]> {
  return request('/api/notes');
}

export function createNote(input: NoteInput): Promise<Note> {
  return request('/api/notes', { method: 'POST', body: JSON.stringify(input) });
}

export function updateNote(id: string, input: NoteInput): Promise<Note> {
  return request(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function deleteNote(id: string): Promise<void> {
  return request(`/api/notes/${id}`, { method: 'DELETE' });
}
