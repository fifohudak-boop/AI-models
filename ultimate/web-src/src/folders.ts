import type { FolderKind } from './types';

// The four folders every model has.
export const FOLDER_LABELS: Record<FolderKind, string> = {
  found: 'Found videos',
  generated: 'AI Studio',
  references: 'References',
  photos: 'Model photos',
};

export const FOLDER_HINTS: Record<FolderKind, string> = {
  found: 'What Reel Finder saved for this model.',
  generated: 'What AI Studio made for this model.',
  references: 'Your own reference videos and pictures for this model.',
  photos: 'Photos of the model — AI Studio uses them to keep the face and look the same.',
};
