import './helpers/tempdata.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import {
  columnsFrom,
  dayOf,
  overview,
  parseMetrics,
  refreshDelay,
  syncTrackedPosts,
  videoDetail,
} from '../server/analytics.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-08T12:00:00Z');

test('videos are checked hourly while new, then less and less often', () => {
  const posted = NOW - HOUR;
  assert.equal(refreshDelay(posted, NOW), HOUR);
  assert.equal(refreshDelay(NOW - 3 * DAY, NOW), 6 * HOUR);
  assert.equal(refreshDelay(NOW - 10 * DAY, NOW), DAY);
  assert.equal(refreshDelay(NOW - 40 * DAY, NOW), 7 * DAY);
  assert.equal(refreshDelay(NOW - 100 * DAY, NOW), null);
});

test("each network's names map to the same columns", () => {
  const instagram = parseMetrics([
    { label: 'Views', data: [{ total: '900', date: '2026-10-08' }] },
    { label: 'Saves', data: [{ total: '4', date: '2026-10-08' }] },
    { label: 'Reach', data: [{ total: '700', date: '2026-10-08' }] },
  ]);
  assert.deepEqual(columnsFrom(instagram), { views: 900, likes: null, comments: null, shares: null, saves: 4, reach: 700 });
  const x = parseMetrics([
    { label: 'Impressions', data: [{ total: '50', date: 'x' }] },
    { label: 'Retweets', data: [{ total: '3', date: 'x' }] },
    { label: 'Bad', data: [{ total: 'not a number' }] },
  ]);
  assert.equal(columnsFrom(x).views, 50);
  assert.equal(columnsFrom(x).shares, 3);
  assert.equal(x.bad, undefined);
  // The newest value wins when a network sends several.
  assert.equal(parseMetrics([{ label: 'Views', data: [{ total: 1 }, { total: 5 }] }]).views.value, 5);
  assert.deepEqual(parseMetrics(null), {});
});

function batch(id, createdAt, items, extra = {}) {
  return { id, createdAt: new Date(createdAt).toISOString(), caption: `caption ${id}`, title: '', media: null, ...extra, items };
}

const item = (postId, accountId, identifier = 'instagram-standalone') => ({ postId, accountId, identifier, accountName: accountId });

test('posted items are followed; removed ones are dropped', () => {
  const batches = [
    batch('b1', NOW - 2 * DAY, [item('p1', 'a1'), item('p2', 'a2'), { ...item(null, 'a3'), rejected: 'nope' }]),
    batch('b0', NOW - 200 * DAY, [item('p0', 'a1')]),
  ];
  syncTrackedPosts(NOW, batches);
  const ids = db.prepare('SELECT post_id FROM post_metrics ORDER BY post_id').all().map((r) => r.post_id);
  assert.deepEqual(ids, ['p1', 'p2']); // too old and never-sent items are skipped
  // p2 was retried (new post id) → p2 goes, p3 comes.
  batches[0].items[1] = item('p3', 'a2');
  syncTrackedPosts(NOW, batches);
  const after = db.prepare('SELECT post_id FROM post_metrics ORDER BY post_id').all().map((r) => r.post_id);
  assert.deepEqual(after, ['p1', 'p3']);
});

function setNumbers(postId, publishedAt, views, history) {
  db.prepare("UPDATE post_metrics SET published_at = ?, views = ?, likes = 1, status = 'ok' WHERE post_id = ?").run(
    new Date(publishedAt).toISOString(),
    views,
    postId
  );
  for (const [day, v] of history) {
    db.prepare('INSERT OR REPLACE INTO post_daily (post_id, day, views) VALUES (?, ?, ?)').run(postId, day, v);
  }
}

