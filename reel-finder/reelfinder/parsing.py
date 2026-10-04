"""Turn whatever TikTok / Instagram / Pinterest send the browser into Candidate objects.

The sites change their JSON layouts often, so instead of hard-coding paths we walk
the whole response and pick out anything that *looks like* a video (or pin) object.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from email.utils import parsedate_to_datetime
from typing import Any

from .models import Candidate

_TIKTOK_ID = re.compile(r"^\d{15,22}$")
_TIKTOK_LINK = re.compile(r"(?:https?://(?:www\.|m\.)?tiktok\.com)?/@([\w.\-]+)/video/(\d{15,22})")
_INSTAGRAM_LINK = re.compile(r"(?:https?://(?:www\.)?instagram\.com)?/(?:[\w.]+/)?(reels?|p)/([\w-]{5,})")
_PINTEREST_LINK = re.compile(r"(?:https?://(?:[a-z]{2,3}\.)?pinterest\.[a-z.]+)?/pin/(?:[\w-]+--)?(\d{6,22})")


def split_terms(text: str) -> list[str]:
    """'a, b\\n#c' -> ['a', 'b', '#c'] (deduped, order kept)."""
    seen: dict[str, str] = {}
    for part in re.split(r"[,\n;]", text or ""):
        term = part.strip()
        if term and term.lower() not in seen:
            seen[term.lower()] = term
    return list(seen.values())


def _walk(node: Any, match: Callable[[dict], bool], depth: int = 0) -> Iterator[dict]:
    if depth > 40:
        return
    if isinstance(node, dict):
        if match(node):
            yield node
            return
        for value in node.values():
            yield from _walk(value, match, depth + 1)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value, match, depth + 1)


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _first(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", [], {}):
            return value
    return None


def _get(obj: Any, *path: Any) -> Any:
    for key in path:
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif isinstance(obj, list) and isinstance(key, int) and -len(obj) <= key < len(obj):
            obj = obj[key]
        else:
            return None
    return obj


# ---------------------------------------------------------------- TikTok

def _is_tiktok_web_item(d: dict) -> bool:
    return (
        isinstance(d.get("id"), str)
        and bool(_TIKTOK_ID.match(d["id"]))
        and isinstance(d.get("video"), dict)
        and isinstance(d.get("author"), dict)
    )


def _is_tiktok_app_item(d: dict) -> bool:
    return isinstance(d.get("aweme_id"), str) and isinstance(d.get("video"), dict)


def _tiktok_from_web(d: dict) -> Candidate | None:
    author = _first(_get(d, "author", "uniqueId"), _get(d, "author", "unique_id")) or ""
    if d.get("imagePost"):  # photo slideshows are not videos
        return None
    stats = d.get("stats") or {}
    stats_v2 = d.get("statsV2") or {}
    video = d["video"]
    return Candidate(
        platform="tiktok",
        id=d["id"],
        url=f"https://www.tiktok.com/@{author or '_'}/video/{d['id']}",
        rich=True,
        caption=d.get("desc") or "",
        author=author,
        views=_int(_first(stats.get("playCount"), stats_v2.get("playCount"))),
        likes=_int(_first(stats.get("diggCount"), stats_v2.get("diggCount"))),
        duration=_int(video.get("duration")) or None,
        timestamp=_int(d.get("createTime")),
        thumbnail_url=_first(video.get("originCover"), video.get("cover"), video.get("dynamicCover")),
    )


def _tiktok_from_app(d: dict) -> Candidate | None:
    author = _get(d, "author", "unique_id") or ""
    if d.get("image_post_info"):
        return None
    stats = d.get("statistics") or {}
    duration_ms = _int(_get(d, "video", "duration"))
    return Candidate(
        platform="tiktok",
        id=d["aweme_id"],
        url=f"https://www.tiktok.com/@{author or '_'}/video/{d['aweme_id']}",
        rich=True,
        caption=d.get("desc") or "",
        author=author,
        views=_int(stats.get("play_count")),
        likes=_int(stats.get("digg_count")),
        duration=(duration_ms / 1000) if duration_ms else None,
        timestamp=_int(d.get("create_time")),
        thumbnail_url=_first(
            _get(d, "video", "origin_cover", "url_list", 0), _get(d, "video", "cover", "url_list", 0)
        ),
    )


def parse_tiktok_json(data: Any) -> list[Candidate]:
    out: list[Candidate] = []
    for item in _walk(data, lambda d: _is_tiktok_web_item(d) or _is_tiktok_app_item(d)):
        cand = _tiktok_from_web(item) if _is_tiktok_web_item(item) else _tiktok_from_app(item)
        if cand:
            out.append(cand)
    return out


def parse_tiktok_links(links: list[dict]) -> list[Candidate]:
    out = []
    for link in links:
        m = _TIKTOK_LINK.search(link.get("href") or "")
        if m:
            author, vid = m.groups()
            out.append(Candidate(
                platform="tiktok",
                id=vid,
                url=f"https://www.tiktok.com/@{author}/video/{vid}",
                author=author,
                caption=(link.get("alt") or link.get("text") or "").strip(),
                thumbnail_url=_http(link.get("src")),
            ))
    return out


# ---------------------------------------------------------------- Instagram

def _is_ig_v1_media(d: dict) -> bool:
    return isinstance(d.get("code"), str) and ("media_type" in d or "product_type" in d)


def _is_ig_graph_media(d: dict) -> bool:
    return isinstance(d.get("shortcode"), str) and ("is_video" in d or "__typename" in d)


def _pick_thumb(candidates: Any) -> str | None:
    if not isinstance(candidates, list) or not candidates:
        return None
    sized = [c for c in candidates if isinstance(c, dict) and c.get("url")]
    if not sized:
        return None
    # ~640px wide is plenty for the AI and keeps downloads small.
    return min(sized, key=lambda c: abs((_int(c.get("width")) or 640) - 640))["url"]


def _ig_from_v1(d: dict) -> Candidate | None:
    if d.get("media_type") != 2 and d.get("product_type") != "clips":
        return None
    caption = _get(d, "caption", "text") or ""
    author = _first(_get(d, "user", "username"), _get(d, "owner", "username")) or ""
    return Candidate(
        platform="instagram",
        id=d["code"],
        url=f"https://www.instagram.com/reel/{d['code']}/",
        rich=True,
        caption=caption,
        author=author,
        views=_int(_first(d.get("ig_play_count"), d.get("play_count"), d.get("view_count"))),
        likes=_int(d.get("like_count")),
        duration=d.get("video_duration") if isinstance(d.get("video_duration"), (int, float)) else None,
        timestamp=_int(d.get("taken_at")),
        thumbnail_url=_first(_pick_thumb(_get(d, "image_versions2", "candidates")), d.get("thumbnail_url")),
    )


def _ig_from_graph(d: dict) -> Candidate | None:
    is_video = d.get("is_video") or "Video" in str(d.get("__typename") or "")
    if not is_video:
        return None
    caption = _get(d, "edge_media_to_caption", "edges", 0, "node", "text") or ""
    return Candidate(
        platform="instagram",
        id=d["shortcode"],
        url=f"https://www.instagram.com/reel/{d['shortcode']}/",
        rich=True,
        caption=caption,
        author=_get(d, "owner", "username") or "",
        views=_int(_first(d.get("video_view_count"), d.get("video_play_count"))),
        likes=_int(_first(_get(d, "edge_liked_by", "count"), _get(d, "edge_media_preview_like", "count"))),
        duration=d.get("video_duration") if isinstance(d.get("video_duration"), (int, float)) else None,
        timestamp=_int(d.get("taken_at_timestamp")),
        thumbnail_url=_first(d.get("thumbnail_src"), d.get("display_url")),
    )


def parse_instagram_json(data: Any) -> list[Candidate]:
    out: list[Candidate] = []
    for item in _walk(data, lambda d: _is_ig_v1_media(d) or _is_ig_graph_media(d)):
        cand = _ig_from_v1(item) if _is_ig_v1_media(item) else _ig_from_graph(item)
        if cand:
            out.append(cand)
    return out


def parse_instagram_links(links: list[dict]) -> list[Candidate]:
    out = []
    for link in links:
        m = _INSTAGRAM_LINK.search(link.get("href") or "")
        if m:
            kind, code = m.groups()
            out.append(Candidate(
                platform="instagram",
                id=code,
                url=f"https://www.instagram.com/reel/{code}/",
                caption=(link.get("alt") or link.get("text") or "").strip(),
                thumbnail_url=_http(link.get("src")),
                maybe_not_video=kind == "p",
            ))
    return out


# ---------------------------------------------------------------- Pinterest

def _is_pin(d: dict) -> bool:
    return (
        d.get("type") == "pin"
        and isinstance(d.get("id"), str)
        and d["id"].isdigit()
        and isinstance(d.get("images"), dict)
    )


def _pin_video_list(d: dict) -> dict | None:
    video_list = _get(d, "videos", "video_list")
    if isinstance(video_list, dict) and video_list:
        return video_list
    story = d.get("story_pin_data")
    if story:  # Idea pins keep their clips inside story pages
        for found in _walk(story, lambda x: isinstance(x.get("video_list"), dict) and bool(x["video_list"])):
            return found["video_list"]
    return None


def _pin_timestamp(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(parsedate_to_datetime(value).timestamp())
    except (TypeError, ValueError):
        return None


def _pin_from_json(d: dict) -> Candidate | None:
    if d.get("is_promoted"):
        return None  # ads
    images = d.get("images") or {}
    video_list = _pin_video_list(d)
    durations = [v.get("duration") for v in (video_list or {}).values() if isinstance(v, dict)]
    duration_ms = max((x for x in durations if isinstance(x, (int, float))), default=0)
    parts: list[str] = []
    for text in (d.get("grid_title"), d.get("title"), d.get("description"), d.get("auto_alt_text")):
        text = (text or "").strip()
        if not text or any(text.lower() in p.lower() for p in parts):
            continue
        parts = [p for p in parts if p.lower() not in text.lower()]  # a title repeated inside the description
        parts.append(text)
    reactions = d.get("reaction_counts")
    likes = sum(v for v in reactions.values() if isinstance(v, int)) if isinstance(reactions, dict) else None
    return Candidate(
        platform="pinterest",
        id=d["id"],
        url=f"https://www.pinterest.com/pin/{d['id']}/",
        kind="video" if video_list else "image",
        rich=True,
        caption=" · ".join(parts),
        author=_first(_get(d, "native_creator", "username"), _get(d, "pinner", "username")) or "",
        likes=likes if likes is not None else _int(_get(d, "aggregated_pin_data", "aggregated_stats", "saves")),
        duration=duration_ms / 1000 if duration_ms else None,
        timestamp=_pin_timestamp(d.get("created_at")),
        thumbnail_url=_first(_get(images, "474x", "url"), _get(images, "736x", "url"), _get(images, "orig", "url")),
        image_url=_first(_get(images, "orig", "url"), _get(images, "736x", "url")),
    )


def parse_pinterest_json(data: Any) -> list[Candidate]:
    return [c for c in (_pin_from_json(p) for p in _walk(data, _is_pin)) if c]


def _pinimg_size(url: str | None, size: str) -> str | None:
    """i.pinimg.com/236x/… → i.pinimg.com/736x/… (same picture, bigger)."""
    if not url or "pinimg.com/" not in url:
        return _http(url)
    return re.sub(r"pinimg\.com/[^/]+/", f"pinimg.com/{size}/", url, count=1)


def parse_pinterest_links(links: list[dict]) -> list[Candidate]:
    out = []
    for link in links:
        m = _PINTEREST_LINK.search(link.get("href") or "")
        if m:
            pin_id = m.group(1)
            out.append(Candidate(
                platform="pinterest",
                id=pin_id,
                url=f"https://www.pinterest.com/pin/{pin_id}/",
                caption=(link.get("alt") or link.get("text") or "").strip(),
                thumbnail_url=_pinimg_size(link.get("src"), "474x"),
                image_url=_pinimg_size(link.get("src"), "736x"),
                maybe_not_video=True,  # a bare link doesn't say whether the pin is a video
            ))
    return out


def _http(url: Any) -> str | None:
    return url if isinstance(url, str) and url.startswith("http") else None


PARSERS = {
    "tiktok": (parse_tiktok_json, parse_tiktok_links),
    "instagram": (parse_instagram_json, parse_instagram_links),
    "pinterest": (parse_pinterest_json, parse_pinterest_links),
}
