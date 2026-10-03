// Thin client for the Postiz public API (docs.postiz.com/public-api).
import fs from 'node:fs';
import path from 'node:path';
import { POSTIZ_INTERNAL_URL, TEMPORAL_HTTP_URL, getApiKey } from './config.js';

export class PostizError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function messageFrom(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 500) || fallback;
  if (body.provider && body.error) return body.error;
  const msg = body.msg ?? body.message ?? body.error;
  if (Array.isArray(msg)) return msg.join(', ');
  return typeof msg === 'string' && msg ? msg : fallback;
}

async function call(urlPath, { method = 'GET', json, form, apiKey, publicApi = true, timeoutMs = 60_000 } = {}) {
  const key = apiKey ?? getApiKey();
  const headers = {};
  if (publicApi) {
    if (!key) throw new PostizError('No Postiz API key saved yet.', 401);
    headers.Authorization = key;
  }
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  const url = `${POSTIZ_INTERNAL_URL}/api${publicApi ? '/public/v1' : ''}${urlPath}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
    throw new PostizError(`Can't reach Postiz (${reason}). Is it running?`, 503);
  }

  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep plain text
  }
  if (!res.ok) {
    const fallback = res.status === 401 ? 'Postiz rejected the API key.' : `Postiz returned HTTP ${res.status}.`;
    throw new PostizError(messageFrom(parsed, fallback), res.status, parsed);
  }
  return parsed;
}

// Postiz's own (non-public) API, used once on a fresh install to create the
// Postiz account automatically. Returns the parsed body and the auth token.
async function callInternal(urlPath, { method = 'GET', json, jwt, timeoutMs = 30_000 } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (jwt) {
    headers.auth = jwt;
    headers.Cookie = `auth=${jwt}`;
  }
  let res;
  try {
    res = await fetch(`${POSTIZ_INTERNAL_URL}/api${urlPath}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
    throw new PostizError(`Can't reach Postiz (${reason}). Is it running?`, 503);
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep plain text
  }
  if (!res.ok) throw new PostizError(messageFrom(parsed, `Postiz returned HTTP ${res.status}.`), res.status, parsed);
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const authCookie = cookies.map((c) => /^auth=([^;]+)/.exec(c)?.[1]).find(Boolean);
  return { body: parsed, jwt: res.headers.get('auth') || authCookie || null };
}

export const postiz = {
  async checkKey(apiKey) {
    return call('/is-connected', { apiKey });
  },

  // ---- First-run setup (no API key yet) ----

  async canRegister() {
    const { body } = await callInternal('/auth/can-register');
    return !!body?.register;
  },

  async register({ email, password, company }) {
    const { jwt } = await callInternal('/auth/register', {
      method: 'POST',
      json: { email, password, company, provider: 'LOCAL' },
    });
    if (!jwt) throw new PostizError('Postiz created the account but returned no login token.', 500);
    return jwt;
  },

  async publicApiKey(jwt) {
    const { body } = await callInternal('/user/self', { jwt });
    return typeof body?.publicApi === 'string' ? body.publicApi : '';
  },

  listIntegrations() {
    return call('/integrations');
  },

  async integrationMaxLength(id) {
    const res = await call(`/integration-settings/${encodeURIComponent(id)}`);
    return Number(res?.output?.maxLength) || 0;
  },

  async connectUrl(provider) {
    const res = await call(`/social/${encodeURIComponent(provider)}`);
    return res.url;
  },

  // Networks that log in with fields instead of OAuth (Bluesky): Postiz hands
  // out a state token, then its connect endpoint takes the fields base64-encoded.
  async connectWithFields(provider, fields) {
    const state = await this.connectUrl(provider);
    return call(`/integrations/social-connect/${encodeURIComponent(provider)}`, {
      method: 'POST',
      publicApi: false,
      json: {
        state,
        code: Buffer.from(JSON.stringify(fields)).toString('base64'),
        timezone: '0',
      },
    });
  },

  deleteIntegration(id) {
    return call(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async pinterestBoards(id) {
    const res = await call(`/integration-trigger/${encodeURIComponent(id)}`, {
      method: 'POST',
      json: { methodName: 'boards', data: {} },
    });
    return Array.isArray(res?.output) ? res.output : [];
  },

  async upload(filePath, mimeType) {
    const blob = await fs.openAsBlob(filePath, { type: mimeType });
    const form = new FormData();
    form.append('file', blob, path.basename(filePath));
    return call('/upload', { method: 'POST', form, timeoutMs: 30 * 60_000 });
  },

  createPost(body) {
    return call('/posts', { method: 'POST', json: body });
  },

  async listPosts(startDate, endDate) {
    const qs = new URLSearchParams({ startDate: startDate.toISOString(), endDate: endDate.toISOString() });
    const res = await call(`/posts?${qs}`);
    return res?.posts ?? [];
  },

  deletePost(id) {
    return call(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async notifications() {
    const res = await call('/notifications?page=0');
    return res?.notifications ?? (Array.isArray(res) ? res : []);
  },

  // Is Postiz's background worker actually picking up jobs? Postiz can look
  // healthy while its worker silently isn't running; Temporal knows the truth.
  async workerState() {
    if (!TEMPORAL_HTTP_URL) return 'unknown';
    try {
      const res = await fetch(
        `${TEMPORAL_HTTP_URL}/api/v1/namespaces/default/task-queues/main?taskQueueType=TASK_QUEUE_TYPE_WORKFLOW`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return 'unknown';
      const { pollers = [] } = await res.json();
      const newest = Math.max(0, ...pollers.map((p) => Date.parse(p.lastAccessTime) || 0));
      return Date.now() - newest < 150_000 ? 'ok' : 'down';
    } catch {
      return 'unknown';
    }
  },
};