test('overview: totals, views per day and per account, only for the accounts given', () => {
  db.exec('DELETE FROM post_metrics; DELETE FROM post_daily;');
  const batches = [
    batch('new', NOW - 3 * DAY, [item('n1', 'a1'), item('n2', 'a2')]),
    batch('old', NOW - 60 * DAY, [item('o1', 'a1')]),
  ];
  syncTrackedPosts(NOW, batches);
  // n1: followed since it was posted → its first numbers count as gained.
  setNumbers('n1', NOW - 3 * DAY, 300, [
    [dayOf(NOW - 3 * DAY), 100],
    [dayOf(NOW - 2 * DAY), 250],
    [dayOf(NOW - DAY), 300],
  ]);
  setNumbers('n2', NOW - 3 * DAY, 50, [[dayOf(NOW - DAY), 50]]);
  // o1: posted 60 days ago, first checked yesterday → no fake spike.
  setNumbers('o1', NOW - 60 * DAY, 5040, [
    [dayOf(NOW - DAY), 5000],
    [dayOf(NOW), 5040],
  ]);
  const accounts = [
    { id: 'a1', name: 'Main', identifier: 'instagram-standalone' },
    { id: 'a2', name: 'Second', identifier: 'instagram-standalone' },
  ];
  const week = overview({ accounts, days: 7, now: NOW, batches });
  assert.equal(week.totals.videos, 2); // o1 was posted before this week
  assert.equal(week.totals.views, 350);
  const perDay = Object.fromEntries(week.daily.map((d) => [d.day, d.views]));
  assert.equal(perDay[dayOf(NOW - 3 * DAY)], 100);
  assert.equal(perDay[dayOf(NOW - 2 * DAY)], 150);
  assert.equal(perDay[dayOf(NOW - DAY)], 50 + 50 + 0); // n1 +50, n2's first numbers (2 days old), o1 is the baseline
  assert.equal(perDay[dayOf(NOW)], 40); // o1 grew by 40 today
  const main = week.accounts.find((a) => a.id === 'a1');
  assert.equal(main.videos, 1);
  assert.equal(main.bestPostId, 'n1');
  assert.equal(main.avgViews, 300);

  const quarter = overview({ accounts, days: 90, now: NOW, batches });
  assert.equal(quarter.totals.videos, 3);
  assert.equal(quarter.totals.views, 5390);

  // Someone who may only see a2 gets only a2's numbers.
  const onlySecond = overview({ accounts: [accounts[1]], days: 30, now: NOW, batches });
  assert.equal(onlySecond.totals.views, 50);
  assert.deepEqual(
    onlySecond.videos.map((v) => v.postId),
    ['n2']
  );
  assert.equal(videoDetail('n1', { accounts: [accounts[1]], batches }), null);
  const detail = videoDetail('n1', { accounts, batches });
  assert.equal(detail.history.length, 3);
  assert.deepEqual(
    detail.siblings.map((v) => v.postId),
    ['n2']
  );
});

test('account numbers: daily series are added up, totals show the latest value and the change', () => {
  db.exec('DELETE FROM account_stats;');
  const ins = db.prepare('INSERT INTO account_stats (account_id, metric, label, kind, day, value) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('a1', 'reach', 'Reach', 'daily', dayOf(NOW - DAY), 10);
  ins.run('a1', 'reach', 'Reach', 'daily', dayOf(NOW), 15);
  ins.run('a1', 'reach', 'Reach', 'daily', dayOf(NOW - 40 * DAY), 999); // outside the period
  ins.run('a1', 'followers', 'Followers', 'total', dayOf(NOW - 5 * DAY), 1000);
  ins.run('a1', 'followers', 'Followers', 'total', dayOf(NOW), 1100);
  ins.run('a1', 'average_view_duration', 'Average View Duration', 'daily', dayOf(NOW - DAY), 20);
  ins.run('a1', 'average_view_duration', 'Average View Duration', 'daily', dayOf(NOW), 40);
  const { accounts } = overview({ accounts: [{ id: 'a1', name: 'Main', identifier: 'tiktok' }], days: 30, now: NOW, batches: [] });
  const net = Object.fromEntries(accounts[0].network.map((m) => [m.key, m]));
  assert.equal(net.reach.value, 25);
  assert.equal(net.followers.value, 1100);
  assert.equal(net.followers.change, 100);
  assert.equal(net.average_view_duration.value, 30);
});
