#!/usr/bin/env sh
# Fifofarm installer. Asks where it runs and for a password, writes .env with
# strong random secrets, starts everything and waits until it's really ready.
# On a server it also opens the firewall, checks your domain and turns on
# automatic updates. Safe to re-run: an existing .env is kept.
set -eu
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() {
  say "✗ $*" >&2
  exit 1
}
is_linux() { [ "$(uname -s)" = Linux ]; }

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  if is_linux && command -v curl >/dev/null 2>&1; then
    say "• Installing Docker (needs sudo)…"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$(id -un)" || true
  else
    die "Docker is not installed. Get Docker Desktop from https://docs.docker.com/get-docker/ and run this again."
  fi
fi
# Use sudo for Docker until the new "docker" group applies to this login.
if docker info >/dev/null 2>&1; then
  DOCKER=docker
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  die "Docker is installed but not running. Start Docker (Docker Desktop on a Mac) and run this again."
fi
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). Update Docker."

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Replace KEY=... in .env (values passed through the environment so any
# character in them is safe). Keeps .env readable only by you.
set_env() {
  (
    umask 077
    AUTOPOST_VALUE=$2 awk -v key="$1" '
      BEGIN { value = ENVIRON["AUTOPOST_VALUE"]; done = 0 }
      $0 ~ "^" key "=" { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' .env >.env.tmp
  ) && mv .env.tmp .env
}

env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }

ask() {
  printf '%s ' "$1" >&2
  read -r answer
  printf '%s' "$answer"
}

public_ip() {
  curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true
}

resolve_ip() {
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$1" 2>/dev/null | awk 'NR == 1 { print $1 }'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket,sys
try: print(socket.gethostbyname(sys.argv[1]))
except Exception: pass' "$1"
  fi
}

# Oracle Cloud's Ubuntu images block ports 80/443 in iptables; ufw may too.
open_firewall() {
  is_linux || return 0
  if command -v iptables >/dev/null 2>&1 && rules=$(sudo -n iptables -S INPUT 2>/dev/null); then
    if printf '%s\n' "$rules" | grep -q -- '-j REJECT'; then
      for port in 80 443; do
        printf '%s\n' "$rules" | grep -q -- "--dport $port .*-j ACCEPT" && continue
        sudo -n iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
        say "• Opened port $port in the server firewall."
      done
      if command -v netfilter-persistent >/dev/null 2>&1; then sudo -n netfilter-persistent save >/dev/null 2>&1 || true; fi
    fi
  fi
  if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q 'Status: active'; then
    sudo -n ufw allow 80/tcp >/dev/null && sudo -n ufw allow 443/tcp >/dev/null && say "• Allowed ports 80 and 443 in ufw."
  fi
}

# Certificates only work once both names point at this server.
check_dns() {
  ip=$(public_ip)
  [ -n "$ip" ] || return 0
  waited=0
  while :; do
    bad=''
    for name in "$@"; do
      [ "$(resolve_ip "$name")" = "$ip" ] || bad="$bad $name"
    done
    [ -z "$bad" ] && {
      say "• DNS ok: $* → $ip"
      return 0
    }
    if [ "$waited" -eq 0 ]; then
      say ""
      say "! These names don't point to this server ($ip) yet:$bad"
      say "  Set their IP to $ip (DuckDNS: change \"current ip\" and click \"update ip\")."
      say "  Waiting for it… (Ctrl+C to stop; HTTPS starts working as soon as DNS is right)"
    fi
    [ "$waited" -ge 600 ] && {
      say "! Still not pointing here — continuing anyway. Fix DNS and HTTPS will start by itself."
      return 0
    }
    sleep 15
    waited=$((waited + 15))
  done
}

# ── Settings (.env) ──────────────────────────────────────────────────────────
mode=''
if [ -f .env ]; then
  say "• Keeping your existing .env (delete it to start the setup over)."
  [ -n "$(env_value DASHBOARD_DOMAIN)" ] && mode=2
else
  say ""
  say "Fifofarm setup"
  say "──────────────"
  say "Where will it run?"
  say "  1) This computer — quick to try. Posting works for YouTube, X, LinkedIn, Bluesky, Mastodon."
  say "  2) A server with a domain name — everything works, including TikTok, Instagram, Facebook, Threads."
  mode=$(ask "Choose 1 or 2:")
  [ "$mode" = "1" ] || [ "$mode" = "2" ] || die "Please answer 1 or 2."

  cp .env.example .env
  chmod 600 .env

  if [ "$mode" = "2" ]; then
    domain=$(ask "Domain for Fifofarm (e.g. myname.duckdns.org):")
    domain=$(printf '%s' "$domain" | sed 's#^https\{0,1\}://##; s#/.*$##' | tr '[:upper:]' '[:lower:]')
    [ -n "$domain" ] || die "A domain is required for server mode."
    postiz_domain=$(ask "Domain for the posting engine [postiz.$domain]:")
    [ -n "$postiz_domain" ] || postiz_domain="postiz.$domain"
    set_env DASHBOARD_DOMAIN "$domain"
    set_env POSTIZ_DOMAIN "$postiz_domain"
    set_env DASHBOARD_URL "https://$domain"
    set_env POSTIZ_URL "https://$postiz_domain"
    set_env NOT_SECURED ""
    set_env DISABLE_SSRF_PROTECTION ""
    set_env COMPOSE_PROFILES "https"
  fi

  say ""
  while :; do
    password=$(ask "Choose a password for Fifofarm (you can see what you type; Enter = make one for me):")
    if [ -z "$password" ]; then
      password=$(random_secret | cut -c1-20)
      break
    fi
    case "$password" in *"'"* | *'"'* | *'\'* | *'$'* | *' '*)
      say "  Please avoid quotes, \\, \$ and spaces."
      continue
      ;;
    esac
    [ ${#password} -ge 8 ] && break
    say "  At least 8 characters, please."
  done
  set_env DASHBOARD_PASSWORD "$password"
  set_env JWT_SECRET "$(random_secret)"
  set_env POSTGRES_PASSWORD "$(random_secret)"
  set_env DASHBOARD_SECRET "$(random_secret)"
  say "• Wrote .env"
fi

dashboard_url=$(env_value DASHBOARD_URL)
mkdir -p runtime && chmod 700 runtime

if [ "$mode" = "2" ]; then
  open_firewall
  check_dns "$(env_value DASHBOARD_DOMAIN)" "$(env_value POSTIZ_DOMAIN)"
fi

# ── Start ────────────────────────────────────────────────────────────────────
say "• Starting Fifofarm (the first start downloads ~2 GB and takes a few minutes)…"
$DOCKER compose up -d --build

printf '• Waiting for the dashboard'
i=0
until curl -fs -o /dev/null "http://localhost:3000/api/health" 2>/dev/null; do
  i=$((i + 1))
  [ $i -gt 90 ] && {
    say ""
    die "The dashboard didn't start. See: $DOCKER compose logs dashboard"
  }
  printf '.'
  sleep 2
done
say ""

# The posting engine (Postiz) needs a few minutes on its very first start;
# Fifofarm creates its account automatically as soon as it answers.
printf '• Waiting for the posting engine (first start: up to 10 minutes)'
i=0
engine=''
while :; do
  engine=$(curl -fs "http://localhost:3000/api/health" 2>/dev/null | sed -n 's/.*"engine":"\([a-z-]*\)".*/\1/p')
  [ "$engine" = "ready" ] && break
  i=$((i + 1))
  [ $i -gt 120 ] && break
  printf '.'
  sleep 10
done
say ""
[ "$engine" = "ready" ] || say "! The posting engine is still starting. Fifofarm finishes the setup by itself — just open it in a few minutes."

# ── Automatic updates (servers) ──────────────────────────────────────────────
if [ "$mode" = "2" ] && git rev-parse HEAD >/dev/null 2>&1 && command -v crontab >/dev/null 2>&1; then
  sh scripts/enable-auto-update.sh --no-start || say "! Couldn't turn on automatic updates (run: sh scripts/enable-auto-update.sh)."
fi

say ""
say "✓ Fifofarm is running."
say ""
say "  Open:      $dashboard_url"
say "  Password:  $(env_value DASHBOARD_PASSWORD)   ← save it somewhere safe (unless you changed it in Settings since)"
say ""
say "  Next: Accounts → pick a network → Set up (step-by-step, right in Fifofarm) → Connect."
