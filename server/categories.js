// Source of truth for categories — the frontend fetches this list from the API
// instead of keeping its own copy, so a phone and a Mac always agree on it.
export const CATEGORIES = [
  { id: 'work', label: 'Work', tone: 'category-blue' },
  { id: 'team', label: 'Team', tone: 'category-indigo' },
  { id: 'health', label: 'Health', tone: 'category-plum' },
  { id: 'travel', label: 'Travel', tone: 'category-amber' },
  { id: 'social', label: 'Social', tone: 'category-rose' },
  { id: 'personal', label: 'Personal', tone: 'accent' },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
