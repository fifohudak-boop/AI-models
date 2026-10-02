# Set up AutoPost on a Mac with Claude Cowork

Claude Cowork can do almost the whole setup on your Mac for you: download
the code, run the installer, and fill in each network's developer forms.
It hands a few steps back to you on purpose: installing apps, typing your
passwords and login codes, and anything that costs money.

## What you need

- A Mac with Apple Silicon (M1 or newer).
- A Claude **Pro or Max** plan.
- The Claude desktop app from [claude.com/download](https://claude.com/download).
  In the app, go to **Settings → General** and switch on **Enable computer
  use**.

## Step 1 — install Docker Desktop (you, ~5 minutes)

Docker Desktop is the free program that runs AutoPost.

1. Download it from
   [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/).
   Choose **Mac with Apple chip**.
2. Open the downloaded file and drag Docker into Applications.
3. Open Docker, accept the terms, and enter your Mac password when asked.
   No Docker account is needed; you can skip signing in.
4. In Docker's **Settings**:
   - **General**: switch on **Start Docker Desktop when you sign in**.
   - **Resources**: make sure **Memory** is at least **4 GB**.

## Step 2 — let Cowork do the rest

Start a new Cowork task and paste this:

```
Set up AutoPost on this Mac. Use the Terminal app on my Mac for commands,
not your own sandbox. Whenever something needs my password, a login code,
an app install, or a payment, stop and let me do it.

1. Open https://github.com/fifohudak-boop/AI-models/pull/1 — if it isn't
   merged yet, click "Merge pull request" and "Confirm merge".
2. Download https://github.com/fifohudak-boop/AI-models/archive/refs/heads/main.zip,
   unzip it, and move the AI-models-main folder into my home folder, so it
   is at ~/AI-models-main (not in Documents or Downloads).
3. Check that Docker Desktop is running (whale icon in the menu bar). If it
   isn't, open it and wait until it says it's running.
4. In Terminal, run:
     cd ~/AI-models-main/autopost && sh install.sh
   Answer 1 (this computer). When it asks for a dashboard password, stop
   and let me type it. Wait until it prints "AutoPost is running".
5. Open http://localhost:4007 and let me create my Postiz account. Then
   in Postiz open Settings → Developers and copy the API key.
6. Open http://localhost:3000, let me sign in, and paste the API key.
7. Ask me which networks I want. For each one, follow
   ~/AI-models-main/autopost/docs/connect-platforms.md:
   create the developer app (let me log in), put its keys into
   ~/AI-models-main/autopost/.env, then in Terminal run
     cd ~/AI-models-main/autopost && docker compose up -d
8. On http://localhost:3000 open Accounts and click Connect for each
   network so I can sign in to my accounts.
9. Finally, post a short test video to one account and show me the result.
```

## What Cowork hands back to you

- Your Mac password, GitHub/Google/Meta/TikTok logins and two-step codes.
- Choosing the dashboard password. Write it down.
- Anything paid, such as X's API credit (about $0.015 per post).

## After setup

- **Using it:** open **http://localhost:3000**, drop in a video, write the
  caption, and click **Post**. Bookmark the page.
- **Scheduled posts:** these only go out while your Mac is awake and Docker
  is running. If you schedule overnight, keep it plugged in and turn on
  **System Settings → Battery → Options → Prevent automatic sleeping on
  power adapter when the display is off**.
- **Which networks work:** on your own Mac, YouTube, X, LinkedIn, Bluesky and
  Mastodon post fine. TikTok, Instagram, Facebook, Threads and Pinterest
  download your video from a public web address, so they need the server
  setup in [hosting.md](hosting.md). You can move to a server later; Cowork
  can help with that too.
