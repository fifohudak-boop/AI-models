// Analytics. Fifofarm asks Postiz (which asks each network) how every video it
// posted is doing, often while a video is new and less often as it ages, and
// keeps one snapshot per day so growth can be charted. Account-level numbers
// (followers, reach, ...) come from the same place every few hours.
import { db, tx } from './db.js';
import { postiz } from './postiz.js';
import { allBatches } from './batches.js';
import { platformName } from './platforms.js';
import { claimNewAccounts } from './ownership.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TRACK_DAYS = 90;
const MAX_POST_CALLS_PER_RUN = 40;
const MAX_ACCOUNT_CALLS_PER_RUN = 10;
const ACCOUNT_REFRESH_MS = 6 * HOUR;

// Networks Postiz can report numbers for.
export const ANALYTICS_NETWORKS = new Set([
  'instagram',
  'instagram-standalone',
  'facebook',
  'threads',
  'x',
  'linkedin-page',
  'pinterest',
  'tiktok',
  'youtube',
  'gmb',
]);

export const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'reach'];

// Several networks name the same thing differently.
const COLUMN_SOURCES = {
  views: ['views', 'video_views', 'plays', 'impressions'],
  likes: ['likes', 'reactions'],
  comments: ['comments', 'replies'],
  shares: ['shares', 'reposts', 'retweets'],
  saves: ['saves', 'saved', 'bookmarks'],
  reach: ['reach'],
};

export function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeDay(value, fallbackMs) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? dayOf(ms) : dayOf(fallbackMs);
}

// [{ label, data: [{ total, date }] }] → { views: { label, value }, ... } using
// each metric's newest value.
export function parseMetrics(list) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    const label = String(m?.label ?? '').trim();
    const points = Array.isArray(m?.data) ? m.data : [];
    const value = Number(points[points.length - 1]?.total);
    if (!label || !Number.isFinite(value)) continue;
    out[slug(label)] = { label, value };
  }
  return out;
}

export function columnsFrom(metrics) {
  const out = {};
  for (const [column, sources] of Object.entries(COLUMN_SOURCES)) {
    const key = sources.find((k) => metrics[k]);
    out[column] = key ? Math.round(metrics[key].value) : null;
  }
  return out;
}

// How long until a video's numbers are checked again: hourly while it's new,
// then less and less often; after 90 days the last numbers are kept.
export function refreshDelay(publishedMs, now) {
  const age = now - publishedMs;
  if (!(age >= 0)) return HOUR;
  if (age < 2 * DAY) return HOUR;
  if (age < 7 * DAY) return 6 * HOUR;
  if (age < 30 * DAY) return DAY;
  if (age < TRACK_DAYS * DAY) return 7 * DAY;
  return null;
}

// Start following every posted item in History from the last 90 days (counted
// from when it was posted or scheduled for). Rows whose post was removed from
// History or replaced by a retry are dropped; older posts keep their numbers.
export function syncTrackedPosts(now = Date.now(), batches = allBatches()) {
  const since = now - TRACK_DAYS * DAY;
  const wanted = new Map();
  const inHistory = new Set();
  for (const b of batches) {
    const latest = Math.max(Date.parse(b.createdAt) || 0, Date.parse(b.scheduleAt ?? '') || 0);
    const firstCheck = b.scheduleAt ? Math.max(Date.parse(b.scheduleAt) || now, now) : now;
    for (const item of b.items) {
      if (!item.postId || item.rejected) continue;
      inHistory.add(item.postId);
      if (latest >= since) {
        wanted.set(item.postId, { batchId: b.id, accountId: item.accountId, identifier: item.identifier, firstCheck });
      }
    }
  }
  const known = new Set(db.prepare('SELECT post_id FROM post_metrics').all().map((r) => r.post_id));
  tx(() => {
    const insert = db.prepare(
      `INSERT INTO post_metrics (post_id, batch_id, account_id, identifier, status, next_fetch_at)
       VALUES (?, ?, ?, ?, 'waiting', ?)`
    );
    for (const [postId, w] of wanted) {
      if (!known.has(postId)) insert.run(postId, w.batchId, w.accountId, w.identifier, w.firstCheck);
    }
    const remove = db.prepare('DELETE FROM post_metrics WHERE post_id = ?');
    const removeDaily = db.prepare('DELETE FROM post_daily WHERE post_id = ?');
    for (const postId of known) {
      if (!inHistory.has(postId)) {
        remove.run(postId);
        removeDaily.run(postId);
      }
    }
  });
}

