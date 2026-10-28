"""App-wide settings: the posting engine connection, AI Studio keys and posting defaults.

Kept in data/settings.json, readable only by you (it holds API keys).
"""

from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from typing import Any

from .config import SETTINGS_FILE

DEFAULT_PREFERENCES: dict[str, Any] = {
    "youtubeVisibility": "public",  # public | unlisted | private
    "tiktokPrivacy": "PUBLIC_TO_EVERYONE",  # SELF_ONLY until TikTok approves your app
    "tiktokAllowComments": True,
    "tiktokAllowDuet": False,
    "tiktokAllowStitch": False,
    "tiktokMode": "DIRECT_POST",  # DIRECT_POST publishes; UPLOAD sends to the TikTok inbox as a draft
    "xWhoCanReply": "everyone",
    "autoShorten": True,
    "pinterestBoards": {},  # accountId -> numeric board id
}

PREFERENCE_RULES = {
    "youtubeVisibility": lambda v: v in ("public", "unlisted", "private"),
    "tiktokPrivacy": lambda v: v in ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"),
    "tiktokAllowComments": lambda v: isinstance(v, bool),
    "tiktokAllowDuet": lambda v: isinstance(v, bool),
    "tiktokAllowStitch": lambda v: isinstance(v, bool),
    "tiktokMode": lambda v: v in ("DIRECT_POST", "UPLOAD"),
    "xWhoCanReply": lambda v: v in ("everyone", "following", "mentionedUsers", "subscribers", "verified"),
    "autoShorten": lambda v: isinstance(v, bool),
    "pinterestBoards": lambda v: isinstance(v, dict)
    and all(isinstance(x, str) and (x == "" or x.isdigit()) for x in v.values()),
}

DEFAULTS: dict[str, Any] = {
    # The posting engine (Postiz) your Fifofarm server runs, e.g. https://postiz.example.duckdns.org
    "engineUrl": "",
    "engineApiKey": "",
    # AI Studio (Alibaba Cloud Model Studio, the Wan video models)
    # The shared "default" Model Studio key, used by any model that doesn't have its own.
    "alibabaApiKey": "",
    "alibabaRegion": "intl",  # intl (Singapore) | cn (Beijing) | us | eu | jp | hk — see studio.REGIONS
    "alibabaWorkspace": "",  # Model Studio workspace ID (its own address); needed outside Singapore/Beijing
    # Per-model keys: { modelId: {apiKey, region, workspace} } — a model with its own key uses it
    # instead of the default, so different models can be on different Alibaba accounts.
    "studioKeys": {},
    # What Wan charges, per second of finished video, by model and resolution. Editable in Settings
    # (Alibaba's prices change and depend on your discounts); used for the cost shown before Generate
    # and for the Spending page. Seeded from Alibaba's published Wan 3.0 list prices (USD).
    "studioCurrency": "USD",
    "studioRates": {
        "wan3.0-video": {"480P": 0.0294, "720P": 0.0588, "1080P": 0.1176},
        "wan3.0-video-prime": {"480P": 0.063, "720P": 0.126, "1080P": 0.252},
    },
    # FaceFusion (the local "Face swap" provider in AI Studio): the command that runs FaceFusion on
    # this Mac, everything before the arguments — e.g. "/Users/you/facefusion/.venv/bin/python
    # /Users/you/facefusion/facefusion.py". Left blank, we look for a `facefusion` command on PATH.
    # Shared by all models (one install, not a per-model key); no cost.
    "faceFusionPath": "",
    "preferences": DEFAULT_PREFERENCES,
    "activeModel": "",
    # Sharing: let people reach the app from outside this Mac (through a tunnel), with a login.
    "sharingEnabled": False,
    "shareHost": "",  # the public web address people use, e.g. ultimate.yourname.com
}

_lock = threading.RLock()
_cache: dict[str, Any] | None = None


def _read() -> dict[str, Any]:
    try:
        raw = json.loads(SETTINGS_FILE.read_text())
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def get() -> dict[str, Any]:
    global _cache
    with _lock:
        if _cache is None:
            raw = _read()
            merged = deepcopy(DEFAULTS)
            merged.update({k: v for k, v in raw.items() if k in DEFAULTS})
            merged["preferences"] = {**DEFAULT_PREFERENCES, **(raw.get("preferences") or {})}
            _cache = merged
        return deepcopy(_cache)


def save(patch: dict[str, Any]) -> dict[str, Any]:
    global _cache
    with _lock:
        current = get()
        for key, value in patch.items():
            if key not in DEFAULTS:
                continue
            if key == "preferences":
                current["preferences"] = {**current["preferences"], **value}
            else:
                current[key] = value
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(current, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(SETTINGS_FILE)
        _cache = current
        return deepcopy(current)


def reset_cache() -> None:
    global _cache
    with _lock:
        _cache = None


def mask(secret: str) -> str:
    """Show that a key is saved without showing it."""
    if not secret:
        return ""
    return f"{secret[:3]}…{secret[-3:]}" if len(secret) > 10 else "saved"
