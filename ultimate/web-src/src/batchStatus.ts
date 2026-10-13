import type { Batch } from './types';

export function summarize(batch: Batch) {
  const c = batch.counts;
  const parts: string[] = [];
  if (c.published) parts.push(`${c.published} published`);
  if (c.posting) parts.push(`${c.posting} posting`);
  if (c.scheduled) parts.push(`${c.scheduled} scheduled`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.deleted) parts.push(`${c.deleted} removed`);
  return parts.join(' · ');
}

// Still worth polling: something is posting, or a scheduled post is about to go.
export function isActive(batch: Batch) {
  return batch.items.some(
    (i) => i.state === 'posting' || (i.state === 'scheduled' && batch.scheduleAt && Date.parse(batch.scheduleAt) - Date.now() < 120_000)
  );
}
