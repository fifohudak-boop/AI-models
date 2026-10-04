"""Paths and the user-adjustable hunt settings (persisted to data/settings.json)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

APP_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = APP_DIR / "web"
DATA_DIR = Path(os.environ.get("REELFINDER_DATA", APP_DIR / "data"))
PROFILE_DIR = DATA_DIR / "browser-profile"
COOKIES_FILE = DATA_DIR / "cookies.txt"
THUMBS_DIR = DATA_DIR / "thumbs"
SETTINGS_FILE = DATA_DIR / "settings.json"
LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "reelfinder.log"

HOST = "127.0.0.1"
PORT = int(os.environ.get("REELFINDER_PORT", "8765"))
OLLAMA_HOST = os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434")

Platform = Literal["tiktok", "instagram", "pinterest"]
PLATFORMS: tuple[str, ...] = ("tiktok", "instagram", "pinterest")
PLATFORM_LABELS = {"tiktok": "TikTok", "instagram": "Instagram", "pinterest": "Pinterest"}

# Instagram and Pinterest flag accounts that scroll in many tabs at once.
MAX_AGENTS_PER_PLATFORM = {"tiktok": 6, "instagram": 3, "pinterest": 3}

# "-instruct" answers straight away; the plain qwen3-vl tags "think" for minutes first.
DEFAULT_MODEL = "qwen3-vl:8b-instruct"
SETTINGS_VERSION = 2


def default_output_dir() -> str:
    return str(Path.home() / "Movies" / "Reel Finder")


class HuntSettings(BaseModel):
    settings_version: int = SETTINGS_VERSION
    description: str = ""
    keywords: str = ""
    exclude: str = ""
    platforms: list[Platform] = Field(default_factory=lambda: ["tiktok", "instagram"])
    target_count: int = Field(20, ge=1, le=500)
    # How many videos to look at before picking the best `target_count`; 0 = automatic.
    pool_size: int = Field(0, ge=0, le=2000)
    agents: int = Field(4, ge=1, le=6)
    time_limit_min: int = Field(15, ge=1, le=240)
    min_duration: int = Field(0, ge=0)
    max_duration: int = Field(180, ge=0)
    min_views: int = Field(0, ge=0)
    min_likes: int = Field(0, ge=0)
    max_age_days: int = Field(0, ge=0)
    # Only save videos the AI scored at least this high; 0 = always save the number you asked for.
    min_score: int = Field(0, ge=0, le=100)
    include_images: bool = False  # Pinterest image pins count too
    model: str = DEFAULT_MODEL
    watch_check: bool = False
    show_browser: bool = True
    output_dir: str = Field(default_factory=default_output_dir)
    subfolder_per_hunt: bool = True


def pool_size_for(s: HuntSettings) -> int:
    """How many videos to check before choosing the best ones (4× what you asked for by default)."""
    if s.pool_size:
        return max(s.pool_size, s.target_count)
    return min(max(s.target_count * 4, s.target_count + 20, 40), 600)


def migrate(raw: dict) -> dict:
    """Bring settings saved by an older version up to date."""
    if raw.get("settings_version", 1) < 2:
        # v1 rejected anything under a 70 "strictness" and capped length at 90 s — the reason so
        # few videos got saved. v2 ranks everything and saves the best, so drop those.
        raw.pop("strictness", None)
        if raw.get("max_duration") == 90:
            raw["max_duration"] = 180
        raw["settings_version"] = SETTINGS_VERSION
    return raw


def load_settings() -> HuntSettings:
    try:
        return HuntSettings.model_validate(migrate(json.loads(SETTINGS_FILE.read_text())))
    except (OSError, ValidationError, ValueError, AttributeError):
        return HuntSettings()


def save_settings(settings: HuntSettings) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings.model_dump(), indent=2))


if __name__ == "__main__":
    # `python -m reelfinder.config model` prints the chosen AI model (used by start.command).
    if sys.argv[1:] == ["model"]:
        print(load_settings().model)
