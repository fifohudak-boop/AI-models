import type { Tab } from './App';

export interface SystemDef {
  id: string;
  label: string;
  tabs: { id: Tab; label: string }[];
}

// Each system is one button in the top bar; clicking it rolls down its pages. So the bar stays
// short (Post · Reel Finder · AI Studio · Editing · Metadata · Settings) instead of one long row.
export const SYSTEMS: SystemDef[] = [
  {
    id: 'post',
    label: 'Post',
    tabs: [
      { id: 'post', label: 'New post' },
      { id: 'accounts', label: 'Accounts' },
      { id: 'history', label: 'History' },
      { id: 'analytics', label: 'Analytics' },
    ],
  },
  {
    id: 'reels',
    label: 'Reel Finder',
    tabs: [
      { id: 'reels', label: 'Find videos' },
      { id: 'reels-library', label: 'Library' },
    ],
  },
  {
    id: 'studio',
    label: 'AI Studio',
    tabs: [
      { id: 'studio', label: 'Make a video' },
      { id: 'studio-library', label: 'Library' },
      { id: 'studio-spending', label: 'Spending' },
    ],
  },
  { id: 'edit', label: 'Editing', tabs: [{ id: 'edit', label: 'Editor' }] },
  { id: 'meta', label: 'Metadata', tabs: [{ id: 'meta', label: 'Clean up' }] },
  { id: 'settings', label: 'Settings', tabs: [{ id: 'settings', label: 'Settings' }] },
];

export const ALL_TABS: Tab[] = SYSTEMS.flatMap((s) => s.tabs.map((t) => t.id));
