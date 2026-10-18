# <img src="web-src/public/icon.svg" width="40" alt="" align="top"> Fifofarm Ultimate

Fifofarm, Reel Finder and an AI video studio in **one app**, with a **separate space for every
model** you run. Pick **Mia** at the top and every tool shows only Mia's things: her accounts,
her posts and numbers, her Reel Finder searches and finds, her AI videos and her folders. Pick
**Mike** and you get Mike's.

The top bar is one button per **system**; clicking a system rolls down its pages.

| System | Rolls down to | What it does |
| --- | --- | --- |
| **Post** | New post · Accounts · History · Analytics | Fifofarm: post one video to all of the model's accounts at once, see how each post went and how the videos do. |
| **Reel Finder** | Find videos · Library | AI agents scroll TikTok, Instagram and Pinterest for videos that look like the model's reference videos and save the best ones. |
| **AI Studio** | Make a video · Library · Spending | Makes videos (**Wan**, **Seedance**) and images (**Seedream**) of the model — each model on its own provider + key. The price is automatic, and Spending tracks what each model has spent. |
| **Editing** | Editor | Turn a clip into a ready reel — trim, crop to shape, add music and captions — free, on your Mac with ffmpeg. |
| **Metadata** | Clean up | Strip the hidden data files carry (camera, GPS, dates, AI/edit tags) before posting. |
| **Settings** | — | Models and their folders, each model's AI Studio provider + key, the posting engine, posting defaults. |

The tools hand work to each other: a Reel Finder find goes to **Post**, **AI Studio** or the
**Editor** with one click, an AI Studio video goes to **Post** or the **Editor**, and anything in
the library can be posted, edited, sent to AI Studio or used as a Reel Finder reference.

**Fifofarm and the Reel Finder app stay exactly as they are.** This is a separate app with its
own data. It posts through the same posting engine (Postiz) your Fifofarm server runs, so
accounts you connected in Fifofarm show up here too, and you choose which model each one
belongs to. Nothing in Fifofarm changes when you do.

---

## Install it (Mac): one line

1. Open **Terminal**: press ⌘ Space, type `Terminal`, and press Enter.
2. Paste this line and press Enter:

   ```
   curl -fsSL https://raw.githubusercontent.com/fifohudak-boop/AI-models/main/ultimate/install.sh | bash
   ```

The first time takes a few minutes. It installs:

- **Fifofarm Ultimate itself:** in `~/Applications/Fifofarm Ultimate`.
- **A Fifofarm Ultimate app:** in Launchpad and Spotlight, with a shortcut on your Desktop.
- **Python and the packages:** through [uv](https://github.com/astral-sh/uv).
- **A browser for Reel Finder's agents:** your Google Chrome if you have it, otherwise a private Chromium.
- **The free local AI for Reel Finder:** [Ollama](https://ollama.com) and its model. If you
  already use the Reel Finder app, it's the same Ollama and nothing is downloaded again.
- **Look-matching** (about 600 MB), copied from the Reel Finder app when it already has it.

Then the page opens at **http://127.0.0.1:8790**. A Terminal window stays open while the app
runs; closing it quits the app. By default it runs on your Mac only — other computers can't open
it. To let certain people in, see **Share it with your team** below; that's the only way anyone
else reaches it.

**Next time,** just open the **Fifofarm Ultimate** app. **Updates are automatic:** each time you
open the app it installs a newer version if there is one, keeping your models, settings, logins
and history (never while a hunt is running or a video is being prepared).

**To uninstall,** delete the `Fifofarm Ultimate` folder and app in `~/Applications` and the
Desktop shortcut. Your videos stay in their folders.

---

## First start

1. **Create your first model** (e.g. *Mia*). Add more any time from the switcher at the top.
2. **Connect the posting engine** (the Post tab asks for it): the address of your Postiz
   (`https://postiz.<your domain>`) and either its **API key** (Postiz → Settings → Public API)
   or the **Postiz login** (Fifofarm → Settings → Posting engine → *Show the Postiz login*).
3. **Give each model its accounts** (Accounts tab). Accounts already in your posting engine are
   listed under *Other accounts* — click **Add to Mia**. New ones: **Connect** (or **Send link**
   to whoever owns the account); they land in the model you're on. A network needs its one-time
   setup in Fifofarm first (Fifofarm → Accounts → Set up), because both apps share the engine.
4. **Connect the model's folders** (Settings → Models): **References** (your reference videos
   and pictures) and **Model photos** (photos AI Studio uses to keep the face and look). *Found
   videos* and *AI Studio* are made for you under `~/Movies/Fifofarm Ultimate/<model>`; change
   them to any folder you like.
5. **Reel Finder:** log in to TikTok / Instagram / Pinterest once in the agents' browser (or
   click **Copy logins from Reel Finder**). The logins are shared by all models; one
   hunt runs at a time.
