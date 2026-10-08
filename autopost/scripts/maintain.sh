#!/bin/sh
# Fifofarm server helper. Cron runs it every minute (enable-auto-update.sh sets
# that up). Each run it:
#   1. applies settings saved in the dashboard: runtime/pending.env → .env,
#      then `docker compose up -d` (new network keys, a new domain, ...)
#   2. every 5 minutes (or when the dashboard asks) checks GitHub for a new
#      version of the tracked branch and installs it
#   3. writes runtime/update.json and runtime/apply.json for Settings
#
#   --now          check for updates right away
#   --status-only  only refresh runtime/update.json
set -u

APP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
REPO_DIR=$(CDPATH='' cd -- "$APP_DIR/.." && pwd)
RUNTIME="$APP_DIR/runtime"
ENV_FILE="$APP_DIR/.env"
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(now)" "$*"; }
# Safe inside a JSON string: no quotes, backslashes or control characters.
# shellcheck disable=SC1003
clean() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-300; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }

BRANCH=$(env_value FIFOFARM_BRANCH)
case "$BRANCH" in '' | *[!A-Za-z0-9._/-]*) BRANCH=main ;; esac

mkdir -p "$RUNTIME" 2>/dev/null
[ -w "$RUNTIME" ] || sudo -n chown "$(id -u):$(id -g)" "$RUNTIME" 2>/dev/null
[ -w "$RUNTIME" ] || { log "runtime folder is not writable: $RUNTIME"; exit 0; }

# One run at a time (mkdir is atomic everywhere; flock doesn't exist on macOS).
LOCK="$RUNTIME/.maintain.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 1' INT TERM

docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo -n docker "$@"; fi
}
compose() { (cd "$APP_DIR" && docker_cmd compose "$@") >>"$RUNTIME/compose.log" 2>&1; }

# Keys the dashboard may change. Must match APPLY_ENV_KEYS in dashboard/server/runtime.js.
allowed_key() {
  case "$1" in
    YOUTUBE_CLIENT_ID | YOUTUBE_CLIENT_SECRET | TIKTOK_CLIENT_ID | TIKTOK_CLIENT_SECRET) return 0 ;;
    INSTAGRAM_APP_ID | INSTAGRAM_APP_SECRET | FACEBOOK_APP_ID | FACEBOOK_APP_SECRET) return 0 ;;
    THREADS_APP_ID | THREADS_APP_SECRET | X_API_KEY | X_API_SECRET) return 0 ;;
    LINKEDIN_CLIENT_ID | LINKEDIN_CLIENT_SECRET | PINTEREST_CLIENT_ID | PINTEREST_CLIENT_SECRET) return 0 ;;
    MASTODON_URL | MASTODON_CLIENT_ID | MASTODON_CLIENT_SECRET) return 0 ;;
    DASHBOARD_DOMAIN | POSTIZ_DOMAIN | DASHBOARD_URL | POSTIZ_URL) return 0 ;;
  esac
  return 1
}

