# <img src="web/logo.svg" width="40" alt="" align="top"> Reel Finder

Drop in a **reference video**, one that looks like what you want, or describe the videos
in words. Say how many you want and press **Start hunt**. AI agents scroll **TikTok**,
**Instagram Reels** and **Pinterest** at the same time and collect a big pool of videos.
Every one is scored on how much it looks like your reference, and the best ones download
into the folder you choose. Ask for 20 and you get the 20 closest it found.

Every file it saves is a real video that plays on any Mac: an H.264 MP4 with picture
and sound. Music-only files are never kept.

Everything runs on your Mac: your logins, your videos and the AI never leave it.

---

## Install it (Mac): one line

1. Open **Terminal**: press ⌘ Space, type `Terminal`, and press Enter.
2. Paste this line and press Enter:

   ```
   curl -fsSL https://raw.githubusercontent.com/fifohudak-boop/AI-models/main/reel-finder/install.sh | bash
   ```

The installer sets everything up, which takes a few minutes the first time:

- **Reel Finder itself:** installed in `~/Applications/Reel Finder`.
- **A Reel Finder app:** shows up in Launchpad and Spotlight, with a shortcut on your Desktop.
- **Python and the packages:** installed through [uv](https://github.com/astral-sh/uv).
- **A browser for the agents:** your Google Chrome if you have it, otherwise a private Chromium.
- **The free local AI:** [Ollama](https://ollama.com) and its model, a few GB. If macOS asks
  for your password while Ollama installs, that's expected.
- **Look-matching:** a small image model (CLIP, about 600 MB) that compares how videos look.

Then the Reel Finder page opens in your browser at **http://127.0.0.1:8765**. A Terminal
window stays open while Reel Finder runs; closing it quits Reel Finder.

**Next time,** just open the **Reel Finder** app.

**Updates are automatic.** Each time you open the app, it checks for a newer version and
installs it, keeping your settings, logins and downloads. That works even while Reel Finder
is already open: it restarts with the new version, unless a hunt is running. When a new
version is out, the top bar says **Update ready**. The version you're running is shown next
to the name at the top of the page.

**To uninstall,** delete these three things:

- the `Reel Finder` folder and the `Reel Finder` app in `~/Applications`
- the Desktop shortcut
- Ollama, from Applications, if you don't use it for anything else

Your downloaded videos stay where you saved them.

<details>
<summary>Without the installer</summary>

1. Download this repo as a ZIP and unzip it.
2. Double-click `reel-finder/start.command`. If macOS blocks it, right-click it, choose
   **Open**, then **Open** again.

This copy won't update itself.
</details>

## Use it

1. **Connect your accounts (once).** Click **Connect** next to TikTok, Instagram and
   Pinterest. A browser window opens: log in, then close the window. Instagram search
   doesn't work without logging in; TikTok and Pinterest work without, but show more when
   you're logged in. A spare account is safest, because heavy scrolling can get an
   account rate-limited.
2. **Run a self-test (once).** Click **Test** next to each platform. Each test runs one
   quick real search on your Mac and checks every step:
   - **Logged in**
   - **Search page**
   - **Videos found**
   - **Video details**
   - **Download:** saved to a temporary folder, then deleted
   - **AI judge**

   Each step shows ✓ (working), **!** (works, with a note) or ✕ (broken, with the reason).
3. **Add a reference video** (best), or describe what you want, or both:
   - **Drop a video** from your Mac onto **Reference videos**, or click *choose a file*.
     Pictures work too. You can add up to 5.
   - Or **paste a link** to a TikTok, Instagram, Pinterest or YouTube video and press **Add**.
   - Or **describe it** in plain words, for example *"Cinematic slow-motion car drifts at
     night with smoke, no talking, filmed low to the ground."* With a reference, use this box
     only for anything extra ("only night shots").
   - Optionally, add must-use hashtags such as `#cardrift`, and words that mean a video
     should be skipped, such as `tutorial, giveaway`.
4. **Pick a folder** with **Browse…**, set **Videos to save**, and press **Start hunt**.

What happens next:

- **The reference is analysed** (once, when you add it, in a few seconds):
  - 8 frames are taken from across the video.
  - The look-matching model measures how they look.
  - The AI describes what's in it (subject, setting, camera work, lighting, editing) and
    suggests searches.
  - If it came from a link, its hashtags are used as searches too.
- **Plan:** the searches start from the reference's searches and hashtags, then your own
  words, then the AI's variations, in the style each site uses.
- **Agents collect a pool:** each agent is its own browser window scrolling one search.
  When a search runs dry, the agent moves to the next one. They keep going until they have
  looked at **Videos to look at** (by default 4× what you want to save, at least 40). If
  every search runs out first, the AI plans new searches. With *Show the agents scrolling*
  on, the windows are tiled so you can watch them.
- **Quick filters:** videos that break your own limits (length, views, likes, age, or an
  excluded word) are skipped without asking the AI.
- **Every video is scored:**
  - The look-matching model compares its cover with your reference's frames. The card
    shows this as *"Looks 82% like your reference"*.
  - The AI reads the caption and looks at the cover, and gives a 0–100 score with a
    one-line reason.
  - The two are combined. The closer you set **How close to the reference**, the more the
    look counts. Without a reference, the cover is compared with your description instead.
  - Nothing is left unchecked: if time runs short, the rest are scored quickly.
- **The best ones are saved:** the top-scoring videos download, best first, until exactly
  the number you asked for is saved. If one can't be downloaded or turns out not to be a
  real video, the next best takes its place. If the pool runs out first, the agents go
  back and look for more.
- **Every file is checked:** after downloading, Reel Finder opens each file with ffmpeg.
  Music-only files and photo slideshows are thrown away and replaced. HEVC, VP9 and other
  formats QuickTime can't always play are converted to H.264.
- **The frames are checked against the reference:** a cover can mislead, so frames from the
  downloaded video itself are compared with your reference too. If they don't look close
  enough for your **How close** setting, the video is deleted and the next best takes its
  place.
- **Watch-check (optional):** after downloading, the AI looks at 3 frames from the video
  itself and replaces it if the footage doesn't match.
- **Finish now** stops the searching and saves the best videos found so far. Press it
  again (**Stop now**) to stop straight away.

Watch the results in the tabs under the progress bar: **Best** (ranked by score),
**Saved**, **All** and **Skipped**. Found one that's spot on? Press **More like this** on
its card to add it as a reference for your next hunt. A few references of the exact look
you want give the most consistent set of videos.

### How close to the reference

| Setting | What you get |
|---|---|
| Same kind of video | Same subject and vibe, any style. Always saves the number you asked for. |
| Same look (default) | Same subject, setting and style, the closest first. Clearly different videos are left out. |
| Very close | Only videos that look a lot like it. May save fewer than you asked for. |
| Nearly identical | Near-copies of the shots in your reference. May save only a few. |

If a hunt saves fewer than you asked for, the headline says how many were left out for
not looking close enough. Move the slider towards *Same kind of video*, or give it more time.

Each hunt gets its own subfolder, for example `2026-10-01 18.41 Cinematic night car drifts`.
It contains:

- the videos, named `tiktok_<creator>_<id>.mp4`, `instagram_<creator>_<code>.mp4` or
  `pinterest_<creator>_<id>.mp4`
- `reelfinder-log.csv`, listing the saved videos best first: rank, link, caption, creator,
  views, likes, length, score, the AI's reason, which search found it, and how much it
  looks like your reference (`look_match`)

### Pinterest pictures

Tick **Also save reference images** under Pinterest to save picture pins as well as
video pins. They're scored by the AI like the videos and saved as `.jpg`.

### Save a video from a link

Paste a link to one video (TikTok, Instagram, Pinterest, YouTube and more) into
**Save a video from a link** and press **Save**. It's downloaded with yt-dlp, checked and
converted the same way, and saved as an MP4 in **Saved links** inside your download
folder. Use this instead of downloading from Safari, which often saves only the sound or
a file that won't open.

Reel Finder remembers every video it has downloaded to a folder in
`.reelfinder-archive.txt`, so later hunts never download the same video twice.

### Settings

| Setting | What it does |
|---|---|
| Videos to save | Exactly how many videos to save: the best ones found. |
| Videos to look at | How many videos the agents collect and the AI scores before picking. Leave empty for 4× the number to save. More means better picks but a longer hunt. |
| Time limit | Searching stops at about ¾ of this, so there's time to score and save. |
| AI agents | How many browser windows scroll at once (1–6). Instagram and Pinterest are capped at 3 so your account doesn't get flagged. |
| Min/Max length | In seconds. A max of 0 means no limit. The default max is 180. |
| Min views / likes | Leave at 0 to ignore. Some Instagram posts hide their counts; those still pass. |
| Posted within | Only videos posted in the last N days. 0 means any time. |
| How close to the reference | Shown once you add a reference; see the table above. |
| Minimum AI score | Off (0) by default, so you always get the number you asked for. Raise it only if you'd rather get fewer videos than weak matches. |
| Model | Which Ollama model scores the videos. Models marked "sees images" also look at the cover. |
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

**First, click Test** next to the platform that's misbehaving. The step marked ✕ says
what's wrong. If the fix isn't obvious, click **Copy report** and paste it into a chat with
Claude. The report contains:

- version info
- the self-test results
- the end of the log file

It never includes your cookies or passwords. **Show log file** (under *Activity log*)
opens the full log in Finder.

- **An agent card says "Needs you: captcha".** Solve the captcha in that agent's window
  and it carries on by itself. This is why visible mode is recommended.
- **"Needs you: log in" on Instagram or Pinterest.** Click **Connect** next to it and log in.
- **No videos are found on a platform.** These sites change their pages often.
  Reel Finder updates itself and the downloader every time it starts, so quit and reopen it first.
  If one platform still finds nothing, untick it and keep using the other.
- **Downloads fail with "login required".** Click Connect and log in again; your session
  may have expired.
- **Fewer videos saved than you asked for.** The headline says why. Usually every search
  ran out: add more platforms, use broader or plainer words, loosen the length and views
  filters, or give it a longer time limit. Check that **Minimum AI score** is off.
- **The videos don't match well.** Add a reference video (or two or three of the exact
  look you want) instead of only describing it, and move **How close** to the right. Raise
  **Videos to look at** so there's more to choose from, and connect Pinterest: logged out,
  it only shows the first results of each search.
- **"Look-matching off" in the top bar.** The image model didn't install or download.
  Quit and reopen Reel Finder; it tries again. Hunts still work, judged by the AI alone.
- **A saved file only plays sound.** This shouldn't happen any more: every file is
  checked. If it does, click **Copy report** and send it.
- **The AI is slow.** Use a smaller model (`gemma3:4b`) or fewer agents. Videos the AI
  hasn't reached when time runs short are scored from their captions, so none are skipped.
- **The page looks like an older version** (no reference box, no Pinterest). Close the
  Terminal window that's running Reel Finder, then open the Reel Finder app again. Copies
  installed before October 6 only update when they start fresh.
- **Start over completely.** Quit Reel Finder and delete the `data` folder inside
  `~/Applications/Reel Finder` (or `reel-finder/data` in a downloaded copy).
  This removes your saved logins and settings; downloaded videos are not affected.

## Built on

Reel Finder ties together open-source tools that are maintained and still worked as of 2026:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads videos. It's updated almost daily
  as the sites change, and it uses `curl-cffi` for TikTok. Reel Finder asks it for H.264
  video with sound in one file.
- [ffmpeg](https://ffmpeg.org) checks every download and converts anything QuickTime
  can't play.
- [fastembed](https://github.com/qdrant/fastembed) runs CLIP (ViT-B/32) on the CPU to compare
  how videos look. Its scores are calibrated on real short-form videos: a video's own frames
  against its cover score 0.83–0.94, the same kind of video 0.75–0.87, unrelated videos about
  0.50.
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
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt -r requirements-similarity.txt
.venv/bin/python -m reelfinder          # serves http://127.0.0.1:8765
.venv/bin/python -m pytest              # includes real-browser end-to-end runs
```

`tests/fakesite.py` is a stand-in TikTok/Instagram/Pinterest: search pages that load
videos via JSON as you scroll, captcha and login walls, and media files, including the
kinds that used to arrive broken (music only, HEVC). The end-to-end tests drive real
Chromium agents against it and download through yt-dlp. To point the app at it, set
`REELFINDER_SITE_TIKTOK`, `REELFINDER_SITE_INSTAGRAM` or `REELFINDER_SITE_PINTEREST` to
its URL.

How the code is laid out:

| File | Job |
|---|---|
| `reelfinder/hunt.py` | The pipeline: plan → agents fill a pool → filters → AI scores every video → download the best N, replacing failures |
| `reelfinder/scouts.py` | The agents: scrolling, reading the site's JSON and links, captcha and login detection |
| `reelfinder/parsing.py` | Finds video objects anywhere in TikTok, Instagram and Pinterest responses |
| `reelfinder/ai.py` | Ollama planner and scorer (and reference describer), plus the keyword fallback |
| `reelfinder/references.py` | Reference videos: storing them, taking frames, analysing them |
| `reelfinder/similarity.py` | Look-matching: CLIP embeddings and calibrated look scores |
| `reelfinder/downloader.py` | yt-dlp, the ffmpeg check and H.264 conversion, the download log, frame grabs |
| `reelfinder/browser.py` | The saved browser profile, logins, cookies handed to yt-dlp |
| `reelfinder/selftest.py` | The per-platform self-test (one real search, checked step by step) |
| `reelfinder/logs.py` | The log file (`data/logs/reelfinder.log`), version info, yt-dlp warnings into the log |
| `reelfinder/main.py` | The local web server (localhost only) |
| `web/` | The page |
| `install.sh`, `update.sh`, `start.command` | The one-line installer, the auto-updater, and the launcher that sets up Python, the browser and Ollama |

## Please note

Use Reel Finder for collecting reference material for your own work. Respect the
platforms' terms and the creators' rights: don't re-upload other people's videos as
your own.
