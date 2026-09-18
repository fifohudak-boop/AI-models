import type { Category } from '../types';

export const CATEGORIES: Category[] = [
  { id: 'work', label: 'Work', tone: 'category-blue' },
  { id: 'team', label: 'Team', tone: 'category-indigo' },
  { id: 'health', label: 'Health', tone: 'category-plum' },
  { id: 'travel', label: 'Travel', tone: 'category-amber' },
  { id: 'social', label: 'Social', tone: 'category-rose' },
  { id: 'personal', label: 'Personal', tone: 'accent' },
];

export function getCategory(id: string): Category {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];
}
