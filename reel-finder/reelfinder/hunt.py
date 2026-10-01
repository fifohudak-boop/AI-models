"""One hunt: plan searches → agents scroll → quick filters → AI judge → download.

Every stage is its own set of asyncio workers connected by queues, so agents keep
scrolling while the AI judges and yt-dlp downloads in parallel.
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

from .ai import KeywordBrain, pick_brain
from .config import MAX_AGENTS_PER_PLATFORM, PLATFORM_LABELS, HuntSettings
from .downloader import ARCHIVE_NAME, Downloader, append_log, fetch_image, fill_from_info, read_archive, safe_name
from .filters import needs_probe, reject_reason
from .models import Candidate
from .parsing import split_terms
from .scouts import SITES, Scout

log = logging.getLogger("reelfinder")

Emit = Callable[[str, Any], None]
ScoutFactory = Callable[..., Awaitable[Any]]

JUDGE_DELAY = 2.0  # let a link-only sighting pick up its JSON details before judging
MAX_BACKLOG_SHOWN = 400


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
    ):
        self.s = settings
        self._emit = emit
        self.browser = browser
        self.downloader = downloader or Downloader()
        self.brain_factory = brain_factory
        self.scout_factory = scout_factory or self._browser_scout
        self.thumbs_dir = thumbs_dir
        self.screen = screen
        self.site_urls = site_urls or {}
        self.scout_options = scout_options or {}

        self.stop_event = asyncio.Event()
        self.started = time.time()
        self.finished_reason = ""
        self.running = False
        self.brain = None
        self.base_folder = Path(settings.output_dir).expanduser()
        self.folder = self.base_folder / hunt_folder_name(settings) if settings.subfolder_per_hunt else self.base_folder
        self.archive_path = self.base_folder / ARCHIVE_NAME
        self.archive: set[str] = set()

        self.candidates: dict[str, Candidate] = {}
        self.recent: deque[str] = deque(maxlen=MAX_BACKLOG_SHOWN)
        self.agents: dict[int, dict] = {}
        self.plan: dict[str, list[str]] = {}
        self.logs: deque[dict] = deque(maxlen=60)
        self.counts = {"found": 0, "rejected": 0, "downloaded": 0, "failed": 0, "already_have": 0}
        self.in_download = 0
        self.judge_q: asyncio.Queue[Candidate] = asyncio.Queue()
        self.download_q: asyncio.Queue[Candidate] = asyncio.Queue()
        self._busy = 0
        self._pages: list = []
        self._ai_failed_once = False
        self._warned_thinking = False

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

    def progress(self) -> dict:
        return {
            **self.counts,
            "target": self.s.target_count,
            "queued": self.judge_q.qsize() if self.running else 0,
            "downloading": self.in_download,
            "elapsed": round(time.time() - self.started),
            "folder": str(self.folder),
            "brain": getattr(self.brain, "name", ""),
            "running": self.running,
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

    def stop(self, reason: str = "Stopped") -> None:
        if not self.stop_event.is_set():
            self.finished_reason = reason
            self.stop_event.set()

    async def run(self) -> None:
        self.running = True
        self._progress()
        tasks: list[asyncio.Task] = []
        try:
            await self._run(tasks)
        except Exception as exc:  # noqa: BLE001 - report anything unexpected in the UI
            log.exception("Hunt crashed")
            self.say(f"Something went wrong: {exc}", "warn")
            self.stop("Error")
        finally:
            self.stop(self.finished_reason or "Stopped")
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._close_pages()
            for c in self.candidates.values():
                if c.status in ("queued", "judging"):
                    c.status = "unchecked"
                    self._show(c)
            for agent in list(self.agents.values()):
                if agent["state"] not in ("login", "error", "done"):
                    self._agent_status({**agent, "state": "done", "note": "Hunt finished"})
            self.running = False
            self.say(f"Hunt finished — {self.finished_reason}. {self.counts['downloaded']} video(s) saved.")
            self._progress()
            self.emit("finished", self.progress())

    async def _run(self, tasks: list[asyncio.Task]) -> None:
        s = self.s
        self.folder.mkdir(parents=True, exist_ok=True)
        self.archive = read_archive(self.archive_path)
        log.info("Hunt settings: %s", s.model_dump(exclude={"output_dir"}))
        self.say(f"Saving to {self.folder}")

        self.brain, warning = await self.brain_factory(s.model)
        if warning:
            self.say(warning, "warn")
        self._progress()

        alloc = allocate_agents(list(s.platforms), s.agents)
        await self._make_plan(alloc)
        queues: dict[str, asyncio.Queue] = {}
        for platform, queries in self.plan.items():
            queues[platform] = asyncio.Queue()
            for q in queries:
                queues[platform].put_nowait(q)

        scouts = []
        agent_id = 0
        for platform, count in alloc.items():
            for _ in range(count):
                agent_id += 1
                scouts.append(await self.scout_factory(agent_id, platform, queues[platform]))
        if self.browser is not None and self._pages:
            await self.browser.tile(self._pages, *self.screen)
            logins = await self.browser.export_cookies()
            for platform in s.platforms:
                if not logins.get(platform):
                    hint = " Instagram search won't work until you do." if platform == "instagram" else ""
                    self.say(f"You're not logged in to {PLATFORM_LABELS[platform]} in the agents' browser "
                             f"(use Connect).{hint}", "warn")

        scout_tasks = [asyncio.create_task(sc.run()) for sc in scouts]
        for task in scout_tasks:
            task.add_done_callback(self._scout_ended)
        tasks += scout_tasks
        judges = 3 if isinstance(self.brain, KeywordBrain) else 2  # Ollama answers one at a time anyway
        tasks += [asyncio.create_task(self._judge_worker()) for _ in range(judges)]
        tasks += [asyncio.create_task(self._download_worker()) for _ in range(2)]

        deadline = time.monotonic() + s.time_limit_min * 60
        last_progress = 0.0
        while not self.stop_event.is_set():
            if all(t.done() for t in scout_tasks) and self._idle():
                self.stop("Searched everything planned")
                break
            if time.monotonic() > deadline:
                self.stop("Time limit reached")
                break
            if time.monotonic() - last_progress > 2:
                self._progress()
                last_progress = time.monotonic()
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                pass

    def _scout_ended(self, task: asyncio.Task) -> None:
        if not task.cancelled() and task.exception() is not None:
            log.error("Agent crashed", exc_info=task.exception())
            self.say(f"An agent stopped unexpectedly: {task.exception()}", "warn")

    def _target_covered(self) -> bool:
        return self.counts["downloaded"] + self.in_download >= self.s.target_count

    def _idle(self) -> bool:
        return self.judge_q.empty() and self.download_q.empty() and self._busy == 0

    async def _make_plan(self, alloc: dict[str, int]) -> None:
        s = self.s
        platforms = [p for p, n in alloc.items() if n > 0]
        per_platform = max(6, max(alloc.values(), default=1) * 3)
        user_terms = split_terms(s.keywords)
        self.say("Planning searches…")
        try:
            planned = await self.brain.plan_queries(s.description, s.keywords, platforms, per_platform)
        except Exception as exc:  # noqa: BLE001 - AI hiccup: plan from keywords instead
            self.say(f"The AI couldn't plan searches ({exc}); planning from your words instead.", "warn")
            planned = await KeywordBrain().plan_queries(s.description, s.keywords, platforms, per_platform)
        for p in platforms:
            seen: dict[str, str] = {}
            for q in user_terms + planned.get(p, []):
                seen.setdefault(q.lower(), q)
            queries = list(seen.values())
            if not queries:
                queries = (await KeywordBrain().plan_queries(s.description, s.keywords, [p], per_platform))[p]
            self.plan[p] = queries[: per_platform + len(user_terms)]
        self.emit("plan", self.plan)
        for p, qs in self.plan.items():
            self.say(f"{PLATFORM_LABELS[p]} searches: {', '.join(qs)}")

    # ------------------------------------------------------------ agents

    async def _browser_scout(self, agent_id: int, platform: str, queries: asyncio.Queue):
        page = await self.browser.new_page(headless=not self.s.show_browser)
        self._pages.append(page)
        site = SITES[platform](self.site_urls.get(platform))
        return Scout(
            agent_id, site, page, queries,
            on_found=self.on_found, on_status=self._agent_status, stop=self.stop_event,
            backlog=self.judge_q.qsize, **self.scout_options,
        )

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
        self.candidates[c.key] = c
        self.counts["found"] += 1
        reason = reject_reason(c, self.s)
        if reason:
            self._reject(c, reason)
            return
        c.status = "queued"
        self._show(c)
        await self.judge_q.put(c)

    def _reject(self, c: Candidate, reason: str) -> None:
        c.status = "rejected"
        c.reason = reason
        self.counts["rejected"] += 1
        self._show(c)

    # ------------------------------------------------------------ judging

    async def _judge_worker(self) -> None:
        while True:
            c = await self.judge_q.get()
            self._busy += 1
            try:
                wait = c.found_at + JUDGE_DELAY - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                # Don't judge more than we still need: pause while downloads could fill the target.
                while self._target_covered() and not self.stop_event.is_set():
                    await asyncio.sleep(0.3)
                if not self.stop_event.is_set():
                    await self._judge(c)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("Couldn't check %s: %r", c.url, exc)
                c.status, c.reason = "failed", f"Couldn't check: {exc}"[:200]
                self.counts["failed"] += 1
                self._show(c)
            finally:
                self._busy -= 1
                self.judge_q.task_done()

    async def _judge(self, c: Candidate) -> None:
        s = self.s
        c.status = "judging"
        self._show(c)
        if needs_probe(c, s):
            try:
                fill_from_info(c, await asyncio.to_thread(self.downloader.probe, c.url))
            except DownloadError as exc:
                msg = str(exc).lower()
                if c.maybe_not_video or "no video" in msg:
                    self._reject(c, "Not a video (photo post)")
                    return
                log.warning("Couldn't read details of %s: %s", c.url, exc)
            reason = reject_reason(c, s)
            if reason:
                self._reject(c, reason)
                return

        image = await self._thumbnail(c)
        self._show(c)
        by_keywords = isinstance(self.brain, KeywordBrain)
        try:
            verdict = await self.brain.judge(s.description, s.keywords, c, image)
        except Exception as exc:  # noqa: BLE001 - AI crashed or timed out: don't stall the hunt
            log.warning("AI judge failed on %s: %r", c.url, exc)
            if not self._ai_failed_once:
                self._ai_failed_once = True
                self.say(f"The AI didn't answer ({exc}); judging by keywords until it recovers.", "warn")
            verdict = await KeywordBrain().judge(s.description, s.keywords, c, image)
            by_keywords = True
        if getattr(self.brain, "thinks", False) and not self._warned_thinking:
            self._warned_thinking = True
            self.say(f"“{self.brain.name}” thinks at length before answering, which makes judging slow. "
                     "An “-instruct” model (e.g. qwen3-vl:8b-instruct) is much faster.", "warn")
        c.score, c.reason = verdict.score, verdict.reason
        # Word matching is cruder than the AI, so the same slider position asks a bit less of it.
        threshold = round(s.strictness * 0.7) if by_keywords else s.strictness
        if verdict.score < threshold:
            self._reject(c, verdict.reason or "Not a close enough match")
            return
        # Another judge may have filled the last slot while this one was thinking.
        while self._target_covered() and not self.stop_event.is_set():
            await asyncio.sleep(0.3)
        if self.stop_event.is_set():
            c.status = "spare"
            self._show(c)
            return
        c.status = "accepted"  # no await between the check above and this claim
        self.in_download += 1
        self._show(c)
        await self.download_q.put(c)

    async def _thumbnail(self, c: Candidate) -> bytes | None:
        if not c.thumbnail_url:
            return None
        raw = await fetch_image(c.thumbnail_url, referer=f"https://www.{c.platform}.com/")
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

    # ------------------------------------------------------------ downloading

    async def _download_worker(self) -> None:
        while True:
            c = await self.download_q.get()
            self._busy += 1
            try:
                if not self.stop_event.is_set():
                    await self._download(c)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one bad video never stops the hunt
                if not isinstance(exc, DownloadCancelled):
                    log.warning("Download failed for %s: %s", c.url, exc)
                c.status = "failed"
                c.reason = "Stopped" if isinstance(exc, DownloadCancelled) else f"Download failed: {exc}"[:220]
                self.counts["failed"] += 1
                self._show(c)
            finally:
                self.in_download -= 1
                self._busy -= 1
                self.download_q.task_done()
                self._progress()

    async def _download(self, c: Candidate) -> None:
        c.status = "downloading"
        self._show(c)
        path = await asyncio.to_thread(
            self.downloader.download, c, self.folder, self.archive_path, self.stop_event.is_set
        )
        self.archive.add(c.archive_id)
        if self.s.watch_check and getattr(self.brain, "can_see", False):
            c.status = "checking"
            self._show(c)
            frames = await asyncio.to_thread(self.downloader.extract_frames, path, c.duration)
            verdict = await self.brain.verify_frames(self.s.description or self.s.keywords, frames)
            if verdict.score < self.s.strictness:
                path.unlink(missing_ok=True)
                self._reject(c, f"Watch-check: {verdict.reason}")
                return
            c.reason = f"{c.reason} · Watch-check {verdict.score}: {verdict.reason}"[:300]
        c.file = str(path)
        c.status = "downloaded"
        self.counts["downloaded"] += 1
        append_log(self.folder, c)
        self._show(c)
        if self.counts["downloaded"] >= self.s.target_count:
            self.stop("Target reached")
