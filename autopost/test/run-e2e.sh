#!/usr/bin/env sh
# Runs the end-to-end test from a clean slate: fresh databases, fresh Postiz
# account, fake Mastodon. Needs Docker, Node 20+, ffmpeg, and this line in
# /etc/hosts so your browser can reach the fake Mastodon:
#   127.0.0.1 mock-mastodon
# Extra compose files (e.g. for a proxy CA) can be passed via EXTRA_COMPOSE.
set -eu
cd "$(dirname "$0")/.."

compose() {
  # shellcheck disable=SC2086
  docker compose -f docker-compose.yml -f test/docker-compose.test.yml ${EXTRA_COMPOSE:-} "$@"
}

[ -f .env ] || { echo "Create .env first (./install.sh, local mode)"; exit 1; }
grep -q '^POSTIZ_URL=http://localhost:4007' .env || { echo ".env must be in local mode (POSTIZ_URL=http://localhost:4007)"; exit 1; }
getent hosts mock-mastodon >/dev/null || { echo "Add '127.0.0.1 mock-mastodon' to /etc/hosts"; exit 1; }

echo "Resetting the stack (deletes all Fifofarm data in this checkout)…"
compose down -v --remove-orphans
compose up -d ${NO_BUILD:+--no-build}

echo "Waiting for Postiz (1-3 minutes)…"
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4007/api/public/v1/is-connected)" = "401" ]; do
  i=$((i + 1)); [ $i -gt 100 ] && { echo "Postiz did not start"; compose logs postiz | tail -50; exit 1; }
  sleep 3
done

echo "Waiting for Fifofarm to create the Postiz account by itself…"
i=0
until curl -fs http://localhost:3000/api/health | grep -q '"engine":"ready"'; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "Automatic Postiz setup did not finish"; compose logs dashboard | tail -50; exit 1; }
  sleep 3
done
POSTIZ_API_KEY=$(compose exec -T postgres psql -U postiz -d postiz -tAc 'select "apiKey" from "Organization" limit 1')
DASHBOARD_PASSWORD=$(sed -n 's/^DASHBOARD_PASSWORD=//p' .env)

mkdir -p test/artifacts
VIDEO=test/artifacts/phone-video.mov
if [ ! -f "$VIDEO" ]; then
  echo "Making an iPhone-style test video (HDR HLG, HEVC 10-bit, vertical, .mov)…"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=6" \
    -f lavfi -i "sine=frequency=440:duration=6" -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 \
    -x265-params colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error \
    -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc \
    -c:a aac -shortest "$VIDEO"
fi

(cd test && [ -d node_modules ] || npm install --no-audit --no-fund)
cd test
POSTIZ_API_KEY="$POSTIZ_API_KEY" DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" TEST_VIDEO="$PWD/artifacts/phone-video.mov" \
  ARTIFACTS="$PWD/artifacts" node e2e.mjs