6. **AI Studio:** each model picks **its own provider and key** in Settings → Models → a model →
   **AI Studio key**, so every model can be a separate paid account. Choose the provider — Alibaba
   **Wan** or ByteDance **Seedance** for video, ByteDance **Seedream** for images — paste that
   account's API key and pick its region. Wan also needs the **workspace ID** (Wan is served only on
   your workspace's own address `{workspace}.{region}.maas.aliyuncs.com`); ByteDance providers need
   only the key and region. During Wan's preview the safe region is **Singapore**. **Prices are
   automatic** — worked out from each provider's published rates, so you never type a price.

## Where things are kept

- Your videos: in each model's folders (you choose them).
- The app's own data (models, settings, history, Reel Finder logins): `~/Applications/Fifofarm Ultimate/data`.
  The posting engine's API key and the Alibaba key are stored there, readable only by you.

## AI Studio: providers and automatic pricing

AI Studio makes videos and images of a model. Each model picks a **provider** in its key:

| Provider | Makes | Needs | Modes |
| --- | --- | --- | --- |
| **Alibaba Wan** (`wan3.0-video`, `wan3.0-video-prime`) | video | key + region + **workspace ID** | prompt · first-frame photo · reference video |
| **ByteDance Seedance** (`seedance-1.0-pro`, `-lite`) | video | key + region | prompt · first-frame photo |
| **ByteDance Seedream** (`seedream-4.0`, `-3.0`) | images | key + region | prompt · from a photo |
| **WaveSpeed** (Seedance 2.5, +Turbo) | video | key only | prompt · first-frame photo |

- **Wan** uploads prepared files to Alibaba's temporary storage (48 h) and polls the task; a
  reference video is cut to **15 s total** and photos become JPEGs (240–4096 px). Length can be
  **Auto** or 2–30 s (with a reference, in + out ≤ 30 s).
- **Seedance** (ByteDance ModelArk) sends the prompt and an optional first-frame photo inline and
  polls the task; length 4–15 s. A local reference *video* can't be sent to ByteDance, so that mode
  is Wan-only.
- **Seedream** (ByteDance ModelArk) returns the image right away; pick a size (1K/2K/4K) and shape.

**Prices are automatic** — AI Studio shows the price before you press Generate and on the
**Spending** page, worked out from each provider's published rates (nobody types a price):

- Wan: per second, by **region** (Singapore is a higher rail than Frankfurt/US/Tokyo/Beijing/HK) and
  resolution.
