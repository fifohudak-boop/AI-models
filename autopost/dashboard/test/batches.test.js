import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autopost-test-'));
const { itemStatus, postsWindow, withStatus } = await import('../server/batches.js');

const batch = { id: 'b', createdAt: '2026-10-01T10:00:00.000Z', scheduleAt: null, items: [] };
const item = { accountId: 'a', accountName: 'My Channel', identifier: 'youtube', postId: 'p1', rejected: null };

test('maps Postiz post states to what the user sees', () => {
  assert.deepEqual(itemStatus(item, { state: 'PUBLISHED', releaseURL: 'https://x/1' }, batch, []), {
    state: 'published',
    url: 'https://x/1',
  });
  assert.equal(itemStatus(item, { state: 'QUEUE', publishDate: '2026-10-01T10:00:00Z' }, batch, [], Date.parse('2026-10-01T10:00:05Z')).state, 'posting');
  assert.equal(itemStatus(item, { state: 'QUEUE', publishDate: '2026-10-02T10:00:00Z' }, batch, [], Date.parse('2026-10-01T10:00:05Z')).state, 'scheduled');
  assert.equal(itemStatus(item, undefined, batch, []).state, 'deleted');
  assert.equal(itemStatus(item, null, batch, []).state, 'posting');
  assert.deepEqual(itemStatus({ ...item, rejected: 'Too long' }, undefined, batch, []), { state: 'failed', error: 'Too long' });
});

test('failed posts show the matching Postiz notification as the reason', () => {
  const yt = { ...item, identifier: 'youtube', sentAt: '2026-10-01T10:00:10.000Z' };
  const notifications = [
    { createdAt: '2026-10-01T09:00:00.000Z', content: 'An error occurred while posting on youtube: old problem' },
    { createdAt: '2026-10-01T10:00:15.000Z', content: 'Your post has been published on YouTube at https://y/1' },
    { createdAt: '2026-10-01T10:00:30.000Z', content: 'An error occurred while posting on tiktok: not this one' },
    { createdAt: '2026-10-01T10:00:20.000Z', content: 'An error occurred while posting on youtube: <b>quota</b> exceeded' },
  ];
  const status = itemStatus(yt, { state: 'ERROR' }, batch, notifications);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'quota exceeded');
  assert.equal(itemStatus(yt, { state: 'ERROR' }, batch, []).error, 'The network rejected the post.');
});

test('with two failing accounts on one network, the one naming the account wins', () => {
  const yt = { ...item, identifier: 'youtube', sentAt: '2026-10-01T10:00:00.000Z' };
  const notifications = [
    { createdAt: '2026-10-01T10:00:05.000Z', content: "We couldn't post to youtube for Other Channel because it's disabled." },
    { createdAt: '2026-10-01T10:00:06.000Z', content: "We couldn't post to youtube for My Channel because you need to reconnect it." },
  ];
  assert.match(itemStatus(yt, { state: 'ERROR' }, batch, notifications).error, /My Channel because you need to reconnect/);
});

test('withStatus counts states', () => {
  const b = { ...batch, items: [item, { ...item, accountId: 'c', postId: 'p2' }, { ...item, accountId: 'd', postId: null, rejected: 'x' }] };
  const posts = new Map([
    ['p1', { state: 'PUBLISHED', releaseURL: 'u' }],
    ['p2', { state: 'ERROR' }],
  ]);
  assert.deepEqual(withStatus(b, posts, []).counts, { published: 1, failed: 2 });
});

test('postsWindow spans creation and schedule time with a day of margin', () => {
  const w = postsWindow([
    { createdAt: '2026-10-01T10:00:00.000Z', scheduleAt: '2026-10-05T10:00:00.000Z' },
    { createdAt: '2026-09-30T10:00:00.000Z' },
  ]);
  assert.equal(w.start.toISOString(), '2026-09-29T10:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-10-06T10:00:00.000Z');
  assert.equal(postsWindow([]), null);
});
