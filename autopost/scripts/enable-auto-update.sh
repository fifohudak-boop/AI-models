#!/bin/sh
# Turns on Fifofarm's automatic updates and in-dashboard settings on this
# server. Starts the current version, then installs a cron job that runs
# scripts/maintain.sh every minute. Safe to run again.
#   --no-start   don't (re)start containers (install.sh already did)
set -eu
start=1
for arg in "$@"; do
  [ "$arg" = "--no-start" ] && start=0
done

APP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
REPO_DIR=$(CDPATH='' cd -- "$APP_DIR/.." && pwd)
RUNTIME="$APP_DIR/runtime"
say() { printf '%s\n' "$*"; }
die() {
  say "✗ $*" >&2
  exit 1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo -n docker "$@"; fi
}

command -v crontab >/dev/null 2>&1 || die "cron is missing. Install it with: sudo apt-get install -y cron"
git -C "$REPO_DIR" rev-parse HEAD >/dev/null 2>&1 || die "$REPO_DIR is not a git checkout (clone the repository with git)."
[ -f "$APP_DIR/.env" ] || die "No .env yet. Run install.sh first."

mkdir -p "$RUNTIME"
[ -w "$RUNTIME" ] || sudo -n chown "$(id -u):$(id -g)" "$RUNTIME"
chmod 700 "$RUNTIME"

BRANCH=$(sed -n 's/^FIFOFARM_BRANCH=//p' "$APP_DIR/.env" | tail -n 1)
case "$BRANCH" in '' | *[!A-Za-z0-9._/-]*) BRANCH=main ;; esac

if [ "$start" = 1 ]; then
  say "• Starting the current version (building takes a few minutes the first time)…"
  (cd "$APP_DIR" && docker_cmd compose up -d --build --remove-orphans)
  if grep -q '^COMPOSE_PROFILES=.*https' "$APP_DIR/.env"; then
    # Pick up the current Caddyfile (bind-mounted files need a fresh container).
    (cd "$APP_DIR" && docker_cmd compose up -d --force-recreate caddy)
  fi
fi
git -C "$REPO_DIR" rev-parse HEAD >"$RUNTIME/.built-commit"
date -u +%Y-%m-%dT%H:%M:%SZ >"$RUNTIME/.installed-at"
printf 'ok' >"$RUNTIME/.update-state"
printf 'Up to date.' >"$RUNTIME/.update-message"

# If maintain.sh itself ever breaks, the fallback still pulls the next fix.
JOB="* * * * * /bin/sh $APP_DIR/scripts/maintain.sh >>$RUNTIME/maintain.log 2>&1 || (cd $REPO_DIR && git fetch -q origin $BRANCH && git checkout -q -f -B $BRANCH FETCH_HEAD) >/dev/null 2>&1 # fifofarm-maintain"
(crontab -l 2>/dev/null | grep -v 'fifofarm-maintain' || true; printf '%s\n' "$JOB") | crontab -
/bin/sh "$APP_DIR/scripts/maintain.sh" --status-only

say "✓ Automatic updates are on: new versions of the '$BRANCH' branch install themselves within 5 minutes,"
say "  and network keys or a new domain saved in Fifofarm → Settings apply within a minute."
