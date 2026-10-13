"""Self-test: one quick, real search on one platform, checked step by step.

It uses exactly the parts a hunt uses (an agent, yt-dlp, the AI), so a green self-test
means hunts on that platform work on this computer — and a red step says which part broke.
"""

from __future__ import annotations

import asyncio
import logging
import re
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .ai import KeywordBrain, pick_brain
from .config import PLATFORM_LABELS, HuntSettings
from .downloader import Downloader, fetch_image, fill_from_info
from .models import Candidate
from .parsing import split_terms
from .scouts import SITES, Scout

log = logging.getLogger("reelfinder.selftest")

STEPS = ["Logged in", "Search page", "Videos found", "Video details", "Download", "AI judge"]
SLOW_AI_SECONDS = 20


def pick_test_query(s: HuntSettings) -> str:
    terms = split_terms(s.keywords)
    if terms:
        return terms[0]
    words = re.sub(r"[^\w\s#-]", "", s.description).split()[:3]
    return " ".join(words) or "#cars"


def _fmt_count(n: int | None) -> str:
    if n is None:
        return "?"
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}K" if n >= 1e3 else str(n)


def _first_line(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return (text[0] if text else type(exc).__name__)[:300]


class SelfTest:
    def __init__(
        self,
        platform: str,
        settings: HuntSettings,
        emit: Callable[[str, Any], None],
        *,
        browser,
        downloader: Downloader,
        brain_factory=pick_brain,
        site_url: str | None = None,
        scout_options: dict | None = None,
    ):
        self.platform = platform
        self.label = PLATFORM_LABELS[platform]
        self.s = settings
        self._emit = emit
        self.browser = browser
        self.downloader = downloader
        self.brain_factory = brain_factory
        self.site_url = site_url
        self.scout_options = {"max_scrolls": 4, "patience": 3, **(scout_options or {})}
        self.query = pick_test_query(settings)
        self.steps = [{"name": name, "status": "pending", "detail": ""} for name in STEPS]
        self.running = False
        self.finished_at: float | None = None
        self._current = 0
        self._page = None

    # ------------------------------------------------------------ reporting

    def state(self) -> dict:
        return {"platform": self.platform, "query": self.query, "running": self.running,
                "finished_at": self.finished_at, "steps": [dict(s) for s in self.steps]}

    def _set(self, i: int, status: str, detail: str = "") -> None:
        self._current = i
        self.steps[i] = {"name": STEPS[i], "status": status, "detail": detail}
        if status != "running":
            log.info("%s self-test — %s: %s. %s", self.label, STEPS[i], status.upper(), detail)
        self._emit("selftest", self.state())

    def _skip_rest(self, after: int, why: str) -> None:
        for i in range(after + 1, len(STEPS)):
            self.steps[i] = {"name": STEPS[i], "status": "skip", "detail": why}

    def summary(self) -> str:
        icons = {"ok": "✓", "warn": "⚠", "fail": "✗", "skip": "–", "pending": "·", "running": "…"}
        lines = [f"{self.label} self-test (search: {self.query!r})"]
        lines += [f"  {icons.get(s['status'], '?')} {s['name']}: {s['detail']}" for s in self.steps]
        return "\n".join(lines)

    # ------------------------------------------------------------ run

    async def run(self) -> None:
        self.running = True
        log.info("%s self-test started (search %r)", self.label, self.query)
        self._emit("selftest", self.state())
        try:
            await self._run()
        except asyncio.CancelledError:
            self._set(self._current, "fail", "Stopped before it finished")
            self._skip_rest(self._current, "Not run")
            raise
        except Exception as exc:  # noqa: BLE001 - the report should say what broke
            log.exception("%s self-test crashed", self.label)
            self._set(self._current, "fail", f"Unexpected error: {_first_line(exc)}")
            self._skip_rest(self._current, "Not run")
        finally:
            if self._page is not None:
                try:
                    await self._page.close()
                except Exception:  # noqa: BLE001 - window already closed
                    pass
            self.running = False
            self.finished_at = time.time()
            self._emit("selftest", self.state())

    async def _run(self) -> None:
        # 1. Browser + login
        self._set(0, "running", "Opening the agents' browser…")
        self._page = await self.browser.new_page(headless=not self.s.show_browser)
        logins = await self.browser.export_cookies()
        if logins.get(self.platform):
            self._set(0, "ok", "Logged in")
        elif self.platform == "instagram":
            self._set(0, "fail", "Not logged in — click Connect. Instagram search needs an account.")
        else:
            self._set(0, "warn", f"Not logged in — {self.label} works without, but logging in shows more results.")

        # 2. Search page
        self._set(1, "running", f"Searching “{self.query}”…")
        found: dict[str, Candidate] = {}

        async def on_found(c: Candidate) -> None:
            if c.key in found:
                found[c.key].merge(c)
            else:
                found[c.key] = c

        def on_status(st: dict) -> None:
            if st["state"] == "captcha":
                self._set(1, "running", st["note"])
            elif st["state"] == "scrolling":
                self._set(1, "running", f"Scrolling… {len(found)} videos so far")

        queries: asyncio.Queue = asyncio.Queue()
        scout = Scout(0, SITES[self.platform](self.site_url), self._page, queries, on_found, on_status,
                      asyncio.Event(), **self.scout_options)
        result = await scout.work_query(self.query)
        await asyncio.sleep(1.0)  # let the last JSON responses arrive
        if result == "login":
            self._set(1, "fail", f"{self.label} sent the agent to its login page — click Connect and log in.")
            self._skip_rest(1, "Needs a working search first")
            return
        if result == "captcha":
            self._set(1, "fail", "A captcha appeared and wasn't solved. Turn on “Show the agents scrolling” "
                                 "and solve it in the agent's window.")
            self._skip_rest(1, "Needs a working search first")
            return
        if result == "error":
            note = scout.page.url if scout.page else ""
            self._set(1, "fail", f"The search page didn't open ({note}). Check your internet connection.")
            self._skip_rest(1, "Needs a working search first")
            return
        self._set(1, "ok", f"Opened and scrolled {scout.scrolls} times")

        # 3. Videos recognised
        total = len(found)
        detailed = sum(1 for c in found.values() if c.thumbnail_url or c.views is not None)
        if total == 0:
            self._set(2, "fail", "The page loaded but no videos were recognised — the site may have changed. "
                                 "Copy the report and send it.")
            self._skip_rest(2, "No video to test with")
            return
        if detailed == 0:
            self._set(2, "warn", f"{total} video links, but no details from the site's data — hunts still work, "
                                 "just slower (details are fetched per video).")
        else:
            self._set(2, "ok" if total >= 3 else "warn",
                      f"{total} videos ({detailed} with full details from the site's data)")

        # 4. Video details via yt-dlp
        self._set(3, "running", "Reading one video's details…")
        videos = [c for c in found.values() if c.kind == "video"] or list(found.values())
        ranked = sorted(videos, key=lambda c: (c.maybe_not_video, not c.rich, not (c.thumbnail_url or c.views)))
        sample: Candidate | None = None
        error: BaseException | None = None
        for cand in ranked[:3]:
            try:
                fill_from_info(cand, await asyncio.to_thread(self.downloader.probe, cand.url))
                sample = cand
                break
            except Exception as exc:  # noqa: BLE001 - try the next one
                error = exc
        if sample is None:
            self._set(3, "fail", f"yt-dlp couldn't read the videos: {_first_line(error) if error else 'unknown error'}")
            self._skip_rest(3, "No readable video")
            return
        length = f"{sample.duration:.0f} s" if sample.duration else "length ?"
        self._set(3, "ok", f"“{(sample.caption or '(no caption)')[:60]}” · {length} · "
                           f"{_fmt_count(sample.views)} views · {sample.url}")

        # 5. Download (to a temporary folder, deleted afterwards — your folders aren't touched)
        self._set(4, "running", "Downloading it to a temporary folder…")
        try:
            with tempfile.TemporaryDirectory(prefix="reelfinder-selftest-") as tmp:
                started = time.monotonic()
                path = await asyncio.to_thread(
                    self.downloader.download, sample, Path(tmp), Path(tmp) / "archive.txt"
                )
                size = path.stat().st_size
                took = time.monotonic() - started
                media = await asyncio.to_thread(self.downloader.inspect, path)
            shown = f"{size / 1e6:.1f} MB" if size >= 1e6 else f"{max(size // 1000, 1)} KB"
            self._set(4, "ok", f"{shown} in {took:.1f} s — {media.summary()} MP4, plays on any Mac "
                               "(test file deleted)")
        except Exception as exc:  # noqa: BLE001
            self._set(4, "fail", f"Download failed: {_first_line(exc)}")

        # 6. AI judge
        self._set(5, "running", "Asking the AI about it…")
        brain, warning = await self.brain_factory(self.s.model)
        if isinstance(brain, KeywordBrain):
            self._set(5, "warn", warning or "No AI model — videos are matched by keywords only.")
            return
        image = None
        if sample.thumbnail_url:
            raw = await fetch_image(sample.thumbnail_url, referer=f"https://www.{self.platform}.com/")
            image = await asyncio.to_thread(self.downloader.to_jpeg, raw) if raw else None
        try:
            started = time.monotonic()
            verdict = await brain.judge(self.s.description or self.query, self.s.keywords, sample, image)
            took = time.monotonic() - started
        except Exception as exc:  # noqa: BLE001
            self._set(5, "fail", f"The AI ({self.s.model}) didn't answer: {_first_line(exc)}")
            return
        detail = f"Score {verdict.score} in {took:.1f} s — {verdict.reason}"
        if getattr(brain, "thinks", False):
            self._set(5, "warn", f"{detail}. This model “thinks” before answering, which is slow — "
                                 "pick an “-instruct” model.")
        elif took > SLOW_AI_SECONDS:
            self._set(5, "warn", f"{detail}. That's slow for a hunt — try a smaller model or fewer agents.")
        else:
            self._set(5, "ok", detail + ("" if getattr(brain, "can_see", False) and image else
                                         " (judged from the caption only)"))