function setStatus(postId, status, error, nextFetchAt, extra = {}) {
  db.prepare(
    `UPDATE post_metrics SET status = ?, error = ?, next_fetch_at = ?,
       published_at = COALESCE(?, published_at), url = COALESCE(?, url)
     WHERE post_id = ?`
  ).run(status, error, nextFetchAt, extra.publishedAt ?? null, extra.url ?? null, postId);
}

function saveNumbers(row, metrics, now, publishedMs) {
  const c = columnsFrom(metrics);
  const delay = refreshDelay(publishedMs, now);
  tx(() => {
    db.prepare(
      `UPDATE post_metrics SET views = ?, likes = ?, comments = ?, shares = ?, saves = ?, reach = ?, extra = ?,
         status = 'ok', error = NULL, fetched_at = ?, next_fetch_at = ?
       WHERE post_id = ?`
    ).run(
      c.views,
      c.likes,
      c.comments,
      c.shares,
      c.saves,
      c.reach,
      JSON.stringify(metrics),
      now,
      delay === null ? null : now + delay,
      row.post_id
    );
    db.prepare(
      `INSERT INTO post_daily (post_id, day, views, likes, comments, shares, saves, reach)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id, day) DO UPDATE SET views = excluded.views, likes = excluded.likes,
         comments = excluded.comments, shares = excluded.shares, saves = excluded.saves, reach = excluded.reach`
    ).run(row.post_id, dayOf(now), c.views, c.likes, c.comments, c.shares, c.saves, c.reach);
  });
}

async function refreshPosts(now, maxCalls) {
  const due = db
    .prepare('SELECT * FROM post_metrics WHERE next_fetch_at IS NOT NULL AND next_fetch_at <= ? ORDER BY next_fetch_at LIMIT ?')
    .all(now, maxCalls);
  if (due.length === 0) return 0;

  // Where each post stands in Postiz (published? when? link?).
  const batches = new Map(allBatches().map((b) => [b.id, b]));
  let start = Infinity;
  let end = -Infinity;
  for (const row of due) {
    const b = batches.get(row.batch_id);
    for (const t of [b && Date.parse(b.createdAt), b?.scheduleAt && Date.parse(b.scheduleAt), now]) {
      if (Number.isFinite(t)) {
        start = Math.min(start, t);
        end = Math.max(end, t);
      }
    }
  }
  const posts = await postiz.listPosts(new Date(start - 2 * DAY), new Date(end + 2 * DAY));
  const byId = new Map(posts.map((p) => [p.id, p]));

  let calls = 0;
  let unreachableInARow = 0;
  for (const row of due) {
    const post = byId.get(row.post_id);
    if (!post) {
      setStatus(row.post_id, 'gone', null, null);
      continue;
    }
    if (post.state === 'ERROR') {
      setStatus(row.post_id, 'failed', null, null);
      continue;
    }
    const publishedMs = Date.parse(post.publishDate);
    if (post.state !== 'PUBLISHED') {
      setStatus(row.post_id, 'waiting', null, Math.max(Number.isFinite(publishedMs) ? publishedMs : now, now) + 15 * MINUTE);
      continue;
    }
    const facts = { publishedAt: new Date(Number.isFinite(publishedMs) ? publishedMs : now).toISOString(), url: post.releaseURL || null };
    const age = now - (Number.isFinite(publishedMs) ? publishedMs : now);
    if (!ANALYTICS_NETWORKS.has(row.identifier)) {
      setStatus(row.post_id, 'unsupported', null, null, facts);
      continue;
    }
    if (!post.releaseId) {
      setStatus(row.post_id, age > 3 * DAY ? 'unavailable' : 'waiting', null, age > 3 * DAY ? null : now + HOUR, facts);
      continue;
    }

    // Not again for a while, even if this call hangs or fails, so one bad post
    // can't keep the others waiting.
    const later = refreshDelay(now - age, now);
    const retryAt = later === null ? null : now + Math.max(later, 6 * HOUR);
    db.prepare('UPDATE post_metrics SET next_fetch_at = ? WHERE post_id = ?').run(now + HOUR, row.post_id);

    let result;
    calls += 1;
    try {
      result = await postiz.postAnalytics(row.post_id, 30);
      unreachableInARow = 0;
    } catch (err) {
      setStatus(row.post_id, row.fetched_at === null ? 'error' : 'ok', err.message, err.status === 503 ? now + HOUR : retryAt, facts);
      // Postiz itself is unreachable: stop here and try again next run.
      if (err.status === 503 && ++unreachableInARow >= 3) throw err;
      continue;
    }
    if (result && !Array.isArray(result) && result.missing) {
      setStatus(row.post_id, 'unavailable', null, null, facts);
      continue;
    }
    const metrics = parseMetrics(result);
    if (Object.keys(metrics).length === 0) {
      if (row.fetched_at !== null) {
        // Had numbers before (the post may have been deleted on the network):
        // keep them and look again less and less often.
        setStatus(row.post_id, 'ok', null, retryAt, facts);
        continue;
      }
      // Networks take a little while before they report numbers for a new post.
      const giveUp = age > 7 * DAY;
      setStatus(row.post_id, giveUp ? 'unavailable' : 'no-data', null, giveUp ? null : now + (age < DAY ? HOUR : 6 * HOUR), facts);
      continue;
    }
    setStatus(row.post_id, 'ok', null, null, facts);
    saveNumbers(row, metrics, now, Number.isFinite(publishedMs) ? publishedMs : now);
  }
  return calls;
}

