import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_PASSWORD,
  PORT,
  POSTIZ_PUBLIC_URL,
  UPLOAD_TMP_DIR,
  apiKeyFromEnv,
  getApiKey,
  getSettings,
  saveSettings,
} from './config.js';
import {
  checkPassword,
  clearSessionCookie,
  isLoggedIn,
  requireLogin,
  sameOriginOnly,
  sessionCookie,
  tooManyFailures,
} from './auth.js';
import { PostizError, postiz } from './postiz.js';
import {
  buildPostRequest,
  countLength,
  isSupported,
  platformCatalog,
  platformName,
  preflight,
} from './platforms.js';
import { getMediaJob, getMediaResult, startMediaJob } from './media.js';
import {
  createBatch,
  getBatch,
  listBatches,
  postsWindow,
  removeBatch,
  updateBatch,
  withStatus,
} from './batches.js';

if (!DASHBOARD_PASSWORD) {
  console.error('DASHBOARD_PASSWORD is not set. Run ./install.sh or add it to .env, then restart.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const app = express();
app.set('trust proxy', 'loopback, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/api', sameOriginOnly);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---- Session ----

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: isLoggedIn(req) });
});

app.post('/api/login', (req, res) => {
  if (tooManyFailures(req.ip)) {
    return res.status(429).json({ error: 'Too many wrong passwords. Wait 15 minutes and try again.' });
  }
  if (!checkPassword(req.ip, req.body?.password)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  res.setHeader('Set-Cookie', sessionCookie());
  res.json({ loggedIn: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ loggedIn: false });
});

app.use('/api', requireLogin);

// ---- Setup & settings ----

app.get(
  '/api/status',
  asyncRoute(async (_req, res) => {
    const base = { postizUrl: POSTIZ_PUBLIC_URL, apiKeyFromEnv: apiKeyFromEnv() };
    if (!getApiKey()) return res.json({ ...base, postiz: 'no-key' });
    try {
      const [, worker] = await Promise.all([postiz.checkKey(), postiz.workerState()]);
      res.json({ ...base, postiz: 'ok', worker });
    } catch (err) {
      if (!(err instanceof PostizError)) throw err;
      res.json({ ...base, postiz: err.status === 401 ? 'bad-key' : 'unreachable', detail: err.message });
    }
  })
);

app.put(
  '/api/settings/api-key',
  asyncRoute(async (req, res) => {
    if (apiKeyFromEnv()) {
      return res.status(409).json({ error: 'The API key is set in .env — change it there.' });
    }
    const apiKey = req.body?.apiKey;
    if (!isNonEmptyString(apiKey)) return res.status(400).json({ error: 'Paste the API key first.' });
    try {
      await postiz.checkKey(apiKey.trim());
    } catch (err) {
      if (err instanceof PostizError && err.status === 401) {
        return res.status(400).json({ error: "Postiz didn't accept that key. Copy it again from Postiz → Settings." });
      }
      throw err;
    }
    saveSettings({ postizApiKey: apiKey.trim() });
    res.json({ ok: true });
  })
);

const PREFERENCE_RULES = {
  youtubeVisibility: (v) => ['public', 'unlisted', 'private'].includes(v),
  tiktokPrivacy: (v) => ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(v),
  tiktokAllowComments: (v) => typeof v === 'boolean',
  tiktokAllowDuet: (v) => typeof v === 'boolean',
  tiktokAllowStitch: (v) => typeof v === 'boolean',
  tiktokMode: (v) => ['DIRECT_POST', 'UPLOAD'].includes(v),
  xWhoCanReply: (v) => ['everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'].includes(v),
  autoShorten: (v) => typeof v === 'boolean',
  pinterestBoards: (v) =>
    v && typeof v === 'object' && Object.values(v).every((id) => typeof id === 'string' && /^\d*$/.test(id)),
};

app.get('/api/preferences', (_req, res) => {
  res.json(getSettings().preferences);
});

app.put('/api/preferences', (req, res) => {
  const patch = {};
  for (const [key, value] of Object.entries(req.body ?? {})) {
    const rule = PREFERENCE_RULES[key];
    if (!rule) return res.status(400).json({ error: `Unknown setting: ${key}` });
    if (!rule(value)) return res.status(400).json({ error: `Invalid value for ${key}` });
    patch[key] = value;
  }
  if (patch.pinterestBoards) {
    patch.pinterestBoards = { ...getSettings().preferences.pinterestBoards, ...patch.pinterestBoards };
  }
  res.json(saveSettings({ preferences: patch }).preferences);
});

// ---- Accounts ----

app.get('/api/platforms', (_req, res) => {
  res.json(platformCatalog(process.env));
});

const maxLengthCache = new Map();
async function maxLengthFor(account) {
  const cached = maxLengthCache.get(account.id);
  if (cached && cached.at > Date.now() - 10 * 60 * 1000) return cached.value;
  const value = await postiz.integrationMaxLength(account.id).catch(() => cached?.value ?? 0);
  maxLengthCache.set(account.id, { value, at: Date.now() });
  return value;
}

let accountsCache = null;
function forgetAccounts() {
  accountsCache = null;
}

async function loadAccounts({ fresh = false } = {}) {
  if (!fresh && accountsCache && accountsCache.at > Date.now() - 5000) return accountsCache.value;
  const value = await fetchAccounts();
  accountsCache = { value, at: Date.now() };
  return value;
}

async function fetchAccounts() {
  const list = await postiz.listIntegrations();
  return Promise.all(
    list.map(async (a) => ({
      id: a.id,
      name: a.name,
      identifier: a.identifier,
      picture: a.picture || null,
      profile: a.profile || null,
      disabled: !!a.disabled,
      platform: platformName(a.identifier),
      supported: isSupported(a.identifier),
      maxLength: await maxLengthFor(a),
    }))
  );
}

app.get(
  '/api/accounts',
  asyncRoute(async (_req, res) => {
    res.json(await loadAccounts({ fresh: true }));
  })
);

app.post(
  '/api/accounts/connect',
  asyncRoute(async (req, res) => {
    const provider = req.body?.provider;
    const entry = platformCatalog(process.env).find((p) => p.identifier === provider);
    if (!entry || entry.connect !== 'oauth') return res.status(400).json({ error: 'Unknown network.' });
    if (!entry.configured) {
      return res.status(400).json({
        error: `${entry.name} isn't set up yet. Add ${entry.missingKeys.join(' and ')} to .env and restart.`,
      });
    }
    res.json({ url: await postiz.connectUrl(provider) });
  })
);

app.post(
  '/api/accounts/bluesky',
  asyncRoute(async (req, res) => {
    const { handle, appPassword } = req.body ?? {};
    const service = isNonEmptyString(req.body?.service) ? req.body.service.trim() : 'https://bsky.social';
    if (!isNonEmptyString(handle) || !isNonEmptyString(appPassword)) {
      return res.status(400).json({ error: 'Enter your Bluesky handle and an app password.' });
    }
    try {
      await postiz.connectWithFields('bluesky', {
        service,
        identifier: handle.trim().replace(/^@/, ''),
        password: appPassword.trim(),
      });
    } catch (err) {
      if (err instanceof PostizError && err.status < 500) {
        return res.status(400).json({ error: 'Bluesky refused that handle or app password.' });
      }
      throw err;
    }
    forgetAccounts();
    res.json({ ok: true });
  })
);

app.delete(
  '/api/accounts/:id',
  asyncRoute(async (req, res) => {
    await postiz.deleteIntegration(req.params.id);
    maxLengthCache.delete(req.params.id);
    forgetAccounts();
    res.json({ ok: true });
  })
);

app.get(
  '/api/accounts/:id/boards',
  asyncRoute(async (req, res) => {
    res.json(await postiz.pinterestBoards(req.params.id));
  })
);

// ---- Media ----

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (_req, _file, cb) => cb(null, `in-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

app.post('/api/media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  res.status(202).json(startMediaJob(req.file.path, req.file.originalname || 'video'));
});

app.get('/api/media/:id', (req, res) => {
  const job = getMediaJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Upload not found — add the file again.' });
  res.json(job);
});

// ---- Posting ----

function readCaptions(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string'));
}

// What will happen per account if you press Post now: length vs. limit,
// automatic shortening, blocking problems and soft warnings. The Post page
// calls this as you type so it shows exactly what the server will do.
app.post(
  '/api/preview',
  asyncRoute(async (req, res) => {
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const captions = readCaptions(req.body?.captions);
    const media = req.body?.mediaId ? getMediaResult(req.body.mediaId) : null;
    const prefs = getSettings().preferences;
    const accounts = await loadAccounts();
    const out = {};
    for (const account of accounts) {
      const text = captions[account.id] ?? caption;
      const length = countLength(account.identifier, text);
      const { problems, warnings } = preflight(account, { media, caption: text }, prefs);
      const over = account.maxLength > 0 && length > account.maxLength;
      out[account.id] = {
        length,
        max: account.maxLength,
        over,
        willShorten: over && prefs.autoShorten,
        problems: over && !prefs.autoShorten ? [...problems, 'Caption is too long for this network.'] : problems,
        warnings,
      };
    }
    res.json(out);
  })
);

async function sendToAccount(account, input, prefs) {
  const item = {
    accountId: account.id,
    accountName: account.name,
    identifier: account.identifier,
    platform: platformName(account.identifier),
    picture: account.picture,
    postId: null,
    rejected: null,
    shortened: false,
    sentAt: new Date().toISOString(),
  };
  const { problems } = preflight(account, input, prefs);
  if (problems.length) return { ...item, rejected: problems.join(' ') };
  try {
    const { body, shortened } = buildPostRequest(account, input, prefs, account.maxLength);
    const created = await postiz.createPost(body);
    const postId = Array.isArray(created) ? created[0]?.postId : null;
    if (!postId) return { ...item, rejected: 'Postiz did not create the post.' };
    return { ...item, postId, shortened };
  } catch (err) {
    if (err instanceof PostizError && err.status < 500 && err.status !== 401) {
      return { ...item, rejected: err.message };
    }
    throw err;
  }
}

function parseSchedule(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, error: 'That date and time is not valid.' };
  if (ms < Date.now() - 60_000) return { ok: false, error: 'Pick a time in the future.' };
  return { ok: true, value: new Date(ms).toISOString() };
}

app.post(
  '/api/posts',
  asyncRoute(async (req, res) => {
    const { accountIds, mediaId } = req.body ?? {};
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const captions = readCaptions(req.body?.captions);

    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ error: 'Choose at least one account.' });
    }
    if (caption.length > 20000) return res.status(400).json({ error: 'The caption is too long.' });
    const schedule = parseSchedule(req.body?.scheduleAt);
    if (!schedule.ok) return res.status(400).json({ error: schedule.error });

    let media = null;
    if (mediaId) {
      media = getMediaResult(mediaId);
      if (!media) return res.status(400).json({ error: 'The upload expired or is still processing — add the file again.' });
    }
    if (!media && !caption.trim()) return res.status(400).json({ error: 'Add a video or write a caption.' });

    const accounts = await loadAccounts();
    const chosen = accountIds.map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
    if (chosen.length !== accountIds.length) {
      return res.status(400).json({ error: 'Some accounts no longer exist — refresh the page.' });
    }

    const prefs = getSettings().preferences;
    const input = { caption, title, captions, media, mediaName: media?.name, scheduleAt: schedule.value };
    const items = await Promise.all(chosen.map((account) => sendToAccount(account, input, prefs)));

    const batch = createBatch({
      caption,
      title,
      captions,
      media,
      scheduleAt: schedule.value,
      items,
    });
    res.status(201).json(withStatus(batch, null, []));
  })
);

async function liveStatus(batches) {
  const window = postsWindow(batches);
  if (!window) return [];
  const posts = await postiz.listPosts(window.start, window.end);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const anyError = batches.some((b) => b.items.some((i) => byId.get(i.postId)?.state === 'ERROR'));
  const notifications = anyError ? await postiz.notifications().catch(() => []) : [];
  return batches.map((b) => withStatus(b, byId, notifications));
}

app.get(
  '/api/batches',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    res.json(await liveStatus(listBatches(limit)));
  })
);

app.get(
  '/api/batches/:id',
  asyncRoute(async (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Not found.' });
    const [withLive] = await liveStatus([batch]);
    res.json(withLive);
  })
);

// Two retries of the same post at once (double click, two tabs) would post twice.
const retrying = new Set();

app.post(
  '/api/batches/:id/retry',
  asyncRoute(async (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Not found.' });
    if (retrying.has(batch.id)) return res.status(409).json({ error: 'Already retrying this post.' });
    retrying.add(batch.id);
    try {
      await retryBatch(batch, res);
    } finally {
      retrying.delete(batch.id);
    }
  })
);

async function retryBatch(batch, res) {
  const [current] = await liveStatus([batch]);
  const failed = current.items.filter((i) => i.state === 'failed');
  if (failed.length === 0) return res.json(current);

  const accounts = await loadAccounts();
  const prefs = getSettings().preferences;
  const scheduleAt = batch.scheduleAt && Date.parse(batch.scheduleAt) > Date.now() ? batch.scheduleAt : null;
  const input = { ...batch, mediaName: batch.media?.name, scheduleAt };

  const retried = await Promise.all(
    failed.map(async (old) => {
      const account = accounts.find((a) => a.id === old.accountId);
      if (!account) return { ...old, rejected: 'This account was removed.', postId: null };
      if (old.postId) await postiz.deletePost(old.postId).catch(() => {});
      return sendToAccount(account, input, prefs);
    })
  );

  updateBatch(batch.id, (b) => {
    b.items = b.items.map((item) => retried.find((r) => r.accountId === item.accountId) ?? item);
  });
  const [updated] = await liveStatus([getBatch(batch.id)]);
  res.json(updated);
}

app.delete(
  '/api/batches/:id',
  asyncRoute(async (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'Not found.' });
    await Promise.all(
      batch.items.filter((i) => i.postId).map((i) => postiz.deletePost(i.postId).catch(() => {}))
    );
    removeBatch(batch.id);
    res.json({ ok: true });
  })
);

// ---- Errors ----

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 4 GB.' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err instanceof PostizError) {
    const status = err.status === 401 ? 424 : err.status >= 500 ? 502 : 400;
    return res.status(status).json({ error: err.message, postiz: true });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the dashboard server.' });
});

// ---- Frontend ----

app.use(express.static(DIST_DIR, { index: false, maxAge: '1h' }));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AutoPost dashboard on http://localhost:${PORT} (Postiz: ${POSTIZ_PUBLIC_URL})`);
});
