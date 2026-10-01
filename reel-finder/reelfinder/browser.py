"""The agents' browser: one saved Chrome profile shared by every agent and by yt-dlp."""

from __future__ import annotations

import asyncio
import math
import os
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

from .config import COOKIES_FILE, PROFILE_DIR

LOGIN_URLS = {
    "tiktok": "https://www.tiktok.com/login",
    "instagram": "https://www.instagram.com/accounts/login/",
}
COOKIE_DOMAINS = {"tiktok": "tiktok.com", "instagram": "instagram.com"}
SESSION_COOKIE = "sessionid"


def _cookie_domain_platform(domain: str) -> str | None:
    domain = domain.lstrip(".").lower()
    for platform, base in COOKIE_DOMAINS.items():
        if domain == base or domain.endswith("." + base):
            return platform
    return None


def write_netscape_cookies(cookies: list[dict], path: Path) -> int:
    """Write Playwright cookies for the supported sites in the cookies.txt format yt-dlp reads."""
    lines = ["# Netscape HTTP Cookie File", "# Written by Reel Finder for yt-dlp", ""]
    count = 0
    for c in cookies:
        domain = c.get("domain", "")
        if not _cookie_domain_platform(domain):
            continue
        expires = int(c.get("expires") or 0)
        prefix = "#HttpOnly_" if c.get("httpOnly") else ""
        lines.append("\t".join([
            prefix + domain,
            "TRUE" if domain.startswith(".") else "FALSE",
            c.get("path") or "/",
            "TRUE" if c.get("secure") else "FALSE",
            str(max(expires, 0)),
            c.get("name", ""),
            c.get("value", ""),
        ]))
        count += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return count


def logins_from_cookies(cookies: list[dict]) -> dict[str, bool]:
    now = time.time()
    state = {p: False for p in COOKIE_DOMAINS}
    for c in cookies:
        platform = _cookie_domain_platform(c.get("domain", ""))
        expires = c.get("expires") or -1
        if platform and c.get("name") == SESSION_COOKIE and c.get("value") and (expires < 0 or expires > now):
            state[platform] = True
    return state


def logins_from_profile(profile: Path = PROFILE_DIR) -> dict[str, bool]:
    """Read login state straight from Chrome's cookie DB (names aren't encrypted, values are)."""
    state = {p: False for p in COOKIE_DOMAINS}
    for rel in ("Default/Network/Cookies", "Default/Cookies"):
        db = profile / rel
        if not db.exists():
            continue
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "Cookies"
            try:
                shutil.copyfile(db, copy)
                con = sqlite3.connect(copy)
                rows = con.execute(
                    "SELECT host_key, expires_utc FROM cookies WHERE name = ?", (SESSION_COOKIE,)
                ).fetchall()
                con.close()
            except (OSError, sqlite3.Error):
                continue
        now_chrome = (time.time() + 11644473600) * 1_000_000  # Chrome counts from 1601
        for host, expires in rows:
            platform = _cookie_domain_platform(host)
            if platform and (not expires or expires > now_chrome):
                state[platform] = True
        break
    return state


def profile_pids(profile: Path) -> list[int]:
    """Browser processes using our private profile (matched by its unique path, so never yours)."""
    marker = f"--user-data-dir={profile}"
    try:
        out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in out.splitlines():
        pid, _, command = line.strip().partition(" ")
        if marker in command and pid.isdigit() and int(pid) != os.getpid():
            pids.append(int(pid))
    return pids


async def clear_profile_orphans(profile: Path) -> bool:
    """Close a browser left over from a crashed run so the profile can be opened again."""
    pids = profile_pids(profile)
    if not pids:
        return False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        for _ in range(16):
            await asyncio.sleep(0.25)
            pids = profile_pids(profile)
            if not pids:
                return True
    return True


