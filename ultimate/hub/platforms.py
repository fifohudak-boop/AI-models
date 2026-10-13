"""Everything network-specific: turning one video + one caption into a valid post for each account.

A copy of Fifofarm's rules (server/platforms.js), so posts made here behave exactly like posts made
in Fifofarm. Pure functions only, so they're easy to test.
"""

from __future__ import annotations

import html
import re
import time
from typing import Any

from .settings import DEFAULT_PREFERENCES

# connect: 'oauth' opens the network's sign-in page; 'credentials' asks for a handle + app password;
# 'postiz' means connect it inside Postiz itself (still postable here once connected).
# media: 'video' = needs a video, 'any' = needs a photo or video, 'none' = text ok.
PLATFORMS: dict[str, dict[str, Any]] = {
    "youtube": {"name": "YouTube", "connect": "oauth", "media": "video"},
    "tiktok": {"name": "TikTok", "connect": "oauth", "media": "any"},
    "instagram-standalone": {"name": "Instagram", "connect": "oauth", "media": "any"},
    "instagram": {"name": "Instagram (via Facebook Page)", "connect": "oauth", "media": "any"},
    "facebook": {"name": "Facebook Page", "connect": "oauth", "media": "none"},
    "threads": {"name": "Threads", "connect": "oauth", "media": "none", "maxVideoSeconds": 300},
    "x": {"name": "X (Twitter)", "connect": "oauth", "media": "none", "maxVideoSeconds": 140},
    "linkedin": {"name": "LinkedIn", "connect": "oauth", "media": "none"},
    "linkedin-page": {"name": "LinkedIn Page", "connect": "oauth", "media": "none"},
    "pinterest": {"name": "Pinterest", "connect": "oauth", "media": "any", "needsBoard": True},
    "bluesky": {"name": "Bluesky", "connect": "credentials", "media": "none", "maxVideoSeconds": 180,
                "maxVideoBytes": 100 * 1024 * 1024},
    "mastodon": {"name": "Mastodon", "connect": "oauth", "media": "none"},
    "telegram": {"name": "Telegram", "connect": "postiz", "media": "none"},
    "nostr": {"name": "Nostr", "connect": "postiz", "media": "none"},
    "vk": {"name": "VK", "connect": "postiz", "media": "none"},
}


def is_supported(identifier: str) -> bool:
    return identifier in PLATFORMS


def platform_name(identifier: str) -> str:
    return PLATFORMS.get(identifier, {}).get("name", identifier)


def platform_catalog() -> list[dict]:
    """Networks you can connect from here. Whether the engine has keys for one shows when you connect."""
    return [
        {"identifier": ident, "name": p["name"], "connect": p["connect"]}
        for ident, p in PLATFORMS.items()
        if p["connect"] != "postiz"
    ]


# ---------------------------------------------------------------- counting characters

# twitter-text v3: most scripts count 1, CJK and emoji count 2, every link counts 23.
_X_LIGHT_RANGES = ((0, 4351), (8192, 8205), (8208, 8223), (8242, 8247))
_URL = re.compile(r"(?:https?://|www\.)[^\s<>\"]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|ly|tv|app|dev|ai|gg)\b(?:/[^\s]*)?", re.I)
_JOINERS = {0x200D, 0xFE0E, 0xFE0F} | set(range(0x1F3FB, 0x1F400)) | set(range(0xE0020, 0xE0080))


def _is_emoji(cp: int) -> bool:
    return (0x1F000 <= cp <= 0x1FAFF) or (0x2600 <= cp <= 0x27BF) or (0x2B00 <= cp <= 0x2BFF) or cp in (0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139)


def x_weighted_length(text: str) -> int:
    total = 0
    pos = 0
    for match in _URL.finditer(text):
        total += _weigh(text[pos:match.start()]) + 23
        pos = match.end()
    return total + _weigh(text[pos:])


def _weigh(text: str) -> int:
    total = 0
    after_emoji = False
    for ch in text:
        cp = ord(ch)
        if after_emoji and cp in _JOINERS:
            continue  # part of the previous emoji
        if _is_emoji(cp):
            total += 2
            after_emoji = True
            continue
        after_emoji = False
        total += 1 if any(lo <= cp <= hi for lo, hi in _X_LIGHT_RANGES) else 2
    return total


def js_length(text: str) -> int:
    """String.length in JavaScript (UTF-16 units), which is how Postiz counts."""
    return len(text.encode("utf-16-le")) // 2


def count_length(identifier: str, text: str) -> int:
    if identifier == "x":
        return x_weighted_length(text)
    if identifier == "threads":
        return len(text.encode("utf-8"))
    return js_length(text)


def fit_caption(identifier: str, text: str, max_length: int) -> tuple[str, bool]:
    """Trim to fit (in the network's own counting), at a word boundary when possible, ending with …"""
    if not max_length or count_length(identifier, text) <= max_length:
        return text, False
    chars = list(text)
    lo, hi = 0, len(chars)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        candidate = "".join(chars[:mid]).rstrip() + "…"
        if count_length(identifier, candidate) <= max_length:
            lo = mid
        else:
            hi = mid - 1
    cut = "".join(chars[:lo])
    last_space = re.search(r"\s\S*$", cut)
    if last_space and last_space.start() > len(cut) * 0.6:
        cut = cut[: last_space.start()]
    return cut.rstrip() + "…", True


