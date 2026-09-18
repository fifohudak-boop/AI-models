# Calendar

A month-view calendar with an agenda panel, event categories, conflict
detection, and a small shared backend so your Mac and your phone see the
same events.

## Run it on your Mac

```sh
npm install
npm start
```

`npm start` builds the app and starts one server (Express) that serves the
frontend **and** the API on a single port. Open **http://localhost:3001**.

Events are stored in `server/data/events.json` on the Mac — that file is the
one shared calendar both devices read and write.

(For day-to-day frontend development with hot reload instead, run
`npm run server` in one terminal and `npm run dev` in another — Vite proxies
`/api` to the server, both on the same data file.)

## Use it from your phone

The app is a normal web page — your phone just needs to reach the address
above instead of `localhost`. Two ways to do that:

### Option A — same WiFi as your Mac

1. Find your Mac's local IP: **System Settings → Wi-Fi → Details** (or run
   `ipconfig getifaddr en0` in Terminal). It looks like `192.168.1.23`.
2. On your phone (same WiFi), open `http://192.168.1.23:3001`.

This only works while both devices are on the same network.

### Option B — from anywhere (cellular data too)

For that you need your Mac reachable from outside your home network. The
simplest, free way is **[Tailscale](https://tailscale.com/)** — a private
network between your own devices, so nothing is exposed to the public
internet:

1. Install Tailscale on your Mac and sign in (free for personal use).
2. Install the Tailscale app on your phone and sign in with the **same
   account**.
3. On the Mac, run `tailscale ip -4` to get its Tailscale address (something
   like `100.x.y.z`), or just use the MagicDNS name Tailscale shows you
   (e.g. `your-mac-name.your-tailnet.ts.net`).
4. On your phone — on WiFi or cellular, doesn't matter — open
   `http://<that address>:3001`. It'll work exactly like being on the same
   WiFi, from anywhere.

Keep `npm start` running on the Mac (it needs to stay on and awake — in
System Settings, disable sleep, or use `caffeinate npm start` in Terminal so
the Mac won't nap while it's your calendar's server).

## Install it on your phone's home screen

Open the app's URL in Safari (iOS) or Chrome (Android), then:

- **iOS**: Share button → **Add to Home Screen**
- **Android**: menu (⋮) → **Add to Home screen** / **Install app**

It'll get its own icon and open full-screen, like a real app — full control
(add, edit, delete, color-code events), same shared data as the Mac.

## What's in here

- `src/` — the React + TypeScript frontend (Vite)
- `server/` — the Express backend: a handful of REST endpoints
  (`/api/events`, `/api/categories`) backed by `server/data/events.json`
- `public/` — PWA manifest and home-screen icons

`npm run lint` and `npm run build` (which type-checks via `tsc -b`) should
both stay clean.
