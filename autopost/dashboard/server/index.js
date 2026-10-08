import express from 'express';
import multer from 'multer';
import { randomInt } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAND_NAME,
  DASHBOARD_DOMAIN,
  DASHBOARD_URL,
  PORT,
  POSTIZ_DOMAIN,
  POSTIZ_PUBLIC_URL,
  UPLOAD_TMP_DIR,
  VERIFICATION_DIR,
  apiKeyFromEnv,
  getApiKey,
  getSettings,
  saveSettings,
} from './config.js';
import {
  changePassword,
  clearSessionCookie,
  login,
  ownerNeedsEmail,
  requireLogin,
  requireOwner,
  sameOriginOnly,
  sessionCookie,
  signup,
  userFromRequest,
} from './auth.js';
import {
  ensureOwner,
  getUser,
  listUsers,
  ownerUser,
  publicUser,
  removeUser,
  setPassword,
  setSignupsOpen,
  signupsOpen,
  updateProfile,
} from './users.js';
import {
  assignAccount,
  canUseAccount,
  claimNewAccounts,
  forgetAccount,
  ownerMap,
  recordPendingConnect,
  visibleAccounts,
} from './ownership.js';
import { markDue, overview, runAnalytics, startAnalyticsLoop, videoDetail } from './analytics.js';
import {
  VERIFICATION_NAME_PATTERN,
  setupCatalog,
  validateSetupValues,
  validateVerificationFile,
  withAccountChooser,
} from './networks.js';
import { hostStatus, requestEnvChanges, requestUpdateCheck } from './runtime.js';
import { autoSetupState, startAutoSetup, trySetupOnce } from './setup.js';
import { legalPage } from './legal.js';
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
  batchOwner,
  createBatch,
  getBatch,
  listBatches,
  postsWindow,
  removeBatch,
  updateBatch,
  withStatus,
} from './batches.js';

// The person who installed Fifofarm is the owner (their DASHBOARD_PASSWORD,
// or the password they set in Settings, keeps working).
if (!ensureOwner()) {
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

// ---- Public pages (no login) ----

// Terms / privacy / data-deletion pages that developer apps ask for.
app.get('/legal/:page', (req, res) => {
  const html = legalPage(req.params.page, {
    name: BRAND_NAME,
    domain: DASHBOARD_DOMAIN,
    contact: process.env.LEGAL_CONTACT_EMAIL,
  });
  if (!html) return res.status(404).send('Not found');
  res.type('html').send(html);
});

// Site-verification files uploaded in Settings (e.g. TikTok's URL-prefix
// signature file). Caddy also routes "/<name>.txt" on the Postiz domain here.
app.get(/^\/([A-Za-z0-9_-]{1,120}\.txt)$/, (req, res, next) => {
  const name = req.params[0];
  if (!VERIFICATION_NAME_PATTERN.test(name)) return next();
  const file = path.join(VERIFICATION_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).type('text').send('Not found');
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

// For install.sh: is everything up? No secrets in here.
app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    let engine = 'starting';
    if (getApiKey()) {
      engine = await postiz
        .checkKey()
        .then(() => 'ready')
        .catch((err) => (err instanceof PostizError && err.status === 401 ? 'bad-key' : 'starting'));
    }
    res.json({ dashboard: 'ok', engine, setup: autoSetupState().phase });
  })
);

// ---- Session & sign-up ----

function sessionInfo(user) {
  return {
    loggedIn: !!user,
    user: publicUser(user),
    signupsOpen: signupsOpen(),
    // Until the owner adds an email, they sign in with just their password.
    ownerNeedsEmail: ownerNeedsEmail(),
    brand: BRAND_NAME,
  };
}

app.get('/api/session', (req, res) => {
  res.json(sessionInfo(userFromRequest(req)));
});

app.post('/api/login', (req, res) => {
  const result = login(req.ip, req.body?.email, req.body?.password);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.setHeader('Set-Cookie', sessionCookie(result.user));
  res.json(sessionInfo(result.user));
});

app.post('/api/signup', (req, res) => {
  const result = signup(req.ip, {
    name: req.body?.name,
    email: req.body?.email,
    password: req.body?.password,
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.setHeader('Set-Cookie', sessionCookie(result.user));
  res.status(201).json(sessionInfo(result.user));
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ loggedIn: false });
});

app.use('/api', requireLogin);

