// A "batch" is one click of the Post button: the same content sent to many
// accounts. Postiz tracks each account's post separately, so the dashboard
// remembers which Postiz posts belong together and merges their live status.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './config.js';

const FILE = path.join(DATA_DIR, 'batches.json');
const MAX_BATCHES = 2000;
const DAY = 24 * 60 * 60 * 1000;

let cache = null;

function load() {
  if (!cache) cache = readJson(FILE, []);
  return cache;
}

function persist() {
  writeJsonAtomic(FILE, cache.slice(0, MAX_BATCHES));
}

export function createBatch(fields) {
  const batch = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
  load().unshift(batch);
  persist();
  return batch;
}

export function getBatch(id) {
  return load().find((b) => b.id === id) ?? null;
}

// `userId` limits the list to what that person posted. Posts from before team
// accounts have no userId; they count as the owner's (`ownerId`).
export function listBatches(limit = 50, { userId = null, ownerId = null } = {}) {
  const all = load();
  if (!userId) return all.slice(0, limit);
  return all.filter((b) => (b.userId ?? ownerId) === userId).slice(0, limit);
}

export function allBatches() {
  return load();
}

export function batchOwner(batch, ownerId) {
  return batch.userId ?? ownerId;
}

export function updateBatch(id, mutate) {
  const batch = getBatch(id);
  if (!batch) return null;
  mutate(batch);
  persist();
  return batch;
}

export function removeBatch(id) {
  cache = load().filter((b) => b.id !== id);
  persist();
}

// Time window that covers every post in these batches (Postiz lists posts by
// publish date).
export function postsWindow(batches) {
  let start = Infinity;
  let end = -Infinity;
  for (const b of batches) {
    const created = Date.parse(b.createdAt);
    const when = b.scheduleAt ? Date.parse(b.scheduleAt) : created;
    start = Math.min(start, created, when);
    end = Math.max(end, created, when);
  }
  if (!Number.isFinite(start)) return null;
  return { start: new Date(start - DAY), end: new Date(end + DAY) };
}

const FAILURE_WORDS = /error|couldn't|could not|failed|unable/i;

// Postiz's error details only reach the public API as notifications, which
// name the network (and sometimes the account). Pick the first failure about
// this account's network written after its post was sent; one naming the
// account itself wins when several accounts on the same network failed.
function errorFromNotifications(item, batch, notifications) {
  const since = Date.parse(item.sentAt ?? batch.createdAt) - 5_000;
  const candidates = notifications
    .map((n) => ({ at: Date.parse(n.createdAt ?? n.updatedAt ?? 0), text: String(n.content ?? n.title ?? '') }))
    .filter(
      (n) =>
        n.at >= since &&
        FAILURE_WORDS.test(n.text) &&
        n.text.toLowerCase().includes(item.identifier.split('-')[0].toLowerCase())
    )
    .sort((a, b) => a.at - b.at);
  const match = candidates.find((n) => n.text.includes(item.accountName)) ?? candidates[0];
  if (!match) return null;
  return match.text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^An error occurred while posting on [\w-]+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function itemStatus(item, post, batch, notifications, now = Date.now()) {
  if (item.rejected) return { state: 'failed', error: item.rejected };
  if (!item.postId) return { state: 'failed', error: 'Not sent.' };
  if (post === null) {
    // Just created; Postiz hasn't been asked yet.
    return { state: batch.scheduleAt && Date.parse(batch.scheduleAt) > now + 60_000 ? 'scheduled' : 'posting' };
  }
  if (!post) return { state: 'deleted' };
  switch (post.state) {
    case 'PUBLISHED':
      return { state: 'published', url: post.releaseURL || null };
    case 'ERROR':
      return { state: 'failed', error: errorFromNotifications(item, batch, notifications) || 'The network rejected the post.' };
    case 'DRAFT':
      return { state: 'draft' };
    default:
      return { state: Date.parse(post.publishDate) > now + 60_000 ? 'scheduled' : 'posting' };
  }
}

// postsById === null means "no live data yet" (right after posting).
export function withStatus(batch, postsById, notifications) {
  const items = batch.items.map((item) => ({
    ...item,
    ...itemStatus(item, postsById === null ? null : postsById.get(item.postId), batch, notifications),
  }));
  const counts = items.reduce((acc, i) => ({ ...acc, [i.state]: (acc[i.state] ?? 0) + 1 }), {});
  return { ...batch, items, counts };
}
