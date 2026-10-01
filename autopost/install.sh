#!/usr/bin/env sh
# AutoPost installer: asks two questions, writes .env with strong random
# secrets, and starts everything. Safe to re-run: an existing .env is kept.
set -eu
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { say "✗ $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Get it from https://docs.docker.com/get-docker/ (on Linux: curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). Update Docker."
docker info >/dev/null 2>&1 || die "Docker is installed but not running (or needs sudo). Start Docker, or run: sudo ./install.sh"

random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# Replace KEY=... in .env (values are passed through the environment so any
# character in them is safe).
set_env() {
  AUTOPOST_VALUE=$2 awk -v key="$1" '
    BEGIN { value = ENVIRON["AUTOPOST_VALUE"]; done = 0 }
    $0 ~ "^" key "=" { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env > .env.tmp && mv .env.tmp .env
}

ask() {
  printf '%s ' "$1" >&2
  read -r answer
  printf '%s' "$answer"
}

ask_password() {
  printf '%s ' "$1" >&2
  stty -echo 2>/dev/null || true
  read -r answer
  stty echo 2>/dev/null || true
  printf '\n' >&2
  printf '%s' "$answer"
}

if [ -f .env ]; then
  say "• Keeping your existing .env (delete it to start the setup over)."
else
  say ""
  say "AutoPost setup"
  say "──────────────"
  say "Where will it run?"
  say "  1) This computer — quick to try. Posting works for YouTube, X, LinkedIn, Bluesky, Mastodon."
  say "  2) A server with a domain name — everything works, including TikTok, Instagram, Facebook, Threads."
  mode=$(ask "Choose 1 or 2:")
  [ "$mode" = "1" ] || [ "$mode" = "2" ] || die "Please answer 1 or 2."

  cp .env.example .env
  chmod 600 .env

  if [ "$mode" = "2" ]; then
    domain=$(ask "Domain for the dashboard (e.g. myname.duckdns.org):")
    domain=$(printf '%s' "$domain" | sed 's#^https\{0,1\}://##; s#/.*$##')
    [ -n "$domain" ] || die "A domain is required for server mode."
    postiz_domain=$(ask "Domain for the Postiz engine [postiz.$domain]:")
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
    password=$(ask_password "Choose a dashboard password (8+ characters, Enter = generate one):")
    if [ -z "$password" ]; then
      password=$(random_secret | cut -c1-20)
      say "  Generated password: $password   ← save it somewhere safe"
      break
    fi
    case "$password" in *"'"*|*'"'*|*'\'*|*'$'*|*' '*) say "  Please avoid quotes, \\, \$ and spaces."; continue;; esac
    [ ${#password} -ge 8 ] && break
    say "  At least 8 characters, please."
  done
  set_env DASHBOARD_PASSWORD "$password"
  set_env JWT_SECRET "$(random_secret)"
  set_env POSTGRES_PASSWORD "$(random_secret)"
  set_env DASHBOARD_SECRET "$(random_secret)"
  say "• Wrote .env"
fi

say "• Starting AutoPost (the first start downloads ~2 GB and takes a few minutes)…"
docker compose up -d --build

dashboard_url=$(sed -n 's/^DASHBOARD_URL=//p' .env)
postiz_url=$(sed -n 's/^POSTIZ_URL=//p' .env)

printf '• Waiting for the dashboard'
i=0
until curl -fs -o /dev/null "http://localhost:3000/api/session" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 90 ] && { say ""; die "The dashboard didn't start. See: docker compose logs dashboard"; }
  printf '.'; sleep 2
done
say ""

say ""
say "✓ AutoPost is running."
say ""
say "Next steps (once):"
say "  1. Open $postiz_url and create your account (the first sign-up is yours; nobody else can register)."
say "     It can take 1–3 minutes after starting before Postiz answers."
say "  2. In Postiz: Settings → Developers (Public API) → copy the API key."
say "  3. Open $dashboard_url , sign in with your dashboard password, paste the key."
say "  4. Add developer keys for each network to .env (see docs/connect-platforms.md),"
say "     run 'docker compose up -d', then connect your accounts on the Accounts page."
