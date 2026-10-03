// A stand-in Mastodon server for the end-to-end test: it speaks just enough
// of Mastodon's OAuth + media + status API for Postiz to connect an account
// and publish to it, and records everything it receives at GET /__received.
// No dependencies; run with `node mock-mastodon.mjs`.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 4100;
const BASE = process.env.PUBLIC_URL || `http://mock-mastodon:${PORT}`;
const TOKEN = 'mock-access-token';

const received = { authorizations: 0, tokens: 0, media: [], statuses: [], rejected: [] };
const mediaChecks = new Map();
const failedOnce = new Set();

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return [];
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const chunk = body.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    const headers = chunk.subarray(0, headerEnd).toString();
    const data = chunk.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    parts.push({ name, filename, data });
    start = next;
  }
  return parts;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /oauth/authorize') {
    received.authorizations += 1;
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'mock-code');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Mock Mastodon</title>
      <h1>Mock Mastodon</h1><p>Allow <b>AutoPost</b> to post as @autopost_test?</p>
      <a id="authorize" href="${redirect.toString().replace(/"/g, '&quot;')}">Authorize</a>`);
    return;
  }

  if (route === 'POST /oauth/token') {
    const body = await readBody(req);
    const fields = Object.fromEntries(
      req.headers['content-type']?.includes('multipart')
        ? parseMultipart(body, req.headers['content-type']).map((p) => [p.name, p.data.toString()])
        : new URLSearchParams(body.toString())
    );
    if (fields.code !== 'mock-code') return json(res, 400, { error: 'invalid_grant' });
    received.tokens += 1;
    return json(res, 200, { access_token: TOKEN, token_type: 'Bearer', scope: 'write', created_at: Date.now() / 1000 });
  }

  if (route === 'GET /api/v1/accounts/verify_credentials') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, {
      id: '1001',
      username: 'autopost_test',
      acct: 'autopost_test',
      display_name: 'AutoPost Test',
      avatar: `${BASE}/avatar.png`,
    });
  }

  if (route === 'GET /avatar.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_1PX);
    return;
  }

  if (route === 'POST /api/v1/media' || route === 'POST /api/v2/media') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const file = parseMultipart(body, req.headers['content-type']).find((p) => p.name === 'file');
    if (!file) return json(res, 422, { error: 'file missing' });
    const id = `media-${received.media.length + 1}`;
    received.media.push({
      id,
      filename: file.filename,
      bytes: file.data.length,
      isMp4: file.data.subarray(4, 8).toString() === 'ftyp',
    });
    return json(res, 202, { id, type: 'video', url: null });
  }

  const mediaMatch = /^GET \/api\/v1\/media\/([\w-]+)$/.exec(route);
  if (mediaMatch) {
    const checks = (mediaChecks.get(mediaMatch[1]) ?? 0) + 1;
    mediaChecks.set(mediaMatch[1], checks);
    // Like real Mastodon: still processing on the first check.
    if (checks === 1) return json(res, 206, { id: mediaMatch[1], url: null });
    return json(res, 200, { id: mediaMatch[1], type: 'video', url: `${BASE}/media/${mediaMatch[1]}.mp4` });
  }

  if (route === 'POST /api/v1/statuses') {
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    const parts = parseMultipart(body, req.headers['content-type']);
    const status = parts.find((p) => p.name === 'status')?.data.toString() ?? '';
    const mediaIds = parts.filter((p) => p.name === 'media_ids[]').map((p) => p.data.toString());
    // "#failonce" lets the test exercise the failure → retry path: rejected
    // the first time (the way Mastodon rejects expired media), accepted after.
    if (status.includes('#failonce') && !failedOnce.has(status)) {
      failedOnce.add(status);
      received.rejected.push(status);
      return json(res, 422, { error: 'Validation failed: Media could not be found' });
    }
    const id = String(received.statuses.length + 1);
    received.statuses.push({ id, status, mediaIds, idempotencyKey: req.headers['idempotency-key'] ?? null });
    return json(res, 200, { id, url: `${BASE}/@autopost_test/${id}`, content: status });
  }

  if (route === 'GET /__received') return json(res, 200, received);

  json(res, 404, { error: `mock has no ${route}` });
});

server.listen(PORT, () => console.log(`mock mastodon on :${PORT} (${BASE})`));