def to_postiz_html(text: str) -> str:
    """Postiz stores posts as its editor's HTML (one <p> per line) and converts back per network."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "".join(f"<p>{html.escape(line, quote=True).replace('&#x27;', '&#39;')}</p>" for line in lines)


def youtube_title(title: str | None, caption: str, fallback: str | None) -> str:
    first_line = next((line for line in caption.split("\n") if line.strip()), "")
    result = re.sub(r"\s+", " ", (title or "").strip() or first_line.strip() or (fallback or "") or "New video")
    if len(list(result)) > 100:
        result = "".join(list(result)[:99]).rstrip() + "…"
    if len(result) < 2:
        result = f"{result} video".strip()
    return result


def build_settings(account: dict, *, title: str | None, caption: str, media_name: str | None, prefs: dict) -> dict:
    p = {**DEFAULT_PREFERENCES, **(prefs or {})}
    ident = account["identifier"]
    base = {"__type": ident}
    if ident == "youtube":
        return {**base, "title": youtube_title(title, caption, media_name), "type": p["youtubeVisibility"],
                "selfDeclaredMadeForKids": "no", "tags": []}
    if ident in ("tiktok", "tiktok-business"):
        return {**base, "privacy_level": p["tiktokPrivacy"], "duet": bool(p["tiktokAllowDuet"]),
                "stitch": bool(p["tiktokAllowStitch"]), "comment": bool(p["tiktokAllowComments"]),
                "autoAddMusic": "no", "brand_content_toggle": False, "brand_organic_toggle": False,
                "video_made_with_ai": False, "content_posting_method": p["tiktokMode"]}
    if ident in ("instagram", "instagram-standalone"):
        return {**base, "post_type": "post", "collaborators": []}
    if ident == "facebook":
        return {**base, "post_type": "post", **({"title": title.strip()} if title and title.strip() else {})}
    if ident == "x":
        return {**base, "who_can_reply_post": p["xWhoCanReply"], "post_type": "post"}
    if ident in ("linkedin", "linkedin-page"):
        return {**base, "post_as_images_carousel": False}
    if ident == "pinterest":
        pin_title = ((title or "").strip() or caption.split("\n")[0] or "").strip()
        out = {**base, "board": str((p.get("pinterestBoards") or {}).get(account["id"], ""))}
        if pin_title:
            out["title"] = "".join(list(pin_title)[:100])
        return out
    return base


def media_for(account: dict, media: dict | None) -> list[dict]:
    """What media each network gets. Pinterest needs a cover image next to a video."""
    if not media:
        return []
    if media["kind"] == "video":
        video = {"id": media["video"]["id"], "path": media["video"]["path"]}
        if account["identifier"] == "pinterest" and media.get("cover"):
            return [video, {"id": media["cover"]["id"], "path": media["cover"]["path"]}]
        return [video]
    return [{"id": img["id"], "path": img["path"]} for img in media.get("images", [])]


def format_duration(total_seconds: float) -> str:
    s = round(total_seconds)
    return f"{s // 60}:{s % 60:02d}"


def preflight(account: dict, media: dict | None, prefs: dict) -> tuple[list[str], list[str]]:
    """Problems we can spot before sending anything, so you see them up front."""
    platform = PLATFORMS.get(account["identifier"])
    problems: list[str] = []
    warnings: list[str] = []
    if not platform:
        problems.append("This network needs extra settings — post to it from Postiz instead.")
        return problems, warnings
    if account.get("disabled"):
        problems.append("This account is disabled in the posting engine.")
    if platform["media"] == "video" and (not media or media["kind"] != "video"):
        problems.append(f"{platform['name']} needs a video.")
    if platform["media"] == "any" and not media:
        problems.append(f"{platform['name']} needs a photo or video.")
    if platform.get("needsBoard") and not (prefs.get("pinterestBoards") or {}).get(account["id"]):
        problems.append("Pick a Pinterest board for this account (Accounts page).")
    if media and media["kind"] == "video":
        max_s = platform.get("maxVideoSeconds")
        if max_s and media.get("durationSeconds", 0) > max_s:
            warnings.append(f"{platform['name']} usually accepts videos up to {format_duration(max_s)}; "
                            f"this one is {format_duration(media['durationSeconds'])}.")
        max_b = platform.get("maxVideoBytes")
        if max_b and media.get("sizeBytes", 0) > max_b:
            warnings.append(f"{platform['name']} accepts videos up to {round(max_b / 1048576)} MB.")
    return problems, warnings


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def build_post_request(account: dict, inp: dict, prefs: dict, max_length: int) -> tuple[dict, bool]:
    """The full posting-engine request for one account; also says whether the caption was shortened."""
    p = {**DEFAULT_PREFERENCES, **(prefs or {})}
    raw = (inp.get("captions") or {}).get(account["id"], inp.get("caption", ""))
    text, shortened = fit_caption(account["identifier"], raw, max_length) if p["autoShorten"] else (raw, False)
    body = {
        "type": "schedule" if inp.get("scheduleAt") else "now",
        "date": inp.get("scheduleAt") or iso_now(),
        "shortLink": False,
        "tags": [],
        "posts": [{
            "integration": {"id": account["id"]},
            "value": [{"content": to_postiz_html(text), "image": media_for(account, inp.get("media"))}],
            "settings": build_settings(account, title=inp.get("title"), caption=raw,
                                       media_name=inp.get("mediaName"), prefs=p),
        }],
    }
    return body, shortened