class BrowserManager:
    def __init__(self, profile_dir: Path = PROFILE_DIR, cookies_file: Path = COOKIES_FILE):
        self.profile_dir = profile_dir
        self.cookies_file = cookies_file
        self.executable_path = os.environ.get("REELFINDER_BROWSER_PATH")
        self.context = None
        self.headless: bool | None = None
        self._pw = None
        self._lock = asyncio.Lock()
        self._claimed: list = []  # pages already handed to an agent or a login
        self.browser_name: str | None = None

    @property
    def running(self) -> bool:
        return self.context is not None

    async def get_context(self, headless: bool):
        async with self._lock:
            if self.context is not None and self.headless != headless:
                await self._close()
            if self.context is None:
                await self._launch(headless)
            return self.context

    async def _launch(self, headless: bool) -> None:
        from playwright.async_api import async_playwright

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        if self._pw is not None:  # left over from a window you closed
            await self._pw.stop()
        self._pw = await async_playwright().start()
        options = {
            "user_data_dir": str(self.profile_dir),
            "headless": headless,
            "locale": "en-US",
            "ignore_default_args": ["--enable-automation"],
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        if headless:
            options["viewport"] = {"width": 1280, "height": 900}
        else:
            options["no_viewport"] = True  # pages follow their window size (we tile the windows)
        # Prefer the real Google Chrome (looks like a normal visitor); fall back to bundled Chromium.
        attempts = [{"executable_path": self.executable_path}] if self.executable_path else [{"channel": "chrome"}, {}]
        error: Exception | None = None
        for extra in attempts:
            for _ in range(2):
                try:
                    self.context = await self._pw.chromium.launch_persistent_context(**options, **extra)
                    break
                except Exception as exc:  # noqa: BLE001 - try again / try the next browser
                    error = exc
                    # A browser left over from a crashed run still holds the profile: close it, retry once.
                    if not await clear_profile_orphans(self.profile_dir):
                        break
            if self.context is not None:
                self.browser_name = (
                    "Google Chrome" if extra.get("channel") == "chrome"
                    else extra.get("executable_path") or "Chromium (bundled with Playwright)"
                )
                break
        if self.context is None:
            await self._pw.stop()
            self._pw = None
            raise RuntimeError(
                "Couldn't start the agents' browser. Install Google Chrome, or run "
                "`.venv/bin/python -m playwright install chromium`."
            ) from error
        self.headless = headless
        await self.context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        ctx = self.context
        ctx.on("close", lambda _c: self._forget(ctx))  # e.g. you closed the browser window

    def _forget(self, ctx) -> None:
        if self.context is ctx:
            self.context = None

    async def _close(self) -> None:
        ctx, pw = self.context, self._pw
        self.context, self._pw = None, None
        if ctx is not None:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001 - already closed by the user
                pass
        if pw is not None:
            await pw.stop()

    async def close(self) -> None:
        async with self._lock:
            await self._close()

    async def new_page(self, headless: bool):
        context = await self.get_context(headless)
        self._claimed = [p for p in self._claimed if not p.is_closed()]
        free = [p for p in context.pages if p.url in ("about:blank", "") and p not in self._claimed]
        if free:  # the blank window Chrome opens at launch
            page = free[0]
        elif headless or not context.pages:
            page = await context.new_page()
        else:
            # New pages would stack up as tabs in one window; give each agent its own window
            # so they can be tiled side by side and you can watch them all.
            async with context.expect_page() as info:
                await context.pages[0].evaluate(
                    "() => { window.open('about:blank', '_blank', 'popup,width=640,height=820'); }"
                )
            page = await info.value
        self._claimed.append(page)
        return page

    async def export_cookies(self) -> dict[str, bool]:
        if self.context is None:
            return logins_from_profile(self.profile_dir)
        cookies = await self.context.cookies()
        write_netscape_cookies(cookies, self.cookies_file)
        return logins_from_cookies(cookies)

    async def logins(self) -> dict[str, bool]:
        if self.context is not None:
            try:
                return logins_from_cookies(await self.context.cookies())
            except Exception:  # noqa: BLE001 - browser closing
                pass
        return logins_from_profile(self.profile_dir)

    async def open_login(self, platform: str) -> None:
        if self.context is not None and self.headless:
            await self.close()
        page = await self.new_page(headless=False)
        await page.goto(LOGIN_URLS[platform], wait_until="domcontentloaded")
        await page.bring_to_front()

    async def tile(self, pages: list, screen_w: int = 1440, screen_h: int = 900) -> None:
        """Arrange visible agent windows in a grid so you can watch them all scroll."""
        if self.headless or not pages:
            return
        n = len(pages)
        cols = n if n <= 3 else math.ceil(n / 2)  # 1-3 side by side, then two rows
        rows = math.ceil(n / cols)
        w, h = max(screen_w // cols, 420), max((screen_h - 40) // rows, 400)
        for i, page in enumerate(pages):
            try:
                cdp = await page.context.new_cdp_session(page)
                win = await cdp.send("Browser.getWindowForTarget")
                await cdp.send("Browser.setWindowBounds", {
                    "windowId": win["windowId"],
                    "bounds": {"left": (i % cols) * w, "top": 25 + (i // cols) * h, "width": w, "height": h,
                               "windowState": "normal"},
                })
                await cdp.detach()
            except Exception:  # noqa: BLE001 - tiling is cosmetic
                pass
