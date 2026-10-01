# 🎬 Reel Finder

Describe the short-form videos you need. Press **Start hunt**. AI agents scroll
**TikTok** and **Instagram Reels** at the same time, a local AI checks every video
against your description, and the matches download into the folder you choose.

Everything runs on your Mac: your logins, your videos and the AI never leave it.

---

## Start it (Mac)

1. **Get the files.** Clone this repo, or download it as a ZIP and unzip it.
2. **Double-click `reel-finder/start.command`.**
   - If macOS says it's from an unidentified developer, right-click it, choose **Open**,
     then **Open** again. You only need to do this once.
   - The first run sets everything up, which takes a few minutes:
     - Python and the packages, through [uv](https://github.com/astral-sh/uv)
     - a browser for the agents (it uses your Google Chrome if you have it)
     - the free local AI, [Ollama](https://ollama.com). If Ollama isn't installed, its
       download page opens. Install it, then double-click `start.command` again.
       The first time, it also downloads the AI model, which is a few GB.
3. The Reel Finder page opens in your browser at **http://127.0.0.1:8765**.
   Keep the Terminal window open while you use it; closing it quits Reel Finder.

Later starts take a few seconds.

## Use it

1. **Connect your accounts (once).** Click **Connect** next to TikTok and Instagram.
   A browser window opens: log in, then close the window. Instagram search doesn't work
   without logging in. A spare account is safest, because heavy scrolling can get an
   account rate-limited.
2. **Describe what you want** in plain words. For example:
   *"Cinematic slow-motion car drifts at night with smoke, no talking, filmed low to the ground."*
   You can also add:
   - must-use keywords or hashtags, such as `#cardrift`
   - words that mean a video should be skipped, such as `tutorial, giveaway`
3. **Pick a folder** with **Browse…**, set how many videos you want, and press **Start hunt**.

What happens next:

- **Plan:** the AI turns your description into several searches per platform, mixing
  keywords and hashtags.
- **Agents scroll:** each agent is its own browser window scrolling one search. When a
  search runs dry, the agent moves to the next one. With *Show the agents scrolling* on,
  the windows are tiled so you can watch them.
- **Quick filters:** videos that are too long or too short, have too few views or likes,
  are too old, or mention an excluded word are skipped without asking the AI.
- **AI judge:** the AI reads the caption and looks at the cover image, then scores the
  video from 0 to 100 with a one-line reason. Videos scoring at or above **How strict**
  are downloaded.
- **Watch-check (optional):** after downloading, the AI looks at 3 frames from the video
  itself and deletes it if the footage doesn't match.
- **The hunt stops** when it reaches your target, hits the time limit, runs out of
  searches, or you press **Stop hunt**.

Each hunt gets its own subfolder, for example `2026-10-01 18.41 Cinematic night car drifts`.
It contains:

- the videos, named `tiktok_<creator>_<id>.mp4` or `instagram_<creator>_<code>.mp4`
- `reelfinder-log.csv`, listing each video's link, caption, creator, views, likes,
  length, AI score, the AI's reason, and which search found it

Reel Finder remembers every video it has downloaded to a folder in
`.reelfinder-archive.txt`, so later hunts never download the same video twice.

### Settings

| Setting | What it does |
|---|---|
| Videos to download | The hunt stops once this many are saved. |
| Time limit | A hard stop, in case the searches go on forever. |
| AI agents | How many browser windows scroll at once (1–6). Instagram is capped at 3 so your account doesn't get flagged. |
| Min/Max length | In seconds. A max of 0 means no limit. |
| Min views / likes | Leave at 0 to ignore. Some Instagram posts hide their counts; those still pass. |
| Posted within | Only videos posted in the last N days. 0 means any time. |
| How strict | The AI score a video needs. 70 is a good default. Lower it if too few videos pass. |
| Model | Which Ollama model judges. Models marked "sees images" also look at the cover. |
| Watch-check | Slower but more exact: checks frames of the downloaded video itself. |
| Show the agents scrolling | Visible windows (recommended: TikTok trusts them more, and you can solve a captcha) or run hidden. |

## The AI models

Any Ollama model works. Models that can see images do much better, because they can
look at the cover image.

| Model | Download | Notes |
|---|---|---|
| `qwen3-vl:8b-instruct` (default) | ~6 GB | Best all-rounder; fine on Macs with 16 GB of memory. |
| `gemma3:4b` | ~3.3 GB | Faster, for 8 GB Macs. |
| any text-only model | — | Judges captions only. |

Use the **`-instruct`** versions of Qwen models. The plain `qwen3-vl:8b` tag, and
`-thinking` versions, reason at length before every answer, which makes judging very slow.
Reel Finder warns you if the model you picked does this.

Pick a model from the dropdown and press **Download** if it isn't installed. You can also
run `ollama pull <name>` in Terminal.

If Ollama isn't running, Reel Finder still works: it matches your words against the
captions instead of understanding them, and the top bar shows **AI off — keyword mode**.

## Troubleshooting

- **An agent card says "Needs you: captcha".** Solve the captcha in that agent's window
  and it carries on by itself. This is why visible mode is recommended.
- **"Needs you: log in" on Instagram.** Click **Connect** next to Instagram and log in.
- **No videos are found on a platform.** These sites change their pages often.
  `start.command` updates the downloader every time it starts, so quit and restart first.
  If one platform still finds nothing, untick it and keep using the other.
- **Downloads fail with "login required".** Click Connect and log in again; your session
  may have expired.
- **Too few videos pass.** Lower **How strict**, loosen the filters, or describe the videos
  in fewer, plainer words.
- **The AI is slow.** Use a smaller model (`gemma3:4b`) or fewer agents. The AI checks
  videos one at a time, and the agents pause automatically when it falls behind.
- **Start over completely.** Quit Reel Finder and delete the `reel-finder/data` folder.
  This removes your saved logins and settings; downloaded videos are not affected.

## Built on

Reel Finder ties together open-source tools that are maintained and still worked as of 2026:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads videos. It's updated almost daily
  as the sites change, and it uses `curl-cffi` for TikTok.
- [Playwright](https://playwright.dev/python/) drives the agents' browser.
- [Ollama](https://ollama.com) runs the local AI, using structured JSON answers.
- [FastAPI](https://fastapi.tiangolo.com) and [uv](https://github.com/astral-sh/uv) run the app and manage Python.

Other projects were looked at and left out:

- **TikTok-Api:** needs constantly changing `ms_token`s.
- **tiktok-scraper:** unmaintained since 2023.
- **instaloader** and **instagrapi:** use Instagram's private API, which is login-gated and
  a ban risk.
- yt-dlp's own TikTok and Instagram hashtag search is currently broken, so discovery is
  done by the agents' browser and yt-dlp only downloads.

## For developers

```sh
cd reel-finder
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m reelfinder          # serves http://127.0.0.1:8765
.venv/bin/python -m pytest              # 50+ tests, including real-browser end-to-end runs
```

`tests/fakesite.py` is a stand-in TikTok/Instagram: search pages that load videos via JSON
as you scroll, captcha and login walls, and playable videos. The end-to-end tests drive
real Chromium agents against it and download through yt-dlp. To point the app at it, set
`REELFINDER_SITE_TIKTOK` / `REELFINDER_SITE_INSTAGRAM` to its URL.

How the code is laid out:

| File | Job |
|---|---|
| `reelfinder/hunt.py` | The pipeline: plan → agents → filters → AI judge → downloads |
| `reelfinder/scouts.py` | The agents: scrolling, reading the site's JSON and links, captcha and login detection |
| `reelfinder/parsing.py` | Finds video objects anywhere in TikTok and Instagram responses |
| `reelfinder/ai.py` | Ollama planner and judge, plus the keyword fallback |
| `reelfinder/downloader.py` | yt-dlp, the download log, frame grabs |
| `reelfinder/browser.py` | The saved browser profile, logins, cookies handed to yt-dlp |
| `reelfinder/main.py` | The local web server (localhost only) |
| `web/` | The page |

## Please note

Use Reel Finder for collecting reference material for your own work. Respect the
platforms' terms and the creators' rights: don't re-upload other people's videos as
your own.