function saveAccountStats(accountId, list, now) {
  tx(() => {
    const upsert = db.prepare(
      `INSERT INTO account_stats (account_id, metric, label, kind, day, value) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, metric, day) DO UPDATE SET label = excluded.label, kind = excluded.kind, value = excluded.value`
    );
    for (const m of Array.isArray(list) ? list : []) {
      const label = String(m?.label ?? '').trim();
      const points = (Array.isArray(m?.data) ? m.data : []).filter((p) => Number.isFinite(Number(p?.total)));
      if (!label || points.length === 0) continue;
      // One value = a total right now (e.g. TikTok followers); several = one per day.
      const kind = points.length > 1 ? 'daily' : 'total';
      for (const p of points) {
        const day = kind === 'total' ? dayOf(now) : normalizeDay(p.date, now);
        upsert.run(accountId, slug(label), label, kind, day, Number(p.total));
      }
    }
    db.prepare(
      `INSERT INTO account_stats_fetch (account_id, fetched_at, error) VALUES (?, ?, NULL)
       ON CONFLICT(account_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = NULL`
    ).run(accountId, now);
  });
}

async function refreshAccounts(now, accounts, maxCalls) {
  let list = accounts;
  if (!list) {
    list = await postiz.listIntegrations();
    // Also attributes accounts that were connected while nobody had a page open.
    claimNewAccounts(list, now);
  }
  const fetched = new Map(db.prepare('SELECT account_id, fetched_at FROM account_stats_fetch').all().map((r) => [r.account_id, r.fetched_at]));
  let calls = 0;
  for (const a of list) {
    if (a.disabled || !ANALYTICS_NETWORKS.has(a.identifier)) continue;
    if ((fetched.get(a.id) ?? 0) > now - ACCOUNT_REFRESH_MS) continue;
    if (calls >= maxCalls) break;
    calls += 1;
    try {
      saveAccountStats(a.id, await postiz.accountAnalytics(a.id, 30), now);
    } catch (err) {
      if (err.status === 503) throw err;
      db.prepare(
        `INSERT INTO account_stats_fetch (account_id, fetched_at, error) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`
      ).run(a.id, now, String(err.message).slice(0, 300));
    }
  }
  return calls;
}

let running = null;

// One run: pick up new posts, refresh what's due, refresh account numbers.
// Concurrent callers share the run that's already going.
export function runAnalytics({ now = Date.now(), accounts, maxPostCalls = MAX_POST_CALLS_PER_RUN } = {}) {
  if (!running) {
    running = (async () => {
      syncTrackedPosts(now);
      let failure = null;
      try {
        await refreshPosts(now, maxPostCalls);
      } catch (err) {
        failure = err;
      }
      try {
        await refreshAccounts(now, accounts, MAX_ACCOUNT_CALLS_PER_RUN);
      } catch (err) {
        failure ??= err;
      }
      if (failure) throw failure;
    })().finally(() => {
      running = null;
    });
  }
  return running;
}

export function startAnalyticsLoop({ everyMs = 10 * MINUTE, firstAfterMs = 60 * 1000 } = {}) {
  const run = () =>
    runAnalytics().catch((err) => {
      if (err?.status !== 503 && err?.status !== 401) console.error('Analytics refresh failed:', err.message);
    });
  setTimeout(run, firstAfterMs).unref();
  setInterval(run, everyMs).unref();
}

