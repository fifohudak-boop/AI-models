// A full analytics run against a fake Postiz: one post whose numbers can't be
// fetched mustn't hold up the others or the account numbers.
import './helpers/tempdata.js';
import { FAKE_POSTIZ_PORT } from './helpers/fake-postiz-env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { db } from '../server/db.js';
import { runAnalytics, syncTrackedPosts } from '../server/analytics.js';

const NOW = Date.now();
const DAY = 864e5;
const at = (ms) => new Date(ms).toISOString();

const batches = [
  {
    id: 'b1',
    createdAt: at(NOW - 2 * 3600e3),
    caption: 'two accounts',
    items: [
      { postId: 'hangs', accountId: 'a1', identifier: 'instagram-standalone' },
      { postId: 'fine', accountId: 'a2', identifier: 'tiktok' },
    ],
  },
  // Scheduled long ago for a date 15 days later: still followed.
  { id: 'b2', createdAt: at(NOW - 100 * DAY), scheduleAt: at(NOW - 85 * DAY), caption: 'scheduled', items: [{ postId: 'sched', accountId: 'a2', identifier: 'tiktok' }] },
];
fs.writeFileSync(path.join(process.env.DATA_DIR, 'batches.json'), JSON.stringify(batches));

const calls = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(url.pathname);
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const p = url.pathname.replace('/api/public/v1', '');
  if (p === '/posts') {
    return send({
      posts: ['hangs', 'fine', 'sched'].map((id) => ({
        id,
        state: 'PUBLISHED',
        publishDate: id === 'sched' ? at(NOW - 85 * DAY) : at(NOW - 3600e3),
        releaseURL: `https://example.com/${id}`,
        releaseId: `r-${id}`,
      })),
    });
  }
  if (p === '/analytics/post/hangs') return res.destroy(); // network error → "can't reach Postiz"
  if (p.startsWith('/analytics/post/')) return send([{ label: 'Views', data: [{ total: '42', date: '2026-10-08' }] }]);
  if (p === '/integrations') return send([{ id: 'a2', identifier: 'tiktok', name: 'TikTok', disabled: false }]);
  if (p === '/analytics/a2') return send([{ label: 'Followers', data: [{ total: '900', date: '2026-10-08' }] }]);
  res.writeHead(404);
  res.end('{}');
});

before(() => new Promise((r) => fake.listen(FAKE_POSTIZ_PORT, '127.0.0.1', r)));
after(() => fake.close());

test("a post whose numbers can't be fetched doesn't hold up the rest", async () => {
  await runAnalytics({ now: NOW });
  const rows = Object.fromEntries(db.prepare('SELECT * FROM post_metrics').all().map((r) => [r.post_id, r]));
  assert.equal(rows.fine.views, 42);
  assert.equal(rows.fine.status, 'ok');
  assert.equal(rows.sched.views, 42); // scheduled 85 days ago: still followed
  assert.equal(rows.hangs.views, null);
  assert.ok(rows.hangs.next_fetch_at > NOW, 'the failing post waits before its next try');
  const followers = db.prepare("SELECT value FROM account_stats WHERE account_id = 'a2' AND metric = 'followers'").get();
  assert.equal(followers.value, 900); // account numbers still fetched

  // The next run doesn't start with the failing post again.
  calls.length = 0;
  await runAnalytics({ now: NOW + 60_000 });
  assert.ok(!calls.includes('/api/public/v1/analytics/post/hangs'));
});

test('posts still in History keep their numbers; removed ones go', () => {
  syncTrackedPosts(NOW + 400 * DAY, batches); // far in the future: everything is old
  assert.equal(db.prepare("SELECT views FROM post_metrics WHERE post_id = 'fine'").get().views, 42);
  syncTrackedPosts(NOW, [batches[1]]); // b1 removed from History
  const left = db.prepare('SELECT post_id FROM post_metrics ORDER BY post_id').all().map((r) => r.post_id);
  assert.deepEqual(left, ['sched']);
});
