# AutoPost — one video, all your accounts, one click

Drop a video into a simple web dashboard, write one caption, press **Post**.
It goes out to every account you've connected: YouTube, TikTok, Instagram,
Facebook, Threads, X, LinkedIn, Pinterest, Bluesky, Mastodon, as many
accounts per network as you like. Post now or schedule it, and watch each
account turn green as it publishes.

Everything is open source and self-hosted. There are no subscriptions and no
post limits. The only costs are a server (free or ~€5.50/month, see
[docs/hosting.md](docs/hosting.md)) and X's per-post API fee if you use X.

![Post page](docs/screenshots/post.png)

## How it works

```
 you ──► AutoPost dashboard ──► Postiz ──► YouTube, TikTok, Instagram, …
         (this folder)          (engine)
```

- **AutoPost dashboard** (`dashboard/`) is the simple control panel you use.
  It:
  - converts any video (iPhone `.mov`, 4K, HEVC, 10-bit…) into a file every
    network accepts
  - fills in each network's required settings for you
  - shortens captions that are too long for a network (X's 280 characters)
  - posts to every selected account in one click
  - shows live per-account status, with "Retry failed" when something goes
    wrong
- **[Postiz](https://github.com/gitroomhq/postiz-app)** (open source, 36k★)
  is the engine. It does the actual talking to each network: sign-in (OAuth),
  token refresh, uploads, retries, and checking that the post went live. It
  runs on [Temporal](https://temporal.io), a job system that keeps scheduled
  posts safe across restarts.
- **Watchdog**: Postiz has a known bug where its background worker silently
  stops picking up posts. AutoPost checks for exactly that and restarts Postiz
  automatically. Anything queued meanwhile still goes out.

## Quick start

**On a Mac with Claude Cowork?** Follow
**[docs/mac-with-cowork.md](docs/mac-with-cowork.md)**: you install Docker,
and Cowork does the rest.

You need [Docker](https://docs.docker.com/get-docker/).

```sh
cd autopost
./install.sh
```

The installer asks two questions:
- your computer or a server
- a dashboard password

It then generates all other secrets and starts everything. Then, once:

1. Open the Postiz address it prints and **create your account**. Only the
   first sign-up is allowed; registration is locked after that.
2. In Postiz: **Settings → Developers** → copy the **API key**.
3. Open the dashboard (http://localhost:3000, or your domain), sign in, and
   paste the key.
4. For each network you want, create its free developer app and put its two
   keys in `.env`. Step-by-step for every network:
   **[docs/connect-platforms.md](docs/connect-platforms.md)**. Then run
   `docker compose up -d`.
5. On the dashboard's **Accounts** page, click **Connect** for each account.

From then on: **Post** page → drop video → caption → **Post to N accounts**.

## Your own computer vs. a server

| | Your computer | Server with a domain |
|---|---|---|
| Cost | €0 | €0 (Oracle free tier) or ~€5.50/month |
| YouTube, X, LinkedIn, Bluesky, Mastodon | ✓ | ✓ |
| TikTok, Instagram, Facebook, Threads, Pinterest | ✗ (they need a public https address) | ✓ |
| Scheduled posts while you sleep | only if the computer stays on | ✓ |

Server setup, including the free option and a free domain:
**[docs/hosting.md](docs/hosting.md)**.

## Things the networks require (no tool can skip these)

- **TikTok:** until TikTok approves your developer app, posts are "Only me" and
  your account must be private. Approval is free; you submit the app for
  review.
- **YouTube:** until Google approves your API project (a free form), uploads
  arrive as **private**. Also publish your Google OAuth app ("In production"),
  or YouTube disconnects every 7 days.
- **Instagram:** only Professional (Business/Creator) accounts can be posted
  to by apps. Switching is free.
- **Facebook:** switch your Meta app to **Live**, or posts are only visible to
  you.
- **X:** posting via the API costs about $0.015 per post, prepaid.

The dashboard warns you about these and about per-network limits (e.g. X
accepts videos up to 2:20).

## Everyday use

- **Post:** drop a video (or a photo), write the caption, untick any accounts
  you want to skip, then post now or schedule.
  - "Different caption for some accounts…" lets you write e.g. a shorter X
    version.
- **History:** every post with each account's status and a link to the live
  post. **Retry failed** re-sends only to the accounts that failed.
  **Delete** cancels anything not yet published.
- **Accounts:** connect and disconnect accounts, and choose a board for
  Pinterest.
- **Settings:** YouTube visibility, TikTok privacy and interactions, who can
  reply on X, automatic caption shortening.

## Running it

```sh
docker compose ps             # is everything up? (postiz shows "healthy" when posting works)
docker compose logs -f dashboard postiz watchdog
docker compose restart        # restart everything
docker compose down           # stop (your data stays)
```

**Updating:** `git pull && docker compose up -d --build`. Postiz is pinned to
the version the dashboard was tested with (`POSTIZ_VERSION` in `.env`).
Change it only on purpose, and check the dashboard still posts afterwards.

**Backups:** everything lives in Docker volumes. To back up the database:

```sh
docker compose exec -T postgres pg_dumpall -U postiz > backup.sql
```

Your uploaded media is in the `autopost_postiz-uploads` volume.

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says "Starting up…" | Postiz takes 1–3 minutes after a start. Wait, then click *Try again*. |
| Yellow banner "posting engine isn't picking up posts" | The watchdog restarts Postiz within ~5 minutes; queued posts go out after. If it stays, run `docker compose restart postiz`. |
| A network isn't in the Connect list | Its keys aren't in `.env` yet, or you didn't run `docker compose up -d` after adding them. |
| Sign-in window shows "redirect_uri mismatch" | The redirect URI in the network's developer app must be exactly `POSTIZ_URL/integrations/social/<network>`. |
| TikTok fails with "privacy level" or "unaudited" | Settings → TikTok → *Only me*, and set your TikTok account to private, until TikTok approves your app. |
| YouTube videos are private | Expected until Google's API audit passes, see above. |
| An account fails with "reconnect" | Its login expired; click **Connect** for it again on the Accounts page. |

## What's in this folder

```
install.sh               one-command setup
docker-compose.yml       the whole stack
.env.example             every setting, explained
Caddyfile                automatic HTTPS (server mode)
postiz-healthcheck.js    "is Postiz really posting?" check used by the watchdog
dashboard/               the dashboard (Node + React)
docs/                    network setup, hosting, screenshots
test/                    end-to-end and outage tests (see test/README.md)
```

## Tests

- **Unit tests:** `cd dashboard && npm test`
- **End-to-end:** `test/run-e2e.sh`. It starts the real stack plus a fake
  Mastodon server, drives the dashboard in a real browser, and checks what
  "Mastodon" received:
  - signs in and saves the API key
  - connects an account through real OAuth
  - posts an iPhone-style HEVC `.mov` in one click
  - checks the caption arrives byte-exact
  - shows a real failure reason, then retries it
  - schedules and cancels a post
- **Outage test:** `test/watchdog.mjs` freezes Postiz's worker, posts during
  the outage, and checks the watchdog recovers and the post goes out by
  itself.

Details in [test/README.md](test/README.md).