// "Refresh now": these accounts' videos and numbers are fetched on the next run.
export function markDue(accountIds, now = Date.now()) {
  if (accountIds.length === 0) return;
  const marks = accountIds.map(() => '?').join(',');
  tx(() => {
    db.prepare(
      `UPDATE post_metrics SET next_fetch_at = ? WHERE account_id IN (${marks})
         AND status IN ('ok', 'no-data', 'waiting', 'error')`
    ).run(now, ...accountIds);
    db.prepare(`DELETE FROM account_stats_fetch WHERE account_id IN (${marks})`).run(...accountIds);
  });
}

// ---- Reading ----

function placeholders(list) {
  return list.map(() => '?').join(',');
}

function videoFrom(row, batch, account) {
  return {
    postId: row.post_id,
    batchId: row.batch_id,
    accountId: row.account_id,
    accountName: account?.name ?? 'Removed account',
    identifier: row.identifier,
    platform: platformName(row.identifier),
    picture: account?.picture ?? null,
    caption: batch?.caption ?? '',
    title: batch?.title ?? '',
    previewUrl: batch?.media?.previewUrl ?? null,
    kind: batch?.media?.kind ?? null,
    postedAt: row.published_at ?? batch?.scheduleAt ?? batch?.createdAt ?? null,
    published: !!row.published_at,
    url: row.url,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
    reach: row.reach,
    status: row.status,
    error: row.error,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
  };
}

// Views gained per day across these videos. A video's first numbers only count
// if Fifofarm started following it right after it was posted (otherwise the
// first day would show all its views ever).
function viewsPerDay(accountIds, publishedById, days, now) {
  const out = new Map();
  for (let i = days - 1; i >= 0; i -= 1) out.set(dayOf(now - i * DAY), 0);
  const rows = db
    .prepare(
      `SELECT d.post_id, d.day, d.views FROM post_daily d JOIN post_metrics m ON m.post_id = d.post_id
       WHERE m.account_id IN (${placeholders(accountIds)}) ORDER BY d.post_id, d.day`
    )
    .all(...accountIds);
  let currentPost = null;
  let previous = null;
  for (const r of rows) {
    if (r.post_id !== currentPost) {
      currentPost = r.post_id;
      previous = null;
    }
    if (r.views === null) continue;
    let gained;
    if (previous === null) {
      const published = Date.parse(publishedById.get(r.post_id) ?? '');
      gained = Number.isFinite(published) && Date.parse(r.day) - Date.parse(dayOf(published)) <= 2 * DAY ? r.views : 0;
    } else {
      gained = Math.max(0, r.views - previous);
    }
    previous = r.views;
    if (out.has(r.day)) out.set(r.day, out.get(r.day) + gained);
  }
  return [...out.entries()].map(([day, views]) => ({ day, views }));
}

function networkStats(accountIds, sinceDay) {
  const rows = db
    .prepare(
      `SELECT account_id, metric, label, kind, day, value FROM account_stats
       WHERE account_id IN (${placeholders(accountIds)}) AND day >= ? ORDER BY account_id, metric, day`
    )
    .all(...accountIds, sinceDay);
  const byAccount = new Map();
  for (const r of rows) {
    const metrics = byAccount.get(r.account_id) ?? new Map();
    byAccount.set(r.account_id, metrics);
    const m = metrics.get(r.metric) ?? { key: r.metric, label: r.label, kind: r.kind, points: [] };
    metrics.set(r.metric, m);
    m.label = r.label;
    m.kind = r.kind;
    m.points.push({ day: r.day, value: r.value });
  }
  const out = new Map();
  for (const [accountId, metrics] of byAccount) {
    out.set(
      accountId,
      [...metrics.values()].map((m) => {
        const values = m.points.map((p) => p.value);
        let value;
        let change = null;
        if (m.kind === 'daily') {
          const sum = values.reduce((a, b) => a + b, 0);
          value = m.key.startsWith('average') ? sum / values.length : sum;
        } else {
          value = values[values.length - 1];
          if (values.length > 1) change = value - values[0];
        }
        return { key: m.key, label: m.label, kind: m.kind, value, change, points: m.points };
      })
    );
  }
  return out;
}

const empty = () => ({ videos: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0 });

function addTo(totals, v) {
  totals.videos += 1;
  for (const k of ['views', 'likes', 'comments', 'shares', 'saves']) totals[k] += v[k] ?? 0;
}

