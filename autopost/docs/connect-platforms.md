# Connecting each social network

Every network makes you register a free "developer app" once. That gives you
two keys, which go into `.env`. After that you can connect as many accounts of
that network as you want, with one click each, from the dashboard's
**Accounts** page.

**Every time you change `.env`, run `docker compose up -d`.** The network
then shows up as connectable on the Accounts page.

Throughout this page, `POSTIZ_URL` means the value in your `.env`:
- on a server: `https://postiz.yourname.duckdns.org`
- on your own computer: `http://localhost:4007`

Every network asks for a **redirect URI** (also called a callback URL). It's
always:

```
POSTIZ_URL/integrations/social/<network>
```

For example, `https://postiz.yourname.duckdns.org/integrations/social/youtube`.

| Network | Keys in `.env` | Works on your own computer? | Catch |
|---|---|---|---|
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | yes | Uploads stay private until Google approves your project (free form) |
| TikTok | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` | no (needs https) | "Only me" posts until TikTok approves your app |
| Instagram | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | no | Needs a Professional (Business/Creator) account |
| Facebook Page (+ Instagram linked to it) | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | no | App must be switched to Live |
| Threads | `THREADS_APP_ID`, `THREADS_APP_SECRET` | no | Add yourself as a Threads tester |
| X (Twitter) | `X_API_KEY`, `X_API_SECRET` | yes | Paid: about $0.015 per post |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | yes | Needs a Company Page + Advertising API approval |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | no | Needs a business account; app approval |
| Bluesky | none | yes | Uses an app password, nothing to register |
| Mastodon | `MASTODON_URL`, `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET` | yes | Register the app on your own instance |

> **Why do some networks need https?** TikTok, Instagram, Facebook, Threads
> and Pinterest download your video from your server's public address, and
> refuse plain http. On your own computer they can't reach it. See
> [hosting.md](hosting.md) for a free or cheap server.

---

## YouTube

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project.
2. Under **APIs & Services → Library**, enable **YouTube Data API v3**. Also
   enable *YouTube Analytics API* and *YouTube Reporting API* (Postiz uses
   them for statistics).
3. Set up **APIs & Services → OAuth consent screen**:
   - user type **External**
   - add your Google account under **Test users**
4. Under **Credentials → Create credentials → OAuth client ID**:
   - type **Web application**
   - authorized redirect URI: `POSTIZ_URL/integrations/social/youtube`
5. Copy the client ID and secret into `YOUTUBE_CLIENT_ID` and
   `YOUTUBE_CLIENT_SECRET`.
6. **Important:** on the OAuth consent screen, click **Publish app** (status
   "In production").
   - While the app is in "Testing", Google expires your login every 7 days and
     YouTube posting stops.
   - Publishing doesn't need Google's review for your own use. You'll see an
     "unverified app" warning when connecting: click *Advanced → Continue*.
7. **To make uploads public:** Google locks videos from new API projects to
   *private* until the project passes a free compliance audit. Apply with the
   [YouTube API Services audit form](https://support.google.com/youtube/contact/yt_api_form).
   Until then, uploads arrive as private and you can make them public in
   YouTube Studio.

Quota: about 100 uploads per day per project, which is plenty.

**Several channels:** connect each one separately. Pick the right Google
account or Brand Account in the sign-in window.

## TikTok

1. Go to [developers.tiktok.com](https://developers.tiktok.com/apps) and
   create an app.
2. Add these products:
   - **Login Kit**, with redirect URI `POSTIZ_URL/integrations/social/tiktok`
   - **Content Posting API**, with **Direct Post** turned on
3. Scopes: `user.info.basic`, `user.info.profile`, `video.create`,
   `video.upload`, `video.publish`.
4. **Verify your domain:**
   - Under *URL properties* (or *Verify domains*), add your Postiz domain, e.g.
     `postiz.yourname.duckdns.org`.
   - TikTok downloads your video from there, and refuses domains you haven't
     verified.
   - DuckDNS supports the TXT record TikTok asks for: open
     `https://www.duckdns.org/update?domains=yourname&token=YOURTOKEN&txt=THE_VALUE`
     in a browser.
5. Copy the client key and secret into `TIKTOK_CLIENT_ID` and
   `TIKTOK_CLIENT_SECRET`.
6. **Before TikTok approves your app (its "audit"):**
   - Posts can only be *Only me*.
   - Your TikTok account must be set to private.
   - At most 5 accounts can post per day.
   - In the dashboard, go to **Settings → TikTok → Who can watch → Only me**.
7. Submit the app for review in the developer portal. After approval, switch
   to *Everyone*.

## Instagram

