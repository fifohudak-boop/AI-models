# Calendar

A month-view calendar with an agenda panel, event categories, and conflict
detection, backed by a small shared server so every device sees the same
events.

## Deploy it (Render + Turso) — the "always on" setup

This is the recommended setup: one public HTTPS URL, reachable from any
device on any network (WiFi or cellular), that updates itself every time a
fix or feature is pushed to `main`.

### 1. Create a free database (Turso)

1. Go to [turso.tech](https://turso.tech) and sign up (GitHub login is
   fastest).
2. Create a database (any name, e.g. `calendar`).
3. On the database's page, get:
   - The **database URL** (starts with `libsql://…`)
   - An **auth token** (there's a "Create token" button)

Keep both handy for step 3.

### 2. Create a Render account and connect this repo

1. Go to [render.com](https://render.com) and sign up (GitHub login again is
   easiest — it can then see your repos).
2. **New +** → **Blueprint**, pick this GitHub repo. Render reads
   `render.yaml` in this repo and sets up the web service automatically
   (build command, start command, health check).
3. It'll ask for the env vars marked `sync: false` in `render.yaml` — enter:
   - `TURSO_DATABASE_URL` — the URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1
   - `APP_PASSWORD` — **make one up.** Without this, anyone who finds your
     URL can read and edit your calendar. With it, the browser just asks
     for a username (anything) and this password once.
4. Deploy. Render gives you a URL like `https://calendar-app-xxxx.onrender.com`.

That URL works from anywhere — phone on cellular, laptop, anything. Open it
on your phone and **Add to Home Screen** (Safari share button, or Chrome's
menu) to get a real app icon.

### It updates itself from here on

Render is now watching `main`. Every time a fix or new feature gets pushed
to `main` — including from this chat — Render automatically rebuilds and
redeploys within a minute or two. Nothing to run by hand. You can watch it
happen in the Render dashboard's "Events" tab.

Your events live in the Turso database, not on Render, so they survive every
redeploy indefinitely.

## Run it locally instead (e.g. on your Mac)

```sh
npm install
npm start
```

Without `TURSO_DATABASE_URL` set, the server automatically falls back to a
local SQLite file (`server/data/local.db`) — no account needed. Open
**http://localhost:3001**.

(For frontend development with hot reload, run `npm run server` in one
terminal and `npm run dev` in another — Vite proxies `/api` to the server.)

To reach a locally-running copy from your phone, either use your Mac's LAN
IP while on the same WiFi, or install [Tailscale](https://tailscale.com/) on
both devices for access from anywhere without deploying. The deployed
version above makes this unnecessary, but it's there if you'd rather not
deploy.

## What's in here

- `src/` — the React + TypeScript frontend (Vite)
- `server/` — the Express backend: `/api/events` and `/api/categories`,
  backed by `server/store.js` (libSQL — a local file in dev, Turso in
  production, same code either way)
- `public/` — PWA manifest and home-screen icons
- `render.yaml` — the Render blueprint used in step 2 above

`npm run lint` and `npm run build` (which type-checks via `tsc -b`) should
both stay clean.