// Everything the Analytics page shows, for the given accounts (already limited
// to what the person may see) and period.
export function overview({ accounts, days = 30, now = Date.now(), batches = allBatches(), ownerNames = new Map() }) {
  const since = now - days * DAY;
  const accountIds = accounts.map((a) => a.id);
  const result = {
    days,
    generatedAt: new Date(now).toISOString(),
    lastCheckedAt: null,
    totals: empty(),
    daily: [],
    accounts: [],
    videos: [],
  };
  if (accountIds.length === 0) {
    result.daily = viewsPerDay(['-'], new Map(), days, now);
    return result;
  }
  const batchesById = new Map(batches.map((b) => [b.id, b]));
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const rows = db
    .prepare(`SELECT * FROM post_metrics WHERE account_id IN (${placeholders(accountIds)})`)
    .all(...accountIds);

  const publishedById = new Map(rows.map((r) => [r.post_id, r.published_at]));
  const perAccount = new Map(accounts.map((a) => [a.id, { ...empty(), best: null }]));
  let lastChecked = 0;
  for (const row of rows) {
    if (row.fetched_at) lastChecked = Math.max(lastChecked, row.fetched_at);
    if (['failed', 'gone'].includes(row.status)) continue;
    const batch = batchesById.get(row.batch_id);
    const video = videoFrom(row, batch, accountsById.get(row.account_id));
    const when = Date.parse(video.postedAt ?? '');
    if (!(when >= since)) continue;
    result.videos.push(video);
    if (!video.published) continue;
    addTo(result.totals, video);
    const acc = perAccount.get(row.account_id);
    if (acc) {
      addTo(acc, video);
      if (video.views !== null && (!acc.best || video.views > acc.best.views)) acc.best = { postId: video.postId, views: video.views };
    }
  }
  result.videos.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
  result.lastCheckedAt = lastChecked ? new Date(lastChecked).toISOString() : null;
  result.daily = viewsPerDay(accountIds, publishedById, days, now);

  const network = networkStats(accountIds, dayOf(since));
  const fetches = new Map(
    db
      .prepare(`SELECT * FROM account_stats_fetch WHERE account_id IN (${placeholders(accountIds)})`)
      .all(...accountIds)
      .map((r) => [r.account_id, r])
  );
  result.accounts = accounts.map((a) => {
    const stats = perAccount.get(a.id);
    const fetch = fetches.get(a.id);
    return {
      id: a.id,
      name: a.name,
      identifier: a.identifier,
      platform: a.platform ?? platformName(a.identifier),
      picture: a.picture ?? null,
      profile: a.profile ?? null,
      ownerId: a.ownerId ?? null,
      ownerName: a.ownerId ? ownerNames.get(a.ownerId) ?? null : null,
      supported: ANALYTICS_NETWORKS.has(a.identifier),
      videos: stats.videos,
      views: stats.views,
      likes: stats.likes,
      comments: stats.comments,
      shares: stats.shares,
      saves: stats.saves,
      avgViews: stats.videos ? Math.round(stats.views / stats.videos) : 0,
      bestPostId: stats.best?.postId ?? null,
      network: network.get(a.id) ?? [],
      networkCheckedAt: fetch ? new Date(fetch.fetched_at).toISOString() : null,
      networkError: fetch?.error ?? null,
    };
  });
  return result;
}

// One video: its daily growth and the same video on the other accounts.
export function videoDetail(postId, { accounts, batches = allBatches() }) {
  const row = db.prepare('SELECT * FROM post_metrics WHERE post_id = ?').get(postId);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  if (!row || !accountsById.has(row.account_id)) return null;
  const batch = batches.find((b) => b.id === row.batch_id);
  const history = db
    .prepare('SELECT day, views, likes, comments, shares, saves, reach FROM post_daily WHERE post_id = ? ORDER BY day')
    .all(postId);
  const siblings = db
    .prepare('SELECT * FROM post_metrics WHERE batch_id = ? AND post_id != ?')
    .all(row.batch_id, postId)
    .filter((r) => accountsById.has(r.account_id))
    .map((r) => videoFrom(r, batch, accountsById.get(r.account_id)));
  let extra = {};
  try {
    extra = row.extra ? JSON.parse(row.extra) : {};
  } catch {
    extra = {};
  }
  return {
    video: videoFrom(row, batch, accountsById.get(row.account_id)),
    metrics: Object.values(extra),
    history,
    siblings,
  };
}
