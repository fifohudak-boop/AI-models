#!/bin/bash
# Reel Finder — double-click this file to start (macOS).
# First run installs everything it needs; later runs start in a few seconds.

cd "$(dirname "$0")" || exit 1
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

# 4) The free local AI (Ollama) and its model.
OLLAMA_BIN="$(command -v ollama || true)"
if [ -z "$OLLAMA_BIN" ] && [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
  OLLAMA_BIN=/Applications/Ollama.app/Contents/Resources/ollama
fi
if [ -z "$OLLAMA_BIN" ]; then
  say "Ollama (the free local AI) isn't installed yet."
  echo "Opening its download page. Install it, then double-click start.command again."
  echo "Until then Reel Finder still works, matching videos by keywords only."
  open "https://ollama.com/download"
else
  if ! curl -s -o /dev/null http://127.0.0.1:11434/api/tags; then
    say "Starting Ollama…"
    open -a Ollama 2>/dev/null || ("$OLLAMA_BIN" serve >/dev/null 2>&1 &)
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
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