- Seedance: from the token formula (`width·height·24·seconds/1024` × the model's $/1M-token rate),
  which reproduces ByteDance's own per-clip prices.
- Seedream: a flat per-image rate.
- WaveSpeed (Seedance 2.5): per second by resolution (480p $0.18/s, 720p $0.36/s; 1080p is an
  estimate). WaveSpeed is an aggregator reached with one key (`POST /api/v3/{model}` → poll
  `/predictions/{id}/result`); it shows the exact price before you submit, so treat ours as an
  estimate.

Only finished generations are counted on the Spending page, because the providers bill on success.
Rates are built in (checked Oct 2026) and can drift — treat the shown price as an estimate.

## Editing

The **Editor** turns a clip into a ready reel, all on your Mac with ffmpeg (free, no account). You
see the reel as you build it — the shape, the captions and the cut are shown on a live preview
before anything is rendered:

- **Trim** on a filmstrip bar, iPhone-style: drag the yellow handles in from each end, and the
  preview jumps to the exact frame you're cutting on. Tap the frame to play just the part you kept.
- **Shape** it to 9:16, 4:5, 1:1, 16:9 or keep the original — either **Fill** (crop the edges) or
  **Fit** (the whole frame on a blurred background). **Mirror** (flip left–right) and change the
  **speed** (0.5×–2×) too.
- **Captions** you see as you type: pick the position, the size, a style (outline, chip or soft
  shadow) and a colour.
- **Music** you add (volume, keep or drop the clip's own sound) and a fade in/out.

The finished reel lands in the model's *Edited reels* folder, ready to post. Use music you have the
rights to.

## Metadata

Photos and videos carry hidden data — the camera or app that made them, GPS location, dates, and
AI/edit tags. **Metadata → Clean up** lists a model's files, flags what each one still carries,
and strips it in place (videos are re-wrapped without re-encoding; images are re-saved clean).
This only *removes* metadata — the normal step before posting. It never writes fake camera or
"shot on" information into a file.

---

## Share it with your team

By default only your Mac can open Fifofarm Ultimate. **Sharing** lets specific people open the
same live dashboard from their own computer — in a browser, nothing to install — and you choose
which models each one sees. Because everyone is looking at the one app on your Mac, they see your
changes as you make them, and there's nothing to sync.

**On your Mac you're always the owner** and never log in. Other people sign in with a username and
password you give them, and on the models you give them they can do everything (post, generate,
edit) — but the keys, models, prices, the list of people and these settings stay yours.

It works in two steps: a **tunnel** gives your Mac a web address over HTTPS, and then you turn on
**Sharing** in the app and point it at that address. Your Mac has to be on and the app running for
anyone to get in; the login is always in front.

### 1. Give your Mac a web address (pick one, set up once)

**Tailscale Funnel — easiest, no domain needed (recommended).** Gives a fixed `https://…ts.net`
address, free.

1. Install Tailscale: `brew install tailscale` (or from [tailscale.com/download](https://tailscale.com/download)) and sign in once with `tailscale up`.
2. In the [Tailscale admin console](https://login.tailscale.com/admin), turn **Funnel** on for your tailnet (Settings → Feature previews / ACLs).
3. Run the helper: `bash ~/Applications/"Fifofarm Ultimate"/share.sh` — it exposes the app and prints your address (looks like `your-mac.tailXXXX.ts.net`).

**Cloudflare Tunnel — if you'd rather use your own domain.** Needs a domain whose DNS is on
Cloudflare (free plan is fine).

1. `brew install cloudflared`, then `cloudflared tunnel login` (opens the browser — pick your domain).
2. `cloudflared tunnel create fifofarm-ultimate`
3. `cloudflared tunnel route dns fifofarm-ultimate ultimate.yourdomain.com`
4. Add an ingress rule so `ultimate.yourdomain.com` → `http://localhost:8790` in `~/.cloudflared/config.yml`, then `cloudflared tunnel run fifofarm-ultimate` (or `sudo cloudflared service install` to keep it running).

Either way you end up with one web address that points at your Mac's app.

### 2. Turn Sharing on and invite people

1. In the app, open **Settings → Sharing**, paste that web address (e.g. `your-mac.tailXXXX.ts.net` or `ultimate.yourdomain.com`), and **Turn sharing on**.
2. In **Settings → People**, add a person: their name, a username, a password (there's a *Generate* button), and tick the models they're allowed to use.
3. Send them the web address plus their username and password. They open it, sign in, and see only their models.

Change who can use which model, reset a password, or remove someone any time in **People**. Turn
the whole thing off with one switch in **Sharing** — then it's back to your-Mac-only.

> **Keep in mind:** sharing hands people real control of those models — posting to the connected
> accounts and generating AI videos (which spends your AI Studio credit). Give each person only the
> models they should run. Only ever share the address with people you trust; the login is the only
> thing between the internet and your models.

---

## For developers

```
cd ultimate
uv venv --python 3.12 .venv && uv pip install -r requirements.txt -r requirements-similarity.txt
.venv/bin/python -m pytest              # backend, posting, Reel Finder engine and installer tests
.venv/bin/python -m hub                 # runs at http://127.0.0.1:8790

cd web-src && npm install && npm run build   # rebuilds the page into ../web (committed)
npm run dev                                  # live page on :5173, talking to the app on :8790
```

- `hub/` — the app (FastAPI). `hub/reels/` is a copy of Reel Finder's engine; the Reel Finder
  app in `../reel-finder` is separate and unchanged.
- `web-src/` — the page (React + Vite), started from Fifofarm's dashboard so it looks the same.
- Environment overrides: `ULTIMATE_DATA` (data folder), `ULTIMATE_PORT` (default 8790),
  `ULTIMATE_MEDIA_ROOT` (default `~/Movies/Fifofarm Ultimate`).
