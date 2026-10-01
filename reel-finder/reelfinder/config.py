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

Platform = Literal["tiktok", "instagram"]
PLATFORMS: tuple[str, ...] = ("tiktok", "instagram")
PLATFORM_LABELS = {"tiktok": "TikTok", "instagram": "Instagram"}

# Instagram flags accounts that scroll in many tabs at once.
MAX_AGENTS_PER_PLATFORM = {"tiktok": 6, "instagram": 3}

# "-instruct" answers straight away; the plain qwen3-vl tags "think" for minutes first.
DEFAULT_MODEL = "qwen3-vl:8b-instruct"


def default_output_dir() -> str:
    return str(Path.home() / "Movies" / "Reel Finder")


class HuntSettings(BaseModel):
    description: str = ""
    keywords: str = ""
    exclude: str = ""
    platforms: list[Platform] = Field(default_factory=lambda: ["tiktok", "instagram"])
    target_count: int = Field(20, ge=1, le=500)
    agents: int = Field(4, ge=1, le=6)
    time_limit_min: int = Field(15, ge=1, le=240)
    min_duration: int = Field(0, ge=0)
    max_duration: int = Field(90, ge=0)
    min_views: int = Field(0, ge=0)
    min_likes: int = Field(0, ge=0)
    max_age_days: int = Field(0, ge=0)
    strictness: int = Field(70, ge=0, le=100)
    model: str = DEFAULT_MODEL
    watch_check: bool = False
    show_browser: bool = True
    output_dir: str = Field(default_factory=default_output_dir)
    subfolder_per_hunt: bool = True


def load_settings() -> HuntSettings:
    try:
        return HuntSettings.model_validate_json(SETTINGS_FILE.read_text())
    except (OSError, ValidationError, ValueError):
        return HuntSettings()


def save_settings(settings: HuntSettings) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings.model_dump(), indent=2))


if __name__ == "__main__":
    # `python -m reelfinder.config model` prints the chosen AI model (used by start.command).
    if sys.argv[1:] == ["model"]:
        print(load_settings().model)