# Replace KEY=... in .env (value passed through the environment so any
# character is safe), keeping the file private.
set_env() {
  (
    umask 077
    FIFOFARM_VALUE=$2 awk -v key="$1" '
      BEGIN { value = ENVIRON["FIFOFARM_VALUE"]; done = 0 }
      $0 ~ "^" key "=" { print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$ENV_FILE" >"$ENV_FILE.tmp"
  ) && mv "$ENV_FILE.tmp" "$ENV_FILE"
}

write_json() { # file, json
  printf '%s\n' "$2" >"$1.tmp" && mv "$1.tmp" "$1"
}

write_apply() { # state, message, keys
  write_json "$RUNTIME/apply.json" \
    "{\"state\":\"$1\",\"at\":\"$(now)\",\"message\":\"$(clean "$2")\",\"keys\":\"$(clean "$3")\"}"
}

apply_pending() {
  [ -f "$RUNTIME/pending.env" ] || return 0
  mv "$RUNTIME/pending.env" "$RUNTIME/applying.env" 2>/dev/null || return 0
  keys=''
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    if ! allowed_key "$key"; then
      log "apply: ignored $key (not allowed)"
      continue
    fi
    if ! printf '%s\n' "$value" | grep -Eq '^[A-Za-z0-9._:/@+=-]{1,400}$'; then
      log "apply: ignored $key (invalid value)"
      continue
    fi
    set_env "$key" "$value" && keys="$keys $key"
  done <"$RUNTIME/applying.env"
  rm -f "$RUNTIME/applying.env"
  keys=${keys# }
  if [ -z "$keys" ]; then
    write_apply failed "Nothing valid to apply." ""
    return 0
  fi
  log "apply: $keys"
  write_apply running "Restarting with the new settings…" "$keys"
  if compose up -d --remove-orphans; then
    write_apply "done" "Applied." "$keys"
  else
    write_apply failed "Restart failed. Details: autopost/runtime/compose.log" "$keys"
  fi
}

set_state() { # state, message
  printf '%s' "$1" >"$RUNTIME/.update-state"
  printf '%s' "$2" >"$RUNTIME/.update-message"
}

read_file() { cat "$1" 2>/dev/null; }

write_update() {
  built=$(read_file "$RUNTIME/.built-commit")
  [ -n "$built" ] || built=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)
  commit=$(printf '%s' "$built" | cut -c1-7)
  commit_date=$(git -C "$REPO_DIR" log -1 --format=%cI "$built" 2>/dev/null)
  subject=$(git -C "$REPO_DIR" log -1 --format=%s "$built" 2>/dev/null)
  auto=false
  crontab -l 2>/dev/null | grep -q 'fifofarm-maintain' && auto=true
  write_json "$RUNTIME/update.json" "{\"state\":\"$(clean "$(read_file "$RUNTIME/.update-state")")\",\"message\":\"$(clean "$(read_file "$RUNTIME/.update-message")")\",\"branch\":\"$(clean "$BRANCH")\",\"commit\":\"$(clean "$commit")\",\"commitDate\":\"$(clean "$commit_date")\",\"subject\":\"$(clean "$subject")\",\"checkedAt\":\"$(clean "$(read_file "$RUNTIME/.checked-at")")\",\"installedAt\":\"$(clean "$(read_file "$RUNTIME/.installed-at")")\",\"heartbeatAt\":\"$(now)\",\"autoUpdate\":$auto}"
}

update_code() { # force (1 = check now)
  due=$1
  if [ -f "$RUNTIME/update-request" ]; then
    rm -f "$RUNTIME/update-request"
    due=1
  fi
  minute=$(date +%M | sed 's/^0//')
  [ $((${minute:-0} % 5)) -eq 0 ] && due=1
  [ "$due" = 1 ] || return 0

  if ! git -C "$REPO_DIR" rev-parse HEAD >/dev/null 2>&1; then
    set_state off "Not a git checkout, so automatic updates are off."
    return 0
  fi
  now >"$RUNTIME/.checked-at"
  if ! git -C "$REPO_DIR" fetch -q origin "$BRANCH" >>"$RUNTIME/compose.log" 2>&1; then
    set_state offline "Couldn't reach GitHub. Will try again in 5 minutes."
    return 0
  fi
  new=$(git -C "$REPO_DIR" rev-parse FETCH_HEAD)
  built=$(read_file "$RUNTIME/.built-commit")
  [ -n "$built" ] || built=$(git -C "$REPO_DIR" rev-parse HEAD)
  if [ "$new" = "$built" ]; then
    set_state ok "Up to date."
    return 0
  fi
  # A version that failed to build is retried only when asked (Check now).
  if [ "$new" = "$(read_file "$RUNTIME/.failed-commit")" ] && [ "$1" != 1 ]; then
    return 0
  fi

  log "update: $built -> $new"
  changed=$(git -C "$REPO_DIR" diff --name-only "$built" "$new" 2>/dev/null)
  set_state updating "Installing the new version…"
  write_update
  if ! git -C "$REPO_DIR" checkout -q -f -B "$BRANCH" "$new" >>"$RUNTIME/compose.log" 2>&1; then
    printf '%s' "$new" >"$RUNTIME/.failed-commit"
    set_state failed "Couldn't switch to the new version. Details: autopost/runtime/compose.log"
    return 0
  fi
  if compose up -d --build --remove-orphans && dashboard_healthy; then
    # Bind-mounted files are only re-read when their container is recreated.
    if printf '%s\n' "$changed" | grep -q '^autopost/Caddyfile$'; then
      compose up -d --force-recreate caddy || true
    fi
    if printf '%s\n' "$changed" | grep -Eq '^autopost/postiz-(healthcheck|local-port)\.js$'; then
      compose up -d --force-recreate postiz || true
    fi
    printf '%s' "$new" >"$RUNTIME/.built-commit"
    rm -f "$RUNTIME/.failed-commit"
    now >"$RUNTIME/.installed-at"
    set_state ok "Updated."
    log "update: done"
  else
    # Didn't build or didn't start: put the version that worked back.
    log "update: $new failed, going back to $built"
    printf '%s' "$new" >"$RUNTIME/.failed-commit"
    git -C "$REPO_DIR" checkout -q -f -B "$BRANCH" "$built" >>"$RUNTIME/compose.log" 2>&1
    compose up -d --build --remove-orphans
    set_state failed "The new version didn't start, so Fifofarm went back to the previous one. Details: autopost/runtime/compose.log"
  fi
}

# After an update: is the dashboard answering? (It starts in seconds; it
# doesn't wait for Postiz.)
dashboard_healthy() {
  tries=0
  while [ "$tries" -lt "${FIFOFARM_HEALTH_TRIES:-30}" ]; do
    if (cd "$APP_DIR" && docker_cmd compose exec -T dashboard wget -qO- http://localhost:3000/api/health) >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep "${FIFOFARM_HEALTH_WAIT:-3}"
  done
  log "update: the dashboard didn't answer after the update"
  return 1
}

trim_log() {
  [ -f "$1" ] || return 0
  if [ "$(wc -c <"$1")" -gt 1000000 ]; then
    tail -n 2000 "$1" >"$1.tmp" && mv "$1.tmp" "$1"
  fi
}

force=0
status_only=0
for arg in "$@"; do
  case "$arg" in
    --now) force=1 ;;
    --status-only) status_only=1 ;;
  esac
done

if [ "$status_only" = 0 ]; then
  apply_pending
  update_code "$force"
fi
write_update
trim_log "$RUNTIME/maintain.log"
trim_log "$RUNTIME/compose.log"
exit 0
