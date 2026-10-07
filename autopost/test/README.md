# Tests

## End-to-end (`run-e2e.sh`)

This runs the real stack (dashboard, Postiz, Temporal, Postgres, Redis,
watchdog) plus `mock-mastodon.mjs`, a small fake Mastodon server. A real
Chromium then drives the dashboard the way you would:

1. Sign in (a wrong password is rejected first).
2. One-time setup with the Postiz API key (a bad key is rejected first).
3. Connect an account through the real OAuth flow:
   dashboard → Postiz → "Mastodon" sign-in page → back to Postiz.
4. Upload an iPhone-style video (HDR, HEVC 10-bit, vertical, `.mov`) and post it
   with a tricky caption (`&`, `<`, quotes, emoji, two lines) in one click.
   Wait for "Published".
5. Check what Mastodon received:
   - the video is an MP4
   - the caption is exactly what was typed
   - the post links to the uploaded video
6. A post that Mastodon rejects shows the real reason. **Retry failed** then
   publishes it.
7. Schedule a post, see it in History, delete it before it goes out.

Requirements:
- Docker, Node 20+, ffmpeg (to make the test video)
- this line in `/etc/hosts`, so the browser can reach the fake Mastodon:
  ```
  127.0.0.1 mock-mastodon
  ```
- a local-mode `.env` (`./install.sh`, option 1). The test setup supplies
  the fake Mastodon's keys itself.

**Warning: the script wipes this checkout's Fifofarm data** (`docker compose
down -v`). Don't run it on your real install.

```sh
test/run-e2e.sh
```

Screenshots of every step land in `test/artifacts/`.

## Outage / watchdog (`watchdog.mjs`)

Run this after `run-e2e.sh`. It:
1. freezes Postiz's background worker, which is the silent failure seen in
   real Postiz installs
2. posts during the outage
3. checks that:
   - the dashboard notices the outage
   - the watchdog restarts Postiz
   - the queued post then publishes by itself

It takes about 5–8 minutes.

```sh
cd test && DASHBOARD_PASSWORD=... node watchdog.mjs
```
