#!/bin/bash
# Reel Finder — double-click this file to start (macOS).
# First run installs everything it needs; later runs start in a few seconds.

cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
URL="http://127.0.0.1:8765"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m%s\033[0m\n" "$1"; echo "Press Enter to close."; read -r _; exit 1; }

printf "\n🎬  Reel Finder\n"

# Already running? Just open the page.
if curl -s -o /dev/null "$URL/api/status"; then
  open "$URL"
  exit 0
fi

# 0) Installed with the one-line installer? Then fetch any newer version first (keeps your data).
if [ "${1:-}" != "--no-update" ] && [ -f .installed_commit ] && [ -f update.sh ]; then
  bash ./update.sh
  if [ $? -eq 10 ]; then
    cd "$HERE" && exec "$HERE/start.command" --no-update
  fi
fi

# 1) uv installs the right Python version and all packages (no Homebrew needed).
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (one-time; it manages Python for Reel Finder)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh || fail "Couldn't install uv. Check your internet connection."
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2) Python environment + packages.
if [ ! -x .venv/bin/python ]; then
  say "Setting up Python (one-time)…"
  uv venv --python 3.12 .venv || fail "Couldn't create the Python environment."
fi
say "Checking packages…"
uv pip install --python .venv/bin/python -q -r requirements.txt || fail "Couldn't install the Python packages."
# TikTok and Instagram change often and yt-dlp ships fixes almost daily, so keep it current.
uv pip install --python .venv/bin/python -q -U "yt-dlp[default,curl-cffi]" >/dev/null 2>&1 || true

# 3) A browser for the agents: your Google Chrome if installed, else a private Chromium.
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  say "Google Chrome not found — installing a private Chromium for the agents (one-time)…"
  .venv/bin/python -m playwright install chromium || fail "Couldn't install Chromium."
fi

# 4) The free local AI (Ollama) and its model — installed for you if it's missing.
find_ollama() {
  OLLAMA_APP=""
  for app in "/Applications/Ollama.app" "$HOME/Applications/Ollama.app"; do
    [ -d "$app" ] && OLLAMA_APP="$app" && break
  done
  OLLAMA_BIN="$(command -v ollama || true)"
  if [ -z "$OLLAMA_BIN" ] && [ -n "$OLLAMA_APP" ] && [ -x "$OLLAMA_APP/Contents/Resources/ollama" ]; then
    OLLAMA_BIN="$OLLAMA_APP/Contents/Resources/ollama"
  fi
}

install_ollama() {
  say "Installing Ollama, the free local AI (one-time, about 200 MB)…"
  local dest="/Applications" tmp
  [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest" || return 1
  tmp="$(mktemp -d)" || return 1
  curl -fL --progress-bar https://ollama.com/download/Ollama-darwin.zip -o "$tmp/Ollama.zip" \
    && ditto -x -k "$tmp/Ollama.zip" "$dest"
  local ok=$?
  rm -rf "$tmp"
  return $ok
}

find_ollama
if [ -z "$OLLAMA_BIN" ]; then
  install_ollama || echo "Couldn't install Ollama right now — Reel Finder will match videos by keywords until it's installed."
  find_ollama
fi
if [ -n "$OLLAMA_BIN" ]; then
  if ! curl -s -o /dev/null http://127.0.0.1:11434/api/tags; then
    say "Starting Ollama…"
    if [ -n "$OLLAMA_APP" ]; then
      open "$OLLAMA_APP" 2>/dev/null || ("$OLLAMA_BIN" serve >/dev/null 2>&1 &)
    else
      ("$OLLAMA_BIN" serve >/dev/null 2>&1 &)
    fi
    for _ in $(seq 1 30); do
      curl -s -o /dev/null http://127.0.0.1:11434/api/tags && break
      sleep 1
    done
  fi
  MODEL="$(.venv/bin/python -m reelfinder.config model)"
  if ! "$OLLAMA_BIN" list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx -e "$MODEL" -e "$MODEL:latest"; then
    say "Downloading the AI model $MODEL (one-time, a few GB — grab a coffee)…"
    "$OLLAMA_BIN" pull "$MODEL" || echo "Couldn't download $MODEL right now — you can do it later from the Reel Finder page."
  fi
fi

# 5) Go.
say "Starting Reel Finder… keep this window open while you use it (close it to quit)."
exec .venv/bin/python -m reelfinder
