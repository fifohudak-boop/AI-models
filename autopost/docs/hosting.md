# Where to run Fifofarm (free or cheap)

Fifofarm needs a computer that is **always on** (posts go out even while you
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
plenty for Fifofarm.

Caveats:
- Sign-up needs a credit card for identity checks; you're not charged.
- Popular regions are sometimes "out of capacity". Try again later or pick
  another region.
- Oracle may reclaim free servers that sit almost completely idle. Fifofarm
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
   `yourname`, and set its **current ip** to your server's public IP (the
   default is the IP of the device you're on — change it).
2. **SSH in** and run:
   ```sh
   git clone https://github.com/fifohudak-boop/AI-models.git fifofarm
   cd fifofarm/autopost
   sh install.sh
   ```
   Choose **2 (server)**:
   - Fifofarm domain: `yourname.duckdns.org`
   - posting-engine domain: `postiz.yourname.duckdns.org` (just press Enter)
   - a password (you see what you type; Enter makes one for you)

   The installer installs Docker if needed, opens ports 80/443 (also Oracle's
   built-in firewall), waits until your domain points to the server, starts
   everything, sets up the posting engine and turns on automatic updates.
3. Open the address it prints and sign in. Then Accounts → Set up → Connect.

Docker restarts everything automatically after a reboot.

### Moving from Oracle to another server later

Install on the new server as above, then reconnect your accounts there (each
network's developer app only needs its redirect URLs updated if the domain
changes). Ask Claude for help copying your data across instead.

## C. Your own computer (€0)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   (Mac/Windows) or Docker Engine (Linux).
2. Run `./install.sh` and choose **1**.
3. Open **http://localhost:3000**.
4. Scheduled posts only go out while the computer is on and Docker is running.

To use TikTok/Instagram from your own computer, you'd need a public https
address. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with your own domain can provide one. Set it up to point
`postiz.yourdomain` → `localhost:4007` and `yourdomain` → `localhost:3000`,
then put those https URLs in `.env`. This is more fiddly than options A/B.

## Costs summary

| What | Cost |
|---|---|
| Fifofarm, Postiz, Temporal, Postgres, Redis, Caddy (all open source) | €0 |
| Server | €0 (Oracle free / own PC) or ~€5.50/month |
| Domain + https certificates | €0 (DuckDNS + Let's Encrypt) |
| YouTube, TikTok, Instagram, Facebook, Threads, LinkedIn, Pinterest, Bluesky, Mastodon APIs | €0 |
| X (Twitter) API | ~$0.015 per post, prepaid |
