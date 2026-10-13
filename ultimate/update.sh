#!/bin/bash
# Checks GitHub for a newer Fifofarm Ultimate and installs it, keeping your models, settings and logins.
# start.command runs this at launch. Exit code 10 means "updated — restart me";
# anything else (no update, offline, GitHub busy) means "carry on with this version".

here="$(cd "$(dirname "$0")" && pwd)" || exit 0
[ -f "$here/.installed_commit" ] || exit 0   # a developer checkout, not an installed copy

repo="fifohudak-boop/AI-models"
ref="$(cat "$here/.installed_ref" 2>/dev/null || echo main)"
# The newest commit that changed this app (changes to Fifofarm or Reel Finder don't count).
api="${ULTIMATE_API:-https://api.github.com/repos/$repo/commits?sha=$ref&path=ultimate&per_page=1}"

installed="$(cat "$here/.installed_commit")"
latest="$(curl -fsSL --max-time 5 "$api" 2>/dev/null \
  | grep -o '"sha": *"[0-9a-f]\{40\}"' | head -1 | grep -o '[0-9a-f]\{40\}')"
[ -n "$latest" ] || exit 0
[ "$latest" = "$installed" ] && exit 0

printf "\n\033[1m%s\033[0m\n" "A new version of Fifofarm Ultimate is available — updating…"
if ULTIMATE_HOME="$here" ULTIMATE_REF="$ref" ULTIMATE_SHA="$latest" \
   ULTIMATE_NO_LAUNCH=1 ULTIMATE_NO_SHORTCUTS=1 bash "$here/install.sh"; then
  exit 10
fi
echo "The update didn't work this time — starting the current version."
exit 0
