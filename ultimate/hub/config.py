"""Where Fifofarm Ultimate keeps things, and its name."""

from __future__ import annotations

import os
from pathlib import Path

BRAND_NAME = os.environ.get("ULTIMATE_BRAND", "Fifofarm Ultimate")

APP_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = APP_DIR / "web"
DATA_DIR = Path(os.environ.get("ULTIMATE_DATA", APP_DIR / "data"))
DB_FILE = DATA_DIR / "ultimate.db"
SETTINGS_FILE = DATA_DIR / "settings.json"
MODELS_DATA_DIR = DATA_DIR / "models"  # per model: Reel Finder references and settings
MEDIA_TMP_DIR = DATA_DIR / "media-tmp"  # videos being converted before they go to the posting engine
THUMB_CACHE_DIR = DATA_DIR / "library-thumbs"
LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "ultimate.log"

HOST = "127.0.0.1"
PORT = int(os.environ.get("ULTIMATE_PORT", "8790"))

# Where new models' folders go unless you choose your own.
DEFAULT_MEDIA_ROOT = Path(os.environ.get("ULTIMATE_MEDIA_ROOT", Path.home() / "Movies" / "Fifofarm Ultimate"))

# The original Reel Finder app (its logins can be copied over once).
REEL_FINDER_HOME = Path(os.environ.get("REELFINDER_HOME", Path.home() / "Applications" / "Reel Finder"))

REPO = "fifohudak-boop/AI-models"


def ensure_dirs() -> None:
    for d in (DATA_DIR, MODELS_DATA_DIR, MEDIA_TMP_DIR, THUMB_CACHE_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)
