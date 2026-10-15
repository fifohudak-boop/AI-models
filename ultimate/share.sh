#!/bin/bash
# Fifofarm Ultimate — sharing helper.
#
# Gives your Mac a public HTTPS address that points at the app (http://localhost:8790), so the
# people you invite can sign in from their own computer. Run this on your Mac AFTER reading
# "Share it with your team" in the README. Leave the window open while you want sharing on;
# closing it (or Ctrl-C) stops sharing. The login is always in front of the app.
#
# It uses Tailscale Funnel if you have it (easiest, no domain), otherwise your Cloudflare tunnel.

set -e
PORT="${ULTIMATE_PORT:-8790}"

echo "Fifofarm Ultimate — sharing helper"
echo "This exposes the app on port $PORT over HTTPS so your team can sign in."
echo

# ---- Tailscale Funnel (recommended: no domain needed, fixed https://…ts.net address) ----
if command -v tailscale >/dev/null 2>&1; then
  echo "Using Tailscale Funnel."
  if ! tailscale status >/dev/null 2>&1; then
    echo
    echo "Tailscale isn't signed in yet. Run this once, then run this script again:"
    echo "    tailscale up"
    exit 1
  fi
  HOST=$(tailscale status --json 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || true)
  if [ -n "$HOST" ]; then
    echo
    echo "Your share address — paste this into the app's Settings → Sharing (no https://):"
    echo "    $HOST"
    echo
  fi
  echo "Starting the funnel to http://localhost:$PORT …"
  echo "Leave this window open to keep sharing on (Ctrl-C stops it)."
  echo
  exec tailscale funnel "$PORT"
fi

# ---- Cloudflare Tunnel (if you set one up with your own domain) ----
if command -v cloudflared >/dev/null 2>&1; then
  echo "Tailscale isn't installed, but cloudflared is."
  if [ -f "$HOME/.cloudflared/config.yml" ]; then
    echo "Running your Cloudflare tunnel. Leave this window open (Ctrl-C stops it)."
    echo "Then make sure Settings → Sharing has the hostname you routed (e.g. ultimate.yourdomain.com)."
    echo
    exec cloudflared tunnel run
  fi
  echo
  echo "cloudflared is installed but no tunnel is set up yet. Follow the Cloudflare steps in the"
  echo "README (login → create → route dns → config.yml), then run:  cloudflared tunnel run"
  exit 1
fi

# ---- Neither is installed ----
echo "Neither Tailscale nor Cloudflare's tunnel is installed."
echo
echo "Easiest path — Tailscale:"
echo "    brew install tailscale        (or get it from https://tailscale.com/download)"
echo "    tailscale up                  (sign in once)"
echo "    bash \"$0\"                      (run this script again)"
echo
echo "Or use Cloudflare Tunnel with your own domain — see 'Share it with your team' in the README."
exit 1
