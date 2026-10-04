"""Scout agents: each one drives a browser window, scrolls search results and reports videos.

Videos are picked up two ways so a site redesign rarely breaks both at once:
1. the JSON the site's own app downloads while scrolling (rich: caption, views, cover…)
2. video links on the page (always there, fewer details — yt-dlp fills them in later)
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from urllib.parse import quote

from .models import Candidate
from .parsing import PARSERS

LINKS_JS = """
els => els.map(a => {
  const img = a.querySelector('img');
  return { href: a.getAttribute('href') || '', alt: img ? (img.getAttribute('alt') || '') : '',
           src: img ? (img.currentSrc || img.src || '') : '',
           text: (a.innerText || '').slice(0, 300) };
})
"""

CAPTCHA_SELECTORS = (
    "#captcha-verify-container-main-page, .captcha-verify-container, #captcha_container, "
    "[class*='captcha_verify'], [class*='captcha-verify'], iframe[src*='captcha'], "
    "iframe[title*='challenge' i], #px-captcha"
)


class Site:
    platform: str = ""
    base_url: str = ""
    link_selector: str = "a[href]"

    def __init__(self, base_url: str | None = None, include_images: bool = False):
        self.real_base = type(self).base_url
        self.include_images = include_images
        if base_url:
            self.base_url = base_url.rstrip("/")

    def keep(self, cand: Candidate) -> bool:
        """Whether this sighting belongs in the hunt (images only when you asked for them)."""
        return cand.kind == "video" or self.include_images

    def canonical(self, url: str) -> str:
        """Parsers build real-site links; point them at a stand-in site when testing."""
        if self.base_url != self.real_base and url.startswith(self.real_base):
            return self.base_url + url[len(self.real_base):]
        return url

    def search_url(self, query: str) -> str:
        raise NotImplementedError

    def wants_response(self, url: str, content_type: str) -> bool:
        return "json" in content_type or "/api/" in url or "graphql" in url

    def needs_login(self, page_url: str) -> bool:
        return False


class TikTok(Site):
    platform = "tiktok"
    base_url = "https://www.tiktok.com"
    link_selector = "a[href*='/video/']"

    def search_url(self, query: str) -> str:
        q = query.strip()
        if q.startswith("#") and " " not in q:
            return f"{self.base_url}/tag/{quote(q[1:])}"
        return f"{self.base_url}/search/video?q={quote(q)}"

    def wants_response(self, url: str, content_type: str) -> bool:
        # Search and hashtag results only — not the "recommended" feeds TikTok also loads.
        return "/api/" in url and ("search" in url or "challenge" in url) and "json" in content_type


class Instagram(Site):
    platform = "instagram"
    base_url = "https://www.instagram.com"
    link_selector = "a[href*='/reel/'], a[href*='/reels/'], a[href*='/p/']"

    def search_url(self, query: str) -> str:
        # Instagram folded hashtag pages into keyword search; "#tag" works as a query.
        return f"{self.base_url}/explore/search/keyword/?q={quote(query.strip())}"

    def wants_response(self, url: str, content_type: str) -> bool:
        return ("/api/" in url or "graphql" in url) and "json" in content_type

    def needs_login(self, page_url: str) -> bool:
        return "/accounts/login" in page_url or "/challenge/" in page_url


class Pinterest(Site):
    platform = "pinterest"
    base_url = "https://www.pinterest.com"
    link_selector = "a[href*='/pin/']"

    def search_url(self, query: str) -> str:
        # The "videos" tab when you only want videos; all pins when images count too.
        scope = "pins" if self.include_images else "videos"
        return f"{self.base_url}/search/{scope}/?q={quote(query.strip().lstrip('#'))}&rs=typed"

    def wants_response(self, url: str, content_type: str) -> bool:
        return ("/resource/" in url or "graphql" in url) and "json" in content_type

    def needs_login(self, page_url: str) -> bool:
        return "/login" in page_url


SITES: dict[str, type[Site]] = {"tiktok": TikTok, "instagram": Instagram, "pinterest": Pinterest}


class Scout:
    """One agent = one browser window working through a shared queue of search queries."""

    def __init__(
        self,
        agent_id: int,
        site: Site,
        page,
        queries: asyncio.Queue,
        on_found: Callable[[Candidate], Awaitable[None]],
        on_status: Callable[[dict], None],
        stop: asyncio.Event,
        max_scrolls: int = 40,
        patience: int = 5,
        pace: tuple[float, float] = (1.2, 3.2),
    ):
        self.id = agent_id
        self.site = site
        self.page = page
        self.queries = queries
        self.on_found = on_found
        self.on_status = on_status
        self.stop = stop
        self.max_scrolls = max_scrolls
        self.patience = patience
        self.pace = pace
        self.query = ""
        self.found = 0
        self.scrolls = 0
        self._seen: set[str] = set()
        self._fresh = 0
        self._tasks: set[asyncio.Task] = set()
        self._json_parser, self._link_parser = PARSERS[site.platform]
        page.on("response", self._on_response)

    def status(self, state: str, note: str = "") -> None:
        self.on_status({
            "id": self.id, "platform": self.site.platform, "query": self.query,
            "state": state, "note": note, "found": self.found, "scrolls": self.scrolls,
        })

    def _on_response(self, response) -> None:
        try:
            ctype = response.headers.get("content-type", "")
        except Exception:  # noqa: BLE001
            return
        if self.site.wants_response(response.url, ctype):
            task = asyncio.ensure_future(self._read_response(response))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _read_response(self, response) -> None:
        try:
            data = await response.json()
        except Exception:  # noqa: BLE001 - not JSON / body gone
            return
        await self._report(self._json_parser(data))

    async def _report(self, candidates: list[Candidate]) -> None:
        for cand in candidates:
            if self.stop.is_set():
                return
            if not self.site.keep(cand):
                continue
            first_time = cand.key not in self._seen
            self._seen.add(cand.key)
            cand.query, cand.agent = self.query, self.id
            cand.url = self.site.canonical(cand.url)
            if first_time:
                self.found += 1
                self._fresh += 1
            await self.on_found(cand)  # the hunt merges repeat sightings (e.g. link then JSON)

    async def _collect_links(self) -> None:
        try:
            links = await self.page.eval_on_selector_all(self.site.link_selector, LINKS_JS)
        except Exception:  # noqa: BLE001 - page navigating
            return
        # Links already on the page were reported on an earlier pass; only new ones matter.
        await self._report([c for c in self._link_parser(links) if c.key not in self._seen])

    async def _sleep(self, low: float, high: float) -> None:
        try:
            await asyncio.wait_for(self.stop.wait(), timeout=random.uniform(low, high))
        except asyncio.TimeoutError:
            pass

    async def _blocked_by_captcha(self) -> bool:
        try:
            return await self.page.locator(CAPTCHA_SELECTORS).count() > 0
        except Exception:  # noqa: BLE001
            return False

    async def _wait_out_captcha(self) -> bool:
        """Pause until you solve the captcha in the agent window (up to 5 minutes)."""
        self.status("captcha", "Solve the captcha in this agent's window — it will continue by itself")
        for _ in range(150):
            if self.stop.is_set():
                return False
            await self._sleep(2, 2)
            if not await self._blocked_by_captcha():
                self.status("scrolling")
                return True
        return False

    async def _scroll_once(self) -> None:
        try:
            size = self.page.viewport_size or await self.page.evaluate(
                "() => ({width: window.innerWidth, height: window.innerHeight})"
            )
            await self.page.mouse.move(size["width"] / 2 + random.randint(-80, 80), size["height"] / 2)
            await self.page.mouse.wheel(0, random.randint(700, 1400))
        except Exception:  # noqa: BLE001 - fall back to a JS scroll
            try:
                await self.page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.9))")
            except Exception:  # noqa: BLE001
                pass

    async def work_query(self, query: str) -> str:
        """Scroll one search until it stops producing new videos. Returns why it ended."""
        self.query = query
        self.scrolls = 0
        self.status("opening")
        try:
            await self.page.goto(self.site.search_url(query), wait_until="domcontentloaded", timeout=45_000)
        except Exception as exc:  # noqa: BLE001
            self.status("error", f"Couldn't open the search page: {str(exc)[:120]}")
            return "error"
        await self._sleep(2.0, 4.0)
        if self.site.needs_login(self.page.url):
            label = self.site.platform.capitalize()
            self.status("login", f"Log in first (Connect button) — {label} sent this agent to its login page")
            return "login"
        self.status("scrolling")
        idle = 0
        while not self.stop.is_set() and self.scrolls < self.max_scrolls and idle < self.patience:
            if await self._blocked_by_captcha() and not await self._wait_out_captcha():
                return "captcha"
            self._fresh = 0
            await self._collect_links()
            await self._scroll_once()
            self.scrolls += 1
            await self._sleep(*self.pace)
            await self._collect_links()
            idle = 0 if self._fresh else idle + 1
            self.status("scrolling")
        return "stopped" if self.stop.is_set() else "exhausted"

    async def run(self) -> None:
        while not self.stop.is_set():
            try:
                query = self.queries.get_nowait()
            except asyncio.QueueEmpty:
                self.status("done", "Out of searches")
                return
            result = await self.work_query(query)
            if result in ("login", "captcha"):
                return  # its status already says what you need to do
            if result != "stopped":
                await self._sleep(1.0, 2.5)
