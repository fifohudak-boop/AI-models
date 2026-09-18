export type Tone =
  | 'accent'
  | 'category-blue'
  | 'category-indigo'
  | 'category-plum'
  | 'category-amber'
  | 'category-rose'
  | 'danger';

export type CategoryTone = Exclude<Tone, 'danger'>;

export interface Category {
  id: string;
  label: string;
  tone: CategoryTone;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO date, e.g. "2026-09-18" */
  date: string;
  /** e.g. "09:00–10:00" */
  time: string;
  location?: string;
  categoryId: string;
}
