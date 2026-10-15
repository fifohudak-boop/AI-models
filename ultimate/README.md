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
| **AI Studio** | Make a video · Library · Spending | Makes new videos of the model with **Wan 3.0** (Alibaba Cloud Model Studio). Shows the cost before you Generate, and tracks how much each model has spent. |
| **Editing** | Editor | Turn a clip into a ready reel — trim, crop to shape, add music and captions — free, on your Mac with ffmpeg. |
| **Metadata** | Clean up | Strip the hidden data files carry (camera, GPS, dates, AI/edit tags) before posting. |
| **Settings** | — | Models and their folders, the posting engine, the AI Studio key and prices, posting defaults. |

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
runs; closing it quits the app. It runs on your Mac only: other computers can't open it.

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
6. **AI Studio:** paste your Alibaba Cloud **Model Studio** API key in Settings → AI Studio,
   choose the region the key was made in, and add your **workspace ID**. All three are
   required and must be from the same place — Wan 3.0 is served only on your workspace's own
   address (`{workspace}.{region}.maas.aliyuncs.com`), so without the workspace ID Alibaba
   has no endpoint for it. The workspace ID is in the Model Studio console (there's a link
   next to the field).

## Where things are kept

- Your videos: in each model's folders (you choose them).
- The app's own data (models, settings, history, Reel Finder logins): `~/Applications/Fifofarm Ultimate/data`.
  The posting engine's API key and the Alibaba key are stored there, readable only by you.

## AI Studio and Wan 3.0

AI Studio sends jobs to Alibaba Cloud Model Studio's Wan 3.0 video API (`wan3.0-video`, or
`wan3.0-video-prime`, the faster version): from a prompt, from a first frame (a photo of the
model), or from references (a reference video plus up to 10 model photos — Wan copies the
video's moves, camera and timing with the person in the photos).

- Before sending, reference videos become H.264 MP4s with **15 seconds in total** at most
  (Wan's limit; longer finds are cut), and photos become JPEGs between 240 and 4096 px.
- The files go to Alibaba's temporary upload storage (kept 48 hours), then the task is
  checked every 15 seconds. The finished video downloads into the model's *AI Studio* folder
  and shows up in the library, ready to post.
- *Length* can be **Auto** (Wan decides; with a reference, like the reference) or 2–30 s. With
  a reference video, its length plus the new video's is 30 s at most.
- **Cost:** AI Studio shows the price before you press Generate, from the per-second rates in
  Settings → AI Studio (seeded from Alibaba's list prices — edit them to match your own bill and
  discount). The **Spending** page shows how much each model has spent, by month and by quality.
  Only finished videos are counted, because Alibaba bills on success.

## Editing

The **Editor** turns a clip into a ready reel, all on your Mac with ffmpeg (free, no account):
trim it, crop it to a shape (9:16, 4:5, 1:1, 16:9 or keep original), add text captions, add your
own music (volume, keep or drop the clip's own sound) and a fade. The finished reel lands in the
model's *Edited reels* folder, ready to post. Use music you have the rights to.

## Metadata

Photos and videos carry hidden data — the camera or app that made them, GPS location, dates, and
AI/edit tags. **Metadata → Clean up** lists a model's files, flags what each one still carries,
and strips it in place (videos are re-wrapped without re-encoding; images are re-saved clean).
This only *removes* metadata — the normal step before posting. It never writes fake camera or
"shot on" information into a file.

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
