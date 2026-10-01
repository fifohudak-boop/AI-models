#!/bin/bash
# Reel Finder installer and updater for macOS. Paste this into Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/fifohudak-boop/AI-models/main/reel-finder/install.sh | bash
#
# It downloads Reel Finder into ~/Applications/Reel Finder, adds a "Reel Finder" app
# (Launchpad, Spotlight and a Desktop shortcut) and starts it. Running it again updates
# Reel Finder and keeps your settings, logins and downloads.
#
# Overrides (mostly for testing): REELFINDER_HOME, REELFINDER_REF, REELFINDER_SHA,
# REELFINDER_TARBALL, REELFINDER_API, REELFINDER_NO_LAUNCH=1, REELFINDER_NO_SHORTCUTS=1

# Everything is inside main() so a half-downloaded script never runs.
main() {
  set -u
  local repo="fifohudak-boop/AI-models"
  local ref="${REELFINDER_REF:-main}"
  local home_dir="${REELFINDER_HOME:-$HOME/Applications/Reel Finder}"
  local app_dir
  app_dir="$(dirname "$home_dir")/Reel Finder.app"
  local api="${REELFINDER_API:-https://api.github.com/repos/$repo/commits/$ref}"

  bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
  die() { printf "\n\033[31m%s\033[0m\n" "$1" >&2; exit 1; }

  printf "\n🎬  Reel Finder installer\n"

  local tmp
  tmp="$(mktemp -d)" || die "Couldn't create a temporary folder."
  # shellcheck disable=SC2064  # expand now: $tmp is local to main()
  trap "rm -rf '$tmp'" EXIT

  # 1. Which version to install (the exact commit, so code and version label always match).
  local sha="${REELFINDER_SHA:-}"
  if [ -z "$sha" ]; then
    sha="$(curl -fsSL --max-time 15 "$api" 2>/dev/null \
      | grep -o '"sha": *"[0-9a-f]\{40\}"' | head -1 | grep -o '[0-9a-f]\{40\}')" || sha=""
  fi

  # 2. Download and unpack.
  bold "Downloading Reel Finder…"
  if [ -n "${REELFINDER_TARBALL:-}" ]; then
    cp "$REELFINDER_TARBALL" "$tmp/src.tgz" || die "Couldn't read $REELFINDER_TARBALL"
  else
    local url="https://github.com/$repo/archive/refs/heads/$ref.tar.gz"
    [ -n "$sha" ] && url="https://codeload.github.com/$repo/tar.gz/$sha"
    curl -fsSL --retry 3 "$url" -o "$tmp/src.tgz" || die "Download failed. Check your internet connection and try again."
  fi
  { mkdir -p "$tmp/x" && tar -xzf "$tmp/src.tgz" -C "$tmp/x"; } || die "The download was damaged. Please try again."
  local src
  src="$(find "$tmp/x" -maxdepth 2 -type d -name reel-finder | head -1)"
  [ -n "$src" ] && [ -f "$src/start.command" ] || die "The download didn't contain Reel Finder."

  # 3. Swap the new version in, carrying over your data (settings, logins, logs) and Python setup.
  bold "Installing into ${home_dir}…"
  mkdir -p "$(dirname "$home_dir")" || die "Couldn't create $(dirname "$home_dir")"
  local staged="$home_dir.new.$$"
  rm -rf "$staged"
  cp -R "$src" "$staged" || die "Couldn't copy the files."
  if [ -d "$home_dir" ]; then
    local keep
    for keep in data .venv; do
      if [ -e "$home_dir/$keep" ]; then
        rm -rf "${staged:?}/$keep"
        mv "$home_dir/$keep" "$staged/$keep" || die "Couldn't keep your $keep folder."
      fi
    done
    mv "$home_dir" "$home_dir.old.$$" || die "Couldn't replace the old version."
  fi
  mv "$staged" "$home_dir" || die "Couldn't finish installing."
  rm -rf "$home_dir.old.$$"
  chmod +x "$home_dir/start.command" "$home_dir/install.sh" "$home_dir/update.sh" 2>/dev/null
  printf "%s\n" "${sha:-unknown}" > "$home_dir/.installed_commit"
  printf "%s\n" "$ref" > "$home_dir/.installed_ref"

  # 4. A double-clickable app (built here, so macOS doesn't block it) + a Desktop shortcut.
  if [ -z "${REELFINDER_NO_SHORTCUTS:-}" ]; then
    mkdir -p "$app_dir/Contents/MacOS"
    cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Reel Finder</string>
  <key>CFBundleDisplayName</key><string>Reel Finder</string>
  <key>CFBundleIdentifier</key><string>com.reelfinder.launcher</string>
  <key>CFBundleExecutable</key><string>reel-finder</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
PLIST
    # Opens Terminal so you can see what it's doing; closing that window quits Reel Finder.
    printf '#!/bin/bash\nexec open -a Terminal %q\n' "$home_dir/start.command" > "$app_dir/Contents/MacOS/reel-finder"
    chmod +x "$app_dir/Contents/MacOS/reel-finder"
    touch "$app_dir"
    if [ -d "$HOME/Desktop" ]; then
      ln -sfn "$app_dir" "$HOME/Desktop/Reel Finder.app" 2>/dev/null || true
    fi
    echo "Added the Reel Finder app to $(dirname "$app_dir") and a shortcut on your Desktop."
  fi

  bold "Reel Finder is installed${sha:+ (version ${sha:0:7})}."
  if [ -n "${REELFINDER_NO_LAUNCH:-}" ]; then
    return 0
  fi
  echo "Starting it now. Next time, just open the Reel Finder app."
  rm -rf "$tmp"
  trap - EXIT
  # When piped through curl, stdin is the script itself; give Reel Finder the keyboard instead.
  if (exec </dev/tty) 2>/dev/null; then
    exec "$home_dir/start.command" --no-update </dev/tty
  else
    exec "$home_dir/start.command" --no-update
  fi
}

main "$@"
