"""One hunt: plan searches → agents fill a pool → the AI scores every video → save the best N.

Instead of a yes/no on each video, the AI gives every video it sees a score. Once enough
videos have been looked at (4× what you asked for, unless you set a number), the best ones
are downloaded. A video that can't be saved as a playable file is replaced by the next best.
If the searches run dry before the pool is full, the AI plans new ones; if the time runs out,
the remaining videos are scored from their captions so every video still gets checked.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from yt_dlp.utils import DownloadCancelled, DownloadError

from .ai import KeywordBrain, core_query, pick_brain
from .config import MAX_AGENTS_PER_PLATFORM, PLATFORM_LABELS, HuntSettings, pool_size_for
from .downloader import (
    ARCHIVE_NAME, Downloader, NotAVideo, append_log, fetch_image, fill_from_info, read_archive, safe_name,
)
from .filters import needs_probe, reject_reason
from .models import Candidate
from .parsing import split_terms
from .scouts import SITES, Scout

log = logging.getLogger("reelfinder")

Emit = Callable[[str, Any], None]
ScoutFactory = Callable[..., Awaitable[Any]]

JUDGE_DELAY = 2.0  # let a link-only sighting pick up its JSON details before it's scored
MAX_SHOWN = 800
DOWNLOAD_WORKERS = 3
MAX_REPLANS = 3
SEARCH_SHARE = 0.75  # of the time limit, spent searching; the rest is for finishing the checks
BLOCKED_STATES = ("login", "captcha")


def validate(s: HuntSettings) -> str | None:
    if not s.description.strip() and not split_terms(s.keywords):
        return "Describe the videos you want (or give at least one keyword)."
    if not s.platforms:
        return "Pick at least one platform."
    if s.max_duration and s.min_duration > s.max_duration:
        return "Minimum length is longer than the maximum length."
    try:
        Path(s.output_dir).expanduser().mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"Can't use that download folder: {exc.strerror or exc}"
    return None


def allocate_agents(platforms: list[str], total: int) -> dict[str, int]:
    alloc = {p: 0 for p in platforms}
    i = 0
    while total > 0 and any(alloc[p] < MAX_AGENTS_PER_PLATFORM.get(p, 6) for p in platforms):
        p = platforms[i % len(platforms)]
        i += 1
        if alloc[p] < MAX_AGENTS_PER_PLATFORM.get(p, 6):
            alloc[p] += 1
            total -= 1
    return alloc


def hunt_folder_name(s: HuntSettings) -> str:
    words = re.sub(r"[^\w\s-]", "", s.description or s.keywords).split()[:6]
    return f"{time.strftime('%Y-%m-%d %H.%M')} {' '.join(words)}".strip()[:80]


def short_error(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    text = text[0] if text else type(exc).__name__
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*\S+:\s*)?", "", text)[:200]


class Hunt:
    def __init__(
        self,
        settings: HuntSettings,
        emit: Emit,
        *,
        browser=None,
        downloader: Downloader | None = None,
        brain_factory=pick_brain,
        scout_factory: ScoutFactory | None = None,
        thumbs_dir: Path | None = None,
        screen: tuple[int, int] = (1440, 900),
        site_urls: dict[str, str] | None = None,
        scout_options: dict | None = None,
        time_limit_s: float | None = None,
    ):
        self.s = settings
        self.time_limit_s = time_limit_s if time_limit_s is not None else settings.time_limit_min * 60
        self._emit = emit
        self.browser = browser
        self.downloader = downloader or Downloader()
        self.brain_factory = brain_factory
        self.scout_factory = scout_factory or self._browser_scout
        self.thumbs_dir = thumbs_dir
        self.screen = screen
        self.site_urls = site_urls or {}
        self.scout_options = scout_options or {}

        self.stop_event = asyncio.Event()    # "Stop now": everything ends
        self.finish_event = asyncio.Event()  # "Finish now": stop searching, save the best found so far
        self.scan_stop = asyncio.Event()     # tells the agents to stop scrolling
        self.started = time.time()
        self.finished_reason = ""
        self.running = False
        self.phase = "starting"
        self.brain = None
        self.quick = False
        self.base_folder = Path(settings.output_dir).expanduser()
        self.folder = self.base_folder / hunt_folder_name(settings) if settings.subfolder_per_hunt else self.base_folder
        self.archive_path = self.base_folder / ARCHIVE_NAME
        self.archive: set[str] = set()
        self.pool_target = pool_size_for(settings)

        self.candidates: dict[str, Candidate] = {}
        self.recent: deque[str] = deque(maxlen=MAX_SHOWN)
        self.agents: dict[int, dict] = {}
        self.plan: dict[str, list[str]] = {}
        self.queues: dict[str, asyncio.Queue] = {}
        self.used_queries: set[str] = set()
        self.scouts: list[tuple[int, str, Any]] = []
        self.replans = 0
        self.logs: deque[dict] = deque(maxlen=80)
        self.counts = {"found": 0, "skipped": 0, "scored": 0, "downloaded": 0, "failed": 0, "already_have": 0}
        self.in_download = 0
        self.score_q: asyncio.Queue[Candidate] = asyncio.Queue()
        self._busy = 0
        self._saved_now: list[Candidate] = []
        self._logged = 0
        self._pages: list = []
        self._ai_failed_once = False
        self._warned_thinking = False
        self._deadline_search = float("inf")
        self._deadline_check = float("inf")

    # ------------------------------------------------------------ events

    def emit(self, kind: str, data: Any) -> None:
        self._emit(kind, data)

    def say(self, text: str, level: str = "info") -> None:
        entry = {"t": time.time(), "level": level, "text": text}
        self.logs.append(entry)
        log.log(logging.WARNING if level == "warn" else logging.INFO, text)
        self.emit("log", entry)

    def _show(self, c: Candidate) -> None:
        if c.key not in self.recent:
            self.recent.append(c.key)
        self.emit("candidate", c.model_dump())

    @property
    def pool_count(self) -> int:
        """Videos looked at that passed your filters (the pool the best ones are picked from)."""
        return self.counts["found"] - self.counts["skipped"]

    def progress(self) -> dict:
        return {
            **self.counts,
            "phase": self.phase,
            "target": self.s.target_count,
            "pool_target": self.pool_target,
            "looked_at": self.pool_count,
            "queued": (self.score_q.qsize() + self._busy) if self.running else 0,
            "downloading": self.in_download,
            "elapsed": round(time.time() - self.started),
            "folder": str(self.folder),
            "brain": getattr(self.brain, "name", ""),
            "quick": self.quick,
            "running": self.running,
            "finishing": self.finish_event.is_set(),
            "finished_reason": self.finished_reason,
        }

    def _progress(self) -> None:
        self.emit("progress", self.progress())

    def snapshot(self) -> dict:
        return {
            "progress": self.progress(),
            "agents": list(self.agents.values()),
            "plan": self.plan,
            "candidates": [self.candidates[k].model_dump() for k in self.recent if k in self.candidates],
            "logs": list(self.logs),
        }

    def _agent_status(self, status: dict) -> None:
        before = self.agents.get(status["id"], {})
        if (before.get("state"), before.get("query")) != (status["state"], status["query"]):
            log.info("Agent %s (%s) %s — %r %s", status["id"], status["platform"], status["state"],
                     status["query"], status.get("note") or "")
        self.agents[status["id"]] = status
        self.emit("agent", status)

    # ------------------------------------------------------------ control

    def finish(self) -> None:
        """Stop searching now and save the best videos found so far."""
        if not self.finish_event.is_set() and not self.stop_event.is_set():
            self.finish_event.set()
            self.scan_stop.set()
            self.say("Finishing up: checking what's been found and saving the best ones…")
            self._progress()

    def stop(self, reason: str = "Stopped") -> None:
        """Stop everything right away."""
        if not self.stop_event.is_set():
            self.finished_reason = self.finished_reason or reason
            self.stop_event.set()
            self.scan_stop.set()

    async def run(self) -> None:
        self.running = True
        self._progress()
        tasks: list[asyncio.Task] = []
        try:
            await self._run(tasks)
        except Exception as exc:  # noqa: BLE001 - report anything unexpected in the UI
            log.exception("Hunt crashed")
            self.say(f"Something went wrong: {exc}", "warn")
            self.finished_reason = self.finished_reason or "Error"
        finally:
            self.scan_stop.set()
            self.stop_event.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._close_pages()
            for c in self.candidates.values():
                if c.status in ("queued", "checking"):
                    c.status = "unchecked"
                    self._show(c)
                elif c.status in ("scored", "picked"):
                    c.status = "notpicked"
                    self._show(c)
            for agent in list(self.agents.values()):
                if agent["state"] not in ("login", "error", "done"):
                    self._agent_status({**agent, "state": "done", "note": "Hunt finished"})
            self.phase = "done"
            self.running = False
            self.say(f"Hunt finished — {self.finished_reason}.")
            self._progress()
            self.emit("finished", self.progress())

    async def _run(self, tasks: list[asyncio.Task]) -> None:
        s = self.s
        self.folder.mkdir(parents=True, exist_ok=True)
        self.archive = read_archive(self.archive_path)
        log.info("Hunt settings: %s", s.model_dump(exclude={"output_dir"}))
        self.say(f"Saving to {self.folder}")
        self.say(f"Plan: look at {self.pool_target} videos, then save the best {s.target_count}.")

        self.brain, warning = await self.brain_factory(s.model)
        if warning:
            self.say(warning, "warn")
        self._progress()

        alloc = allocate_agents(list(s.platforms), s.agents)
        await self._make_plan(alloc)
        agent_id = 0
        for platform, count in alloc.items():
            for _ in range(count):
                agent_id += 1
                scout = await self.scout_factory(agent_id, platform, self.queues[platform])
                self.scouts.append((agent_id, platform, scout))
        if self.browser is not None and self._pages:
            await self.browser.tile(self._pages, *self.screen)
            logins = await self.browser.export_cookies()
            for platform in s.platforms:
                if not logins.get(platform):
                    hint = " Instagram search won't work until you do." if platform == "instagram" else ""
                    self.say(f"You're not logged in to {PLATFORM_LABELS[platform]} in the agents' browser "
                             f"(use Connect).{hint}", "warn")

        workers = 4 if isinstance(self.brain, KeywordBrain) else 3
        tasks += [asyncio.create_task(self._score_worker()) for _ in range(workers)]

        start = time.monotonic()
        total = self.time_limit_s
        self._deadline_search = start + total * SEARCH_SHARE
        self._deadline_check = start + total

        out_of_time = False
        while not self.stop_event.is_set():
            found_before = self.counts["found"]
            await self._search(tasks)
            await self._check_all()
            if self.stop_event.is_set():
                break
            await self._download_best()
            if (self.counts["downloaded"] >= s.target_count or self.stop_event.is_set()
                    or self.finish_event.is_set()):
                break
            if time.monotonic() > self._deadline_search:
                out_of_time = True
                break
            if not self._can_search_more():
                break
            if self.counts["found"] == found_before:
                break  # a whole round turned up nothing new: the searches are used up
            missing = s.target_count - self.counts["downloaded"]
            self.pool_target = self.pool_count + missing * 4
            self.say(f"{self.counts['downloaded']} of {s.target_count} saved — looking at {missing * 4} more "
                     "videos to fill the rest.")

        saved = self.counts["downloaded"]
        if self.stop_event.is_set():
            self.finished_reason = self.finished_reason or "Stopped"
        elif saved >= s.target_count:
            self.finished_reason = f"Saved the best {saved} of {self.counts['scored']} checked"
        elif self.finish_event.is_set():
            self.finished_reason = f"Finished early — saved the best {saved}"
        elif self.counts["found"] == 0:
            self.finished_reason = "No videos found — run Test next to each platform to see why"
        elif self.pool_count == 0:
            self.finished_reason = (f"All {self.counts['found']} videos found broke your filters (see Skipped) — "
                                    "loosen the length, views, likes or age limits")
        elif out_of_time:
            self.finished_reason = (f"Saved {saved} of {s.target_count} — the time limit ran out before more "
                                    "were found. Give it a longer time limit")
        else:
            self.finished_reason = (f"Saved {saved} of {s.target_count} — that's every usable video found. "
                                    "Try broader words, more platforms or a longer time limit")

    # ------------------------------------------------------------ planning

    async def _make_plan(self, alloc: dict[str, int]) -> None:
        s = self.s
        platforms = [p for p, n in alloc.items() if n > 0]
        per_platform = max(8, max(alloc.values(), default=1) * 4)
        self.say("Planning searches…")
        try:
            planned = await self.brain.plan_queries(s.description, s.keywords, platforms, per_platform)
        except Exception as exc:  # noqa: BLE001 - AI hiccup: plan from your words instead
            self.say(f"The AI couldn't plan searches ({exc}); planning from your words instead.", "warn")
            planned = await KeywordBrain().plan_queries(s.description, s.keywords, platforms, per_platform)
        literal = core_query(s.description)
        for p in platforms:
            self.queues[p] = asyncio.Queue()
            first = split_terms(s.keywords) + ([literal] if literal else [])
            if p == "pinterest":
                first = [q.lstrip("#") for q in first]
            queries = first + list(planned.get(p, []))
            if not planned.get(p):
                queries += (await KeywordBrain().plan_queries(s.description, s.keywords, [p], per_platform))[p]
            self._add_queries(p, queries)
        self.emit("plan", self.plan)
        for p, qs in self.plan.items():
            self.say(f"{PLATFORM_LABELS[p]} searches: {', '.join(qs)}")

    def _add_queries(self, platform: str, queries: list[str]) -> int:
        added = 0
        for q in queries:
            q = re.sub(r"\s+", " ", q).strip()
            key = f"{platform}:{q.lower()}"
            if q and key not in self.used_queries:
                self.used_queries.add(key)
                self.queues[platform].put_nowait(q)
                self.plan.setdefault(platform, []).append(q)
                added += 1
        return added

    def _active_platforms(self) -> list[str]:
        """Platforms with at least one agent that isn't stuck on a login wall or captcha."""
        return sorted({p for agent_id, p, _sc in self.scouts
                       if self.agents.get(agent_id, {}).get("state") not in BLOCKED_STATES})

    def _can_search_more(self) -> bool:
        active = self._active_platforms()
        return bool(active) and (any(not self.queues[p].empty() for p in active) or self.replans < MAX_REPLANS)

    async def _replan(self) -> bool:
        platforms = self._active_platforms()
        if self.replans >= MAX_REPLANS or not platforms:
            return False
        self.replans += 1
        self.say("The searches ran out before finding enough videos — planning new ones…")
        s = self.s
        per = 8
        used = sorted({k.split(":", 1)[1] for k in self.used_queries})
        try:
            planned = await self.brain.plan_queries(s.description, s.keywords, platforms, per, avoid=used)
        except Exception:  # noqa: BLE001
            planned = {}
        added = sum(self._add_queries(p, planned.get(p, [])) for p in platforms)
        if not added:
            fallback = await KeywordBrain().plan_queries(s.description, s.keywords, platforms, per * 3, avoid=used)
            added = sum(self._add_queries(p, fallback.get(p, [])) for p in platforms)
        self.emit("plan", self.plan)
        return added > 0

    # ------------------------------------------------------------ searching

    def _search_should_end(self) -> bool:
        return (self.stop_event.is_set() or self.finish_event.is_set()
                or self.pool_count >= self.pool_target or time.monotonic() > self._deadline_search)

    async def _search(self, all_tasks: list[asyncio.Task]) -> None:
        self.phase = "searching"
        self.scan_stop.clear()
        self._progress()
        while not self._search_should_end():
            active = set(self._active_platforms())
            runnable = [(i, p, sc) for i, p, sc in self.scouts if p in active and not self.queues[p].empty()]
            if not runnable:
                if not await self._replan():
                    break
                continue
            before = (self.counts["found"], sum(q.qsize() for q in self.queues.values()))
            tasks = [asyncio.create_task(sc.run()) for _i, _p, sc in runnable]
            for task in tasks:
                task.add_done_callback(self._scout_ended)
            all_tasks += tasks
            while not all(t.done() for t in tasks):
                if self._search_should_end():
                    self.scan_stop.set()
                await asyncio.wait(tasks, timeout=0.5)
                self._progress()
            after = (self.counts["found"], sum(q.qsize() for q in self.queues.values()))
            if after == before:  # the agents couldn't make any progress; don't spin
                break
        self.scan_stop.set()

    def _scout_ended(self, task: asyncio.Task) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.error("Agent crashed", exc_info=task.exception())
            self.say(f"An agent stopped unexpectedly: {task.exception()}", "warn")

    async def _browser_scout(self, agent_id: int, platform: str, queries: asyncio.Queue):
        page = await self.browser.new_page(headless=not self.s.show_browser)
        self._pages.append(page)
        site = SITES[platform](self.site_urls.get(platform), include_images=self.s.include_images)
        return Scout(agent_id, site, page, queries, on_found=self.on_found, on_status=self._agent_status,
                     stop=self.scan_stop, **self.scout_options)

    async def _close_pages(self) -> None:
        for page in self._pages:
            try:
                await page.close()
            except Exception:  # noqa: BLE001 - window already closed
                pass
        self._pages.clear()

    async def on_found(self, c: Candidate) -> None:
        existing = self.candidates.get(c.key)
        if existing is not None:
            before = existing.model_dump()
            existing.merge(c)
            if existing.status == "queued" and existing.model_dump() != before:
                self._show(existing)
            return
        if c.archive_id in self.archive:
            self.counts["already_have"] += 1
            return
        c.found_at = time.monotonic()
        c.status = "queued"
        self.candidates[c.key] = c
        self.counts["found"] += 1
        reason = reject_reason(c, self.s)
        if reason:
            self._skip(c, reason)
            return
        self._show(c)
        await self.score_q.put(c)
        if self.pool_count >= self.pool_target:
            self.scan_stop.set()

    def _skip(self, c: Candidate, reason: str) -> None:
        c.status = "skipped"
        c.reason = reason
        self.counts["skipped"] += 1
        self._show(c)

    # ------------------------------------------------------------ checking (scoring)

    async def _check_all(self) -> None:
        """Wait until every video found so far has a score."""
        self.phase = "checking"
        self._progress()
        last = 0.0
        while not (self.score_q.empty() and self._busy == 0) and not self.stop_event.is_set():
            if not self.quick and (time.monotonic() > self._deadline_check or self.finish_event.is_set()):
                self.quick = True
                left = self.score_q.qsize() + self._busy
                self.say(f"{'Finishing early' if self.finish_event.is_set() else 'Out of time'} — "
                         f"scoring the last {left} from their captions so every video still gets checked.",
                         "warn" if not self.finish_event.is_set() else "info")
            if time.monotonic() - last > 1:
                self._progress()
                last = time.monotonic()
            await asyncio.sleep(0.2)

    async def _score_worker(self) -> None:
        while True:
            c = await self.score_q.get()
            self._busy += 1
            try:
                wait = c.found_at + JUDGE_DELAY - time.monotonic()
                if wait > 0 and not self.quick:
                    await asyncio.sleep(wait)
                if not self.stop_event.is_set() and c.status == "queued":
                    await self._score(c)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one odd video never stalls the hunt
                log.warning("Couldn't check %s: %r", c.url, exc)
                verdict = await KeywordBrain().judge(self.s.description, self.s.keywords, c, None)
                self._scored(c, verdict.score, verdict.reason, quick=True)
            finally:
                self._busy -= 1
                self.score_q.task_done()

    async def _score(self, c: Candidate) -> None:
        s = self.s
        quick = self.quick
        c.status = "checking"
        self._show(c)
        if not quick and needs_probe(c, s):
            try:
                fill_from_info(c, await asyncio.to_thread(self.downloader.probe, c.url))
                c.maybe_not_video = False
            except DownloadError as exc:
                if "no video" in str(exc).lower():
                    if c.platform == "pinterest" and s.include_images and (c.image_url or c.thumbnail_url):
                        c.kind = "image"
                    else:
                        self._skip(c, "A photo post, not a video")
                        return
                else:
                    log.info("Couldn't read details of %s: %s", c.url, short_error(exc))
            reason = reject_reason(c, s)
            if reason:
                self._skip(c, reason)
                return

        image = None if quick else await self._thumbnail(c)
        brain = KeywordBrain() if quick else self.brain
        try:
            verdict = await brain.judge(s.description, s.keywords, c, image)
        except Exception as exc:  # noqa: BLE001 - AI crashed or timed out: don't stall the hunt
            log.warning("AI judge failed on %s: %r", c.url, exc)
            if not self._ai_failed_once:
                self._ai_failed_once = True
                self.say(f"The AI didn't answer ({exc}); scoring by keywords until it recovers.", "warn")
            verdict = await KeywordBrain().judge(s.description, s.keywords, c, image)
            quick = True
        if getattr(self.brain, "thinks", False) and not self._warned_thinking:
            self._warned_thinking = True
            self.say(f"“{self.brain.name}” thinks at length before answering, which makes checking slow. "
                     "An “-instruct” model (e.g. qwen3-vl:8b-instruct) is much faster.", "warn")
        self._scored(c, verdict.score, verdict.reason, quick=quick or isinstance(brain, KeywordBrain))

    def _scored(self, c: Candidate, score: int, reason: str, quick: bool) -> None:
        c.score, c.reason, c.quick = score, reason, quick
        c.status = "scored"
        self.counts["scored"] += 1
        self._show(c)

    async def _thumbnail(self, c: Candidate) -> bytes | None:
        url = c.thumbnail_url or (c.image_url if c.kind == "image" else None)
        if not url:
            return None
        raw = await fetch_image(url, referer=f"https://www.{c.platform}.com/")
        if not raw:
            return None
        jpeg = await asyncio.to_thread(self.downloader.to_jpeg, raw)
        if self.thumbs_dir is not None:
            name = f"{c.platform}_{safe_name(c.id, 40)}.jpg"
            try:
                self.thumbs_dir.mkdir(parents=True, exist_ok=True)
                (self.thumbs_dir / name).write_bytes(jpeg)
                c.thumb = name
            except OSError:
                pass
        return jpeg

    # ------------------------------------------------------------ downloading the best

    def ranked(self) -> list[Candidate]:
        """Every checked video that's still in the running, best first."""
        pool = [c for c in self.candidates.values()
                if c.status in ("scored", "picked", "notpicked") and (c.score or 0) >= self.s.min_score]
        return sorted(pool, key=lambda c: (-(c.score or 0), c.quick, -(c.views or c.likes or 0)))

    async def _download_best(self) -> None:
        self.phase = "downloading"
        need = self.s.target_count - self.counts["downloaded"]
        ranked = self.ranked()
        if not ranked:
            return
        self.say(f"Checked {self.counts['scored']} videos — saving the best {min(need, len(ranked))}.")
        for c in ranked[:need]:
            c.status = "picked"
            self._show(c)
        line = deque(ranked)

        async def worker() -> None:
            while (line and not self.stop_event.is_set()
                   and self.counts["downloaded"] + self.in_download < self.s.target_count):
                c = line.popleft()
                self.in_download += 1
                try:
                    await self._save(c)
                finally:
                    self.in_download -= 1
                    self._progress()

        self._progress()
        self._saved_now: list[Candidate] = []
        await asyncio.gather(*(worker() for _ in range(DOWNLOAD_WORKERS)))
        # Downloads finish in any order; the log lists them best first.
        ranked_saved = sorted(self._saved_now, key=lambda c: -(c.score or 0))
        for c in ranked_saved:
            self._logged += 1
            append_log(self.folder, c, rank=self._logged)
        for c in line:  # left in the running for a later round, but not picked this time
            if c.status == "picked":
                c.status = "scored"
                self._show(c)

    async def _save(self, c: Candidate) -> bool:
        s = self.s
        c.status = "downloading"
        self._show(c)
        try:
            if c.kind == "image":
                path = await asyncio.to_thread(self.downloader.download_image, c, self.folder, self.archive_path)
            else:
                try:
                    path = await asyncio.to_thread(
                        self.downloader.download, c, self.folder, self.archive_path, self.stop_event.is_set,
                        s.min_duration, s.max_duration,
                    )
                except NotAVideo:
                    if c.platform == "pinterest" and s.include_images and (c.image_url or c.thumbnail_url):
                        c.kind = "image"  # an image pin: save the picture itself
                        path = await asyncio.to_thread(
                            self.downloader.download_image, c, self.folder, self.archive_path)
                    else:
                        raise
        except NotAVideo as exc:
            log.info("Not saved %s: %s", c.url, exc)
            return self._fail(c, f"{exc} — replaced by the next best")
        except DownloadCancelled:
            return self._fail(c, "Stopped")
        except Exception as exc:  # noqa: BLE001 - one bad video never stops the hunt
            log.warning("Download failed for %s: %s", c.url, exc)
            return self._fail(c, f"Couldn't download: {short_error(exc)} — replaced by the next best")
        self.archive.add(c.archive_id)

        if s.watch_check and c.kind == "video" and getattr(self.brain, "can_see", False):
            c.status = "watching"
            self._show(c)
            frames = await asyncio.to_thread(self.downloader.extract_frames, path, c.duration)
            verdict = await self.brain.verify_frames(s.description or s.keywords, frames)
            if verdict.score < max(s.min_score, 30):
                path.unlink(missing_ok=True)
                return self._fail(c, f"Watch-check: {verdict.reason} — replaced by the next best")
            c.reason = f"{c.reason} · Watch-check {verdict.score}: {verdict.reason}"[:300]

        c.file = str(path)
        c.status = "downloaded"
        self.counts["downloaded"] += 1
        self._saved_now.append(c)
        self._show(c)
        return True

    def _fail(self, c: Candidate, reason: str) -> bool:
        c.status = "failed"
        c.reason = reason
        self.counts["failed"] += 1
        self._show(c)
        return False
