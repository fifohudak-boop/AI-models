# Where to run AutoPost (free or cheap)

AutoPost needs a computer that is **always on** (posts go out even while you
sleep) with about **2 GB of free RAM**. 4 GB of total RAM is comfortable. For
TikTok, Instagram, Facebook, Threads and Pinterest, it also needs a **public
https address**, because those networks download your video from it.

| Option | Cost | Works for |
|---|---|---|
| A. Oracle Cloud "Always Free" server | €0 | everything |
| B. Small VPS (e.g. Hetzner CX23, 4 GB) | ~€5.50/month | everything |
| C. Your own computer | €0 | YouTube, X, LinkedIn, Bluesky, Mastodon (computer must be on) |

The domain name is free with [DuckDNS](https://www.duckdns.org): you get
`yourname.duckdns.org`, and every `something.yourname.duckdns.org` points to
the same server. Certificates are free and automatic (Caddy + Let's Encrypt,
already included).

---

## A. Oracle Cloud Always Free (€0)

What you get (2026): an ARM server with up to **2 CPUs and 12 GB RAM** free
forever. Oracle reduced this from 4 CPUs / 24 GB in June 2026, but it's still
plenty for AutoPost.

Caveats:
- Sign-up needs a credit card for identity checks; you're not charged.
- Popular regions are sometimes "out of capacity". Try again later or pick
  another region.
- Oracle may reclaim free servers that sit almost completely idle. AutoPost
  runs constantly, so this normally isn't an issue.

Steps:
1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).
2. **Create a VM instance:**
   - image **Ubuntu 24.04**
   - shape **VM.Standard.A1.Flex** (Ampere ARM), 2 OCPU, 12 GB
   - download the SSH key
3. **Open the web ports:**
   - **Networking → your VCN → Security List → Add Ingress Rules**:
     TCP **80** and **443** from `0.0.0.0/0`.
   - Ubuntu on Oracle also has its own firewall. On the server, run:
     ```sh
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
4. Continue with **Set up the server** below.

## B. A small VPS (~€5.50/month)

Any provider works if it gives you Ubuntu, 4 GB RAM and a public IP. For
example, Hetzner **CX23** (2 vCPU, 4 GB, €5.49/month in 2026) or **CAX11**
(ARM, €5.99). Create it with Ubuntu 24.04, then continue below. Most VPS
providers have no firewall by default; if yours does, allow ports 80 and 443.

## Set up the server (A or B)

1. **Domain:** sign in at [duckdns.org](https://www.duckdns.org), create
   `yourname`, and set its IP to your server's public IP.
2. **SSH in** and install Docker:
   ```sh
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
3. **Get AutoPost and install:**
   ```sh
   git clone <this repository> autopost-repo
   cd autopost-repo/autopost
   ./install.sh
   ```
   Choose **2 (server)**:
   - dashboard domain: `yourname.duckdns.org`
   - Postiz domain: `postiz.yourname.duckdns.org` (just press Enter)
4. Follow the "Next steps" it prints.

Docker restarts everything automatically after a reboot.

## C. Your own computer (€0)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   (Mac/Windows) or Docker Engine (Linux).
2. Run `./install.sh` and choose **1**.
3. Open **http://localhost:3000**.
   - **Mac:** Postiz uses port 5000, which macOS' "AirPlay Receiver" also
     uses. If start-up complains about port 5000, turn it off in **System
     Settings → General → AirDrop & Handoff → AirPlay Receiver**.
4. Scheduled posts only go out while the computer is on and Docker is running.

To use TikTok/Instagram from your own computer, you'd need a public https
address. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with your own domain can provide one. Set it up to point
`postiz.yourdomain` → `localhost:5000` and `yourdomain` → `localhost:3000`,
then put those https URLs in `.env`. This is more fiddly than options A/B.

## Costs summary

| What | Cost |
|---|---|
| AutoPost, Postiz, Temporal, Postgres, Redis, Caddy (all open source) | €0 |
| Server | €0 (Oracle free / own PC) or ~€5.50/month |
| Domain + https certificates | €0 (DuckDNS + Let's Encrypt) |
| YouTube, TikTok, Instagram, Facebook, Threads, LinkedIn, Pinterest, Bluesky, Mastodon APIs | €0 |
| X (Twitter) API | ~$0.015 per post, prepaid |