Two options, both using a free Meta developer app
([developers.facebook.com](https://developers.facebook.com/apps)). Your
Instagram account must be a **Professional** account (Business or Creator).
You can switch for free in the Instagram app.

**A) Instagram on its own (simplest)** → `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`
1. Create an app: use case **Other**, type **Business**.
2. Add the **Instagram** product and set up **Instagram Business Login**.
3. Redirect URI: `POSTIZ_URL/integrations/social/instagram-standalone`.
4. Permissions:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_insights`

**B) Instagram linked to a Facebook Page** → uses the Facebook keys below.
1. Your Instagram account must be linked to a Facebook Page.
2. Redirect URI: `POSTIZ_URL/integrations/social/instagram`.
3. Permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`

While the Meta app is in Development mode, only accounts added under **App
roles** (as testers) can post. For your own accounts that's all you need.

## Facebook Pages

1. Create an app at [developers.facebook.com](https://developers.facebook.com/apps):
   use case **Other**, type **Business**.
2. Add **Facebook Login for Business**. Redirect URI:
   `POSTIZ_URL/integrations/social/facebook`.
3. Permissions:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_manage_engagement`
   - `pages_read_engagement`
   - `business_management`
   - `read_insights`
4. Copy the app ID and secret into `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
   The same keys work for option B of Instagram.
5. **Switch the app from Development to Live** (top bar of the app dashboard).
   Otherwise your posts are only visible to you.

When you connect, Facebook asks which Page(s) to use. Pick them, then close
the sign-in window.

## Threads

1. In a Meta app, add the **Threads API** use case.
2. Permissions:
   - `threads_basic`
   - `threads_content_publish`
   - `threads_manage_replies`
   - `threads_manage_insights`
3. Redirect URI: `POSTIZ_URL/integrations/social/threads`. Click the URL after
   pasting it, or Meta won't save it.
4. **App roles → Add people → Threads Tester**: add your Threads username.
   Then accept the invite in Threads under *Settings → Account → Website
   permissions*.
5. Copy the keys into `THREADS_APP_ID` and `THREADS_APP_SECRET`.

## X (Twitter)

X charges for posting through its API: about **$0.015 per post**, prepaid
credits, no free tier for new developers since February 2026.

1. Go to [developer.x.com](https://developer.x.com) and create a project and
   app. Add a few dollars of credit.
2. **User authentication settings:**
   - permissions **Read and write**
   - app type **Native App** (*not* "Web App": that breaks login with error 32)
   - callback URI `POSTIZ_URL/integrations/social/x`
3. **Keys and tokens → Consumer Keys → Regenerate.** Copy them into
   `X_API_KEY` (API Key) and `X_API_SECRET` (API Key Secret).

## LinkedIn

1. Go to [linkedin.com/developers](https://www.linkedin.com/developers/apps)
   and create an app. LinkedIn requires a Company Page to attach it to; a
   quick placeholder page is fine.
2. Request all three products:
   - **Share on LinkedIn**
   - **Sign In with LinkedIn using OpenID Connect**
   - **Advertising API**

   Postiz asks for the company-page permissions even for personal profiles,
   and refuses the connection if any are missing. Advertising API access has
   to be requested, and LinkedIn may take a while to approve it.
3. Redirect URLs:
   - `POSTIZ_URL/integrations/social/linkedin`
   - `POSTIZ_URL/integrations/social/linkedin-page`
4. Copy the client ID and secret into `LINKEDIN_CLIENT_ID` and
   `LINKEDIN_CLIENT_SECRET`.

## Pinterest

1. You need a Pinterest **business** account. Create an app at
   [developers.pinterest.com](https://developers.pinterest.com/apps/) and wait
   for approval.
2. Redirect URI: `POSTIZ_URL/integrations/social/pinterest`.
3. Copy the app ID and secret into `PINTEREST_CLIENT_ID` and
   `PINTEREST_CLIENT_SECRET`.
4. After connecting, **pick a board** for each Pinterest account on the
   dashboard's Accounts page.
   - Video pins get a cover image automatically (a frame from your video).

## Bluesky

Nothing to register.
1. In Bluesky, go to **Settings → Privacy and security → App passwords** and
   create one.
2. On the dashboard's Accounts page, click **Bluesky → Connect**, then enter
   your handle and that app password.

Videos can be up to 3 minutes and 100 MB.

## Mastodon

1. On your instance, go to **Preferences → Development → New application**.
2. Redirect URI: `POSTIZ_URL/integrations/social/mastodon`.
3. Scopes: `profile`, `write:statuses`, `write:media`.
4. Put your instance address in `MASTODON_URL` (e.g. `https://mastodon.social`).
   Copy the client key and secret into `MASTODON_CLIENT_ID` and
   `MASTODON_CLIENT_SECRET`.

## Other networks

Postiz also supports Reddit, Discord, Telegram, Google Business, Dribbble,
Twitch, VK, Nostr, Lemmy, WordPress and more.
- Connect them inside Postiz itself (open `POSTIZ_URL`).
- Those that need no extra per-post settings (Telegram, Nostr, VK) also appear
  in the dashboard and get the one-click post.
- The rest (Reddit needs a subreddit, Discord a channel, and so on) are posted
  from Postiz.