const isOwner = (req) => req.user.role === 'owner';

// ---- Setup & settings ----

app.get(
  '/api/status',
  asyncRoute(async (_req, res) => {
    const base = {
      brand: BRAND_NAME,
      postizUrl: POSTIZ_PUBLIC_URL,
      apiKeyFromEnv: apiKeyFromEnv(),
      autoSetup: autoSetupState().phase,
    };
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
  requireOwner,
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

// Fresh install: create the Postiz account + API key now (also runs by itself
// in the background while Postiz starts).
app.post(
  '/api/setup/auto',
  requireOwner,
  asyncRoute(async (_req, res) => {
    const phase = await trySetupOnce();
    res.json({ phase, detail: autoSetupState().detail });
  })
);

// ---- Your account ----

app.put('/api/settings/password', (req, res) => {
  const result = changePassword(req.ip, req.user, req.body?.current, req.body?.next);
  if (result.error) return res.status(result.status).json({ error: result.error });
  // This browser stays signed in; every other one has to sign in again.
  res.setHeader('Set-Cookie', sessionCookie(result.user));
  res.json({ ok: true });
});

app.put('/api/me', (req, res) => {
  const result = updateProfile(req.user.id, { name: req.body?.name, email: req.body?.email });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(sessionInfo(result.user));
});

// ---- Team (owner) ----

function userCounts() {
  const owner = ownerUser();
  const accounts = new Map();
  for (const userId of ownerMap().values()) accounts.set(userId, (accounts.get(userId) ?? 0) + 1);
  const posts = new Map();
  for (const b of listBatches(Infinity)) {
    const id = batchOwner(b, owner.id);
    posts.set(id, (posts.get(id) ?? 0) + 1);
  }
  return { accounts, posts };
}

app.get('/api/team', requireOwner, (_req, res) => {
  const { accounts, posts } = userCounts();
  res.json({
    signupsOpen: signupsOpen(),
    users: listUsers().map((u) => ({ ...publicUser(u), accounts: accounts.get(u.id) ?? 0, posts: posts.get(u.id) ?? 0 })),
  });
});

app.put('/api/team/signups', requireOwner, (req, res) => {
  if (typeof req.body?.open !== 'boolean') return res.status(400).json({ error: 'Say open: true or false.' });
  setSignupsOpen(req.body.open);
  res.json({ signupsOpen: signupsOpen() });
});

const TEMP_PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.post('/api/team/:id/reset-password', requireOwner, (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Change your own password under Your account.' });
  const password = Array.from({ length: 12 }, () => TEMP_PASSWORD_CHARS[randomInt(TEMP_PASSWORD_CHARS.length)]).join('');
  setPassword(user.id, password);
  res.json({ password });
});

app.delete('/api/team/:id', requireOwner, (req, res) => {
  const result = removeUser(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---- System: version, updates, domain ----

function serverDomains() {
  return {
    serverMode: !!DASHBOARD_DOMAIN,
    dashboard: DASHBOARD_DOMAIN,
    postiz: POSTIZ_DOMAIN,
    dashboardUrl: DASHBOARD_URL,
    postizUrl: POSTIZ_PUBLIC_URL,
  };
}

app.get('/api/system', requireOwner, (_req, res) => {
  const { postizLogin } = getSettings();
  res.json({
    brand: BRAND_NAME,
    host: hostStatus(),
    domains: serverDomains(),
    postizLogin: postizLogin ? { email: postizLogin.email, password: postizLogin.password } : null,
  });
});

app.post('/api/system/check-updates', requireOwner, (_req, res) => {
  try {
    requestUpdateCheck();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  res.json({ ok: true });
});

const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function ipv4(host) {
  try {
    return await dns.promises.resolve4(host);
  } catch {
    return [];
  }
}

app.put(
  '/api/settings/domain',
  requireOwner,
  asyncRoute(async (req, res) => {
    if (!DASHBOARD_DOMAIN) {
      return res.status(409).json({ error: 'Changing the domain needs server mode (install.sh → option 2).' });
    }
    const domain = String(req.body?.domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const engine = String(req.body?.engineDomain ?? '').trim().toLowerCase() || `postiz.${domain}`;
    if (!DOMAIN_PATTERN.test(domain) || !DOMAIN_PATTERN.test(engine)) {
      return res.status(400).json({ error: 'Enter a domain like fifofarm.com' });
    }
    if (domain === DASHBOARD_DOMAIN && engine === POSTIZ_DOMAIN) {
      return res.status(400).json({ error: 'That is already the current domain.' });
    }
    const serverIps = await ipv4(DASHBOARD_DOMAIN);
    const [a, b] = await Promise.all([ipv4(domain), ipv4(engine)]);
    const ip = serverIps[0] ?? 'this server\'s IP';
    const pointsHere = (ips) => ips.some((x) => serverIps.includes(x));
    if (!pointsHere(a) || !pointsHere(b)) {
      return res.status(400).json({
        error: `First point ${domain} and ${engine} to ${ip} (an "A" record at your domain provider), wait a few minutes, then try again.`,
        dns: { [domain]: a, [engine]: b, server: serverIps },
      });
    }
    try {
      requestEnvChanges({
        DASHBOARD_DOMAIN: domain,
        POSTIZ_DOMAIN: engine,
        DASHBOARD_URL: `https://${domain}`,
        POSTIZ_URL: `https://${engine}`,
      });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    res.json({ ok: true, dashboardUrl: `https://${domain}`, postizUrl: `https://${engine}` });
  })
);

// ---- Network setup (developer keys) ----

function verificationFiles() {
  try {
    return fs.readdirSync(VERIFICATION_DIR).filter((name) => VERIFICATION_NAME_PATTERN.test(name));
  } catch {
    return [];
  }
}

app.get('/api/networks', (_req, res) => {
  const host = hostStatus();
  res.json({
    setups: setupCatalog(process.env, { postizUrl: POSTIZ_PUBLIC_URL, dashboardUrl: DASHBOARD_URL }),
    verificationFiles: verificationFiles(),
    autoApply: host.available && host.helperActive,
    pending: host.pending,
    apply: host.apply,
  });
});

app.put('/api/networks/:id', requireOwner, (req, res) => {
  const { changes, error } = validateSetupValues(req.params.id, req.body?.values);
  if (error) return res.status(400).json({ error });
  try {
    requestEnvChanges(changes);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  const host = hostStatus();
  res.json({ ok: true, autoApply: host.helperActive, keys: Object.keys(changes) });
});

app.put('/api/verification', requireOwner, (req, res) => {
  const { name, content, error } = validateVerificationFile(
    String(req.body?.name ?? '').trim(),
    String(req.body?.content ?? '')
  );
  if (error) return res.status(400).json({ error });
  fs.writeFileSync(path.join(VERIFICATION_DIR, name), content);
  res.json({ ok: true, files: verificationFiles() });
});

app.delete('/api/verification/:name', requireOwner, (req, res) => {
  if (!VERIFICATION_NAME_PATTERN.test(req.params.name)) return res.status(400).json({ error: 'Bad name.' });
  fs.rmSync(path.join(VERIFICATION_DIR, req.params.name), { force: true });
  res.json({ ok: true, files: verificationFiles() });
});

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

app.get('/api/preferences', (req, res) => {
  const prefs = getSettings().preferences;
  if (isOwner(req)) return res.json(prefs);
  // Members only see the Pinterest boards of their own accounts.
  const owners = ownerMap();
  const boards = Object.fromEntries(
    Object.entries(prefs.pinterestBoards).filter(([id]) => canUseAccount(req.user, id, owners))
  );
  res.json({ ...prefs, pinterestBoards: boards });
});

// Posting defaults are shared by the whole team, so only the owner changes
// them. Anyone may pick the Pinterest board of their own accounts.
app.put('/api/preferences', (req, res) => {
  const patch = {};
  const owners = ownerMap();
  for (const [key, value] of Object.entries(req.body ?? {})) {
    const rule = PREFERENCE_RULES[key];
    if (!rule) return res.status(400).json({ error: `Unknown setting: ${key}` });
    if (!rule(value)) return res.status(400).json({ error: `Invalid value for ${key}` });
    if (!isOwner(req)) {
      if (key !== 'pinterestBoards') return res.status(403).json({ error: 'Only the owner can change posting defaults.' });
      if (!Object.keys(value).every((id) => canUseAccount(req.user, id, owners))) {
        return res.status(403).json({ error: "That isn't one of your accounts." });
      }
    }
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
  // New accounts belong to whoever just connected them (see ownership.js).
  claimNewAccounts(list);
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

function userNames() {
  return new Map(listUsers().map((u) => [u.id, u.name]));
}

// The accounts this person may see and post to; each says who owns it.
async function accountsFor(user, options) {
  const names = userNames();
  return visibleAccounts(user, await loadAccounts(options)).map((a) => ({
    ...a,
    ownerName: names.get(a.ownerId) ?? null,
  }));
}

app.get(
  '/api/accounts',
  asyncRoute(async (req, res) => {
    res.json(await accountsFor(req.user, { fresh: true }));
  })
);

// Owner: give an account to someone on the team (they then post to it and see
// its analytics; it disappears from everyone else's list except the owner's).
app.put(
  '/api/accounts/:id/owner',
  requireOwner,
  asyncRoute(async (req, res) => {
    const user = getUser(req.body?.userId);
    if (!user) return res.status(400).json({ error: 'Choose someone on your team.' });
    const accounts = await loadAccounts();
    if (!accounts.some((a) => a.id === req.params.id)) return res.status(404).json({ error: 'Account not found.' });
    assignAccount(req.params.id, user.id);
    res.json(await accountsFor(req.user));
  })
);

// Rejects accounts this person may not use (members: only their own).
async function requireAccount(req, res, id) {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account || !canUseAccount(req.user, id)) {
    res.status(404).json({ error: 'Account not found.' });
    return null;
  }
  return account;
}

// Remember who is connecting which network, so the new account becomes theirs.
async function startConnect(req, provider) {
  const all = await loadAccounts({ fresh: true });
  recordPendingConnect(
    req.user.id,
    provider,
    all.map((a) => a.id)
  );
}

function connectableEntry(provider, res) {
  const entry = platformCatalog(process.env).find((p) => p.identifier === provider);
  if (!entry || entry.connect !== 'oauth') {
    res.status(400).json({ error: 'Unknown network.' });
    return null;
  }
  if (!entry.configured) {
    res.status(400).json({ error: `${entry.name} isn't set up yet — click "Set up" next to it first.` });
    return null;
  }
  return entry;
}

// `another: true` makes the network ask which account to use (or to log in),
// instead of silently reusing the account the browser is already logged in to.
app.post(
  '/api/accounts/connect',
  asyncRoute(async (req, res) => {
    const provider = req.body?.provider;
    if (!connectableEntry(provider, res)) return;
    await startConnect(req, provider);
    const url = await postiz.connectUrl(provider);
    res.json({ url: req.body?.another ? withAccountChooser(provider, url) : url });
  })
);

// A sign-in link to send to someone else (or open on your phone). Whoever
// opens it and approves adds their account here. Valid for one hour.
app.post(
  '/api/accounts/connect-link',
  asyncRoute(async (req, res) => {
    const provider = req.body?.provider;
    if (!connectableEntry(provider, res)) return;
    await startConnect(req, provider);
    const url = withAccountChooser(provider, await postiz.connectUrl(provider));
    res.json({ url, expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString() });
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
    await startConnect(req, 'bluesky');
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
    // Fetch now so the new account is attributed while the connect is fresh.
    await loadAccounts({ fresh: true });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/accounts/:id',
  asyncRoute(async (req, res) => {
    if (!(await requireAccount(req, res, req.params.id))) return;
    await postiz.deleteIntegration(req.params.id);
    maxLengthCache.delete(req.params.id);
    forgetAccount(req.params.id);
    forgetAccounts();
    res.json({ ok: true });
  })
);

app.get(
  '/api/accounts/:id/boards',
  asyncRoute(async (req, res) => {
    if (!(await requireAccount(req, res, req.params.id))) return;
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
    const accounts = await accountsFor(req.user);
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

    const accounts = await accountsFor(req.user);
    const chosen = accountIds.map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
    if (chosen.length !== accountIds.length) {
      return res.status(400).json({ error: 'Some accounts no longer exist — refresh the page.' });
    }

    const prefs = getSettings().preferences;
    const input = { caption, title, captions, media, mediaName: media?.name, scheduleAt: schedule.value };
    const items = await Promise.all(chosen.map((account) => sendToAccount(account, input, prefs)));

    const batch = createBatch({
      userId: req.user.id,
      caption,
      title,
      captions,
      media,
      scheduleAt: schedule.value,
      items,
    });
    // Start following its numbers for Analytics.
    runAnalytics().catch(() => {});
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
  const names = userNames();
  const ownerId = ownerUser().id;
  return batches.map((b) => {
    const withLive = withStatus(b, byId, notifications);
    const by = batchOwner(b, ownerId);
    return { ...withLive, userId: by, userName: names.get(by) ?? 'Removed person' };
  });
}

// Members see what they posted; the owner sees everyone's posts.
function batchFor(req, res) {
  const batch = getBatch(req.params.id);
  if (!batch || (!isOwner(req) && batchOwner(batch, ownerUser().id) !== req.user.id)) {
    res.status(404).json({ error: 'Not found.' });
    return null;
  }
  return batch;
}

app.get(
  '/api/batches',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const filter = isOwner(req)
      ? { userId: typeof req.query.user === 'string' && req.query.user ? req.query.user : null }
      : { userId: req.user.id };
    res.json(await liveStatus(listBatches(limit, { ...filter, ownerId: ownerUser().id })));
  })
);

app.get(
  '/api/batches/:id',
  asyncRoute(async (req, res) => {
    const batch = batchFor(req, res);
    if (!batch) return;
    const [withLive] = await liveStatus([batch]);
    res.json(withLive);
  })
);

// Two retries of the same post at once (double click, two tabs) would post twice.
const retrying = new Set();

app.post(
  '/api/batches/:id/retry',
  asyncRoute(async (req, res) => {
    const batch = batchFor(req, res);
    if (!batch) return;
    if (retrying.has(batch.id)) return res.status(409).json({ error: 'Already retrying this post.' });
    retrying.add(batch.id);
    try {
      await retryBatch(req, batch, res);
    } finally {
      retrying.delete(batch.id);
    }
  })
);

async function retryBatch(req, batch, res) {
  const [current] = await liveStatus([batch]);
  const failed = current.items.filter((i) => i.state === 'failed');
  if (failed.length === 0) return res.json(current);

  const accounts = await accountsFor(req.user);
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
  runAnalytics().catch(() => {});
  res.json(updated);
}

app.delete(
  '/api/batches/:id',
  asyncRoute(async (req, res) => {
    const batch = batchFor(req, res);
    if (!batch) return;
    await Promise.all(
      batch.items.filter((i) => i.postId).map((i) => postiz.deletePost(i.postId).catch(() => {}))
    );
    removeBatch(batch.id);
    res.json({ ok: true });
  })
);

// ---- Analytics ----

const PERIODS = new Set([7, 30, 90]);
const periodOf = (req) => (PERIODS.has(Number(req.query.days)) ? Number(req.query.days) : 30);

// Members: their own accounts. Owner: everyone's, or one person's (?member=id).
async function analyticsAccounts(req) {
  const accounts = await accountsFor(req.user);
  const member = typeof req.query.member === 'string' ? req.query.member : '';
  return isOwner(req) && member ? accounts.filter((a) => a.ownerId === member) : accounts;
}

app.get(
  '/api/analytics',
  asyncRoute(async (req, res) => {
    res.json(overview({ accounts: await analyticsAccounts(req), days: periodOf(req), ownerNames: userNames() }));
  })
);

app.get(
  '/api/analytics/videos/:postId',
  asyncRoute(async (req, res) => {
    const detail = videoDetail(req.params.postId, { accounts: await accountsFor(req.user) });
    if (!detail) return res.status(404).json({ error: 'Not found.' });
    res.json(detail);
  })
);

// "Refresh now": fetch fresh numbers for these accounts (at most once a
// minute per person), wait up to ~25 s for them, then answer.
const lastRefresh = new Map();
app.post(
  '/api/analytics/refresh',
  asyncRoute(async (req, res) => {
    const accounts = await analyticsAccounts(req);
    if (Date.now() - (lastRefresh.get(req.user.id) ?? 0) > 60_000) {
      lastRefresh.set(req.user.id, Date.now());
      markDue(accounts.map((a) => a.id));
    }
    const all = await loadAccounts();
    await Promise.race([runAnalytics({ accounts: all }), new Promise((r) => setTimeout(r, 25_000))]).catch(() => {});
    res.json(overview({ accounts, days: periodOf(req), ownerNames: userNames() }));
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
  console.log(`${BRAND_NAME} dashboard on http://localhost:${PORT} (Postiz: ${POSTIZ_PUBLIC_URL})`);
  startAutoSetup();
  if (process.env.ANALYTICS_LOOP !== 'off') startAnalyticsLoop();
});
