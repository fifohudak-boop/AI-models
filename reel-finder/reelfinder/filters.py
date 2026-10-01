"""Cheap checks that run before the AI so it only looks at plausible videos."""

from __future__ import annotations

import re
import time

from .config import HuntSettings
from .models import Candidate
from .parsing import split_terms


def _fmt(n: int) -> str:
    return f"{n / 1_000_000:.1f}M" if n >= 1_000_000 else f"{n / 1000:.0f}K" if n >= 1000 else str(n)


def excluded_term(caption: str, exclude: list[str]) -> str | None:
    text = caption.lower()
    for term in exclude:
        t = term.lower()
        # Whole-word match for words, plain substring for hashtags/phrases with symbols.
        if re.match(r"^[\w ]+$", t):
            if re.search(rf"(?<!\w){re.escape(t)}(?!\w)", text):
                return term
        elif t in text:
            return term
    return None


def needs_probe(c: Candidate, s: HuntSettings) -> bool:
    """True when a filter (or the AI) needs metadata the agent couldn't see."""
    return (
        c.maybe_not_video
        or not c.caption
        or not c.thumbnail_url
        or (c.duration is None and bool(s.min_duration or s.max_duration))
        or (c.views is None and s.min_views > 0)
        or (c.likes is None and s.min_likes > 0)
        or (c.timestamp is None and s.max_age_days > 0)
    )


def reject_reason(c: Candidate, s: HuntSettings, now: float | None = None) -> str | None:
    """Why this video fails the hard filters, or None if it passes (unknown values pass)."""
    if c.duration is not None:
        if s.min_duration and c.duration < s.min_duration:
            return f"Too short ({c.duration:.0f}s)"
        if s.max_duration and c.duration > s.max_duration:
            return f"Too long ({c.duration:.0f}s)"
    if s.min_views and c.views is not None and c.views < s.min_views:
        return f"Only {_fmt(c.views)} views"
    if s.min_likes and c.likes is not None and c.likes < s.min_likes:
        return f"Only {_fmt(c.likes)} likes"
    if s.max_age_days and c.timestamp:
        age_days = ((now or time.time()) - c.timestamp) / 86400
        if age_days > s.max_age_days:
            return f"Too old ({age_days:.0f} days)"
    term = excluded_term(c.caption, split_terms(s.exclude))
    if term:
        return f"Contains excluded word “{term}”"
    return None
