"""The local web server behind the Reel Finder page (only reachable from this computer)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .ai import model_installed, ollama_models, sees_images
from .browser import LOGIN_URLS, BrowserManager
from .config import (
    COOKIES_FILE, LOG_DIR, LOG_FILE, OLLAMA_HOST, PLATFORM_LABELS, PLATFORMS, THUMBS_DIR, WEB_DIR,
    HuntSettings, load_settings, save_settings,
)
from .downloader import Downloader, NotAVideo, find_ffmpeg, safe_name
from .events import EventBus
from .hunt import Hunt, short_error, validate
from .logs import diagnostics, tail
from .models import Candidate
from .selftest import SelfTest

log = logging.getLogger("reelfinder")

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
# For testing against a stand-in site, e.g. REELFINDER_SITE_TIKTOK=http://127.0.0.1:9000
SITE_OVERRIDES = {
    p: os.environ[f"REELFINDER_SITE_{p.upper()}"] for p in PLATFORMS if os.environ.get(f"REELFINDER_SITE_{p.upper()}")
}


class AppState:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.bus = EventBus()
        self.browser = BrowserManager()
        self.hunt: Hunt | None = None
        self.hunt_task: asyncio.Task | None = None
        self.pull_task: asyncio.Task | None = None
        self.selftests: dict[str, SelfTest] = {}
        self.selftest_task: asyncio.Task | None = None
        self.link_tasks: set[asyncio.Task] = set()

    @property
    def hunting(self) -> bool:
        return self.hunt is not None and self.hunt.running

    @property
    def testing(self) -> bool:
        return self.selftest_task is not None and not self.selftest_task.done()


state = AppState()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    yield
    if state.hunt:
        state.hunt.stop("Reel Finder closed")
    if state.hunt_task:
        await asyncio.gather(state.hunt_task, return_exceptions=True)
    if state.testing:
        state.selftest_task.cancel()
        await asyncio.gather(state.selftest_task, return_exceptions=True)
    await state.browser.close()


app = FastAPI(title="Reel Finder", lifespan=lifespan)


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Block DNS-rebinding and other websites poking this local server from your browser.
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if host not in ALLOWED_HOSTS:
        return JSONResponse({"error": "Reel Finder only answers on localhost."}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-reel-finder") != "1":
        return JSONResponse({"error": "Missing X-Reel-Finder header."}, status_code=403)
    return await call_next(request)


# ---------------------------------------------------------------- settings & status

@app.get("/api/settings")
async def get_settings() -> HuntSettings:
    return state.settings


@app.put("/api/settings")
async def put_settings(settings: HuntSettings) -> HuntSettings:
    state.settings = settings
    save_settings(settings)
    return settings


@app.get("/api/status")
async def status() -> dict:
    models = await ollama_models()
    model = state.settings.model
    return {
        "version": __version__,
        "os": sys.platform,
        "ollama": {
            "running": models is not None,
            "models": [{"name": m, "vision": sees_images(m)} for m in (models or [])],
            "model": model,
            "installed": bool(models) and model_installed(model, models or []),
            "vision": sees_images(model),
            "pulling": state.pull_task is not None and not state.pull_task.done(),
        },
        "ffmpeg": find_ffmpeg() is not None,
        "logins": await state.browser.logins(),
        "browser_open": state.browser.running,
        "hunting": state.hunting,
        "testing": state.testing,
    }


# ---------------------------------------------------------------- folders

def _pick_folder_blocking(current: str) -> str | None:
    if sys.platform == "darwin":
        default = f' default location (POSIX file "{current}")' if current and Path(current).is_dir() else ""
        script = f'POSIX path of (choose folder with prompt "Where should Reel Finder save videos?"{default})'
        proc = subprocess.run(["osascript", "-e", "activate", "-e", script], capture_output=True, text=True)
        return (proc.stdout.strip() or None) if proc.returncode == 0 else None
    try:
        import tkinter
        from tkinter import filedialog

        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(initialdir=current or str(Path.home()))
        root.destroy()
        return chosen or None
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(501, "No folder picker on this system — type the folder path instead.") from exc


@app.post("/api/pick-folder")
async def pick_folder() -> dict:
    current = str(Path(state.settings.output_dir).expanduser())
    chosen = await asyncio.to_thread(_pick_folder_blocking, current)
    return {"path": chosen.rstrip("/") if chosen and chosen != "/" else chosen}


class FolderBody(BaseModel):
    path: str | None = None


@app.post("/api/open-folder")
async def open_folder(body: FolderBody) -> dict:
    target = Path(body.path or state.settings.output_dir).expanduser()
    if state.hunt and not body.path:
        target = state.hunt.folder if state.hunt.folder.exists() else target
    target.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    elif sys.platform.startswith("win"):
        os.startfile(str(target))  # type: ignore[attr-defined]  # noqa: S606
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(target)])
    return {"path": str(target)}


# ---------------------------------------------------------------- accounts

@app.post("/api/login/{platform}")
async def login(platform: str) -> dict:
    if platform not in LOGIN_URLS:
        raise HTTPException(404, "Unknown platform")
    if (state.hunting or state.testing) and state.browser.headless:
        raise HTTPException(409, "Wait for the hunt or self-test to finish (the agents are running hidden).")
    try:
        await state.browser.open_login(platform)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc)) from exc
    return {"ok": True}


@app.post("/api/browser/close")
async def close_browser() -> dict:
    if state.hunting or state.testing:
        raise HTTPException(409, "A hunt or self-test is using the browser.")
    if state.browser.running:
        await state.browser.export_cookies()
    await state.browser.close()
    return {"ok": True}


# ---------------------------------------------------------------- AI model

class PullBody(BaseModel):
    model: str


async def _pull_model(model: str) -> None:
    last = -1
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{OLLAMA_HOST}/api/pull", json={"model": model}) as resp:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    if data.get("error"):
                        state.bus.emit("model_pull", {"model": model, "error": data["error"]})
                        return
                    total, done = data.get("total") or 0, data.get("completed") or 0
                    pct = int(100 * done / total) if total else None
                    if pct != last:
                        last = pct
                        state.bus.emit("model_pull", {"model": model, "status": data.get("status", ""), "percent": pct})
        state.bus.emit("model_pull", {"model": model, "status": "success", "percent": 100, "done": True})
    except (httpx.HTTPError, ValueError) as exc:
        state.bus.emit("model_pull", {"model": model, "error": f"Couldn't reach Ollama: {exc}"})


@app.post("/api/ollama/pull")
async def pull_model(body: PullBody) -> dict:
    if state.pull_task and not state.pull_task.done():
        raise HTTPException(409, "Already downloading a model.")
    state.pull_task = asyncio.create_task(_pull_model(body.model.strip()))
    return {"ok": True}


# ---------------------------------------------------------------- hunting

class StartBody(BaseModel):
    settings: HuntSettings
    screen_w: int = 1440
    screen_h: int = 900


@app.post("/api/hunt/start")
async def start_hunt(body: StartBody) -> dict:
    if state.hunting:
        raise HTTPException(409, "A hunt is already running.")
    if state.testing:
        raise HTTPException(409, "Wait for the self-test to finish.")
    settings = body.settings
    state.settings = settings
    save_settings(settings)
    problem = validate(settings)
    if problem:
        raise HTTPException(400, problem)
    shutil.rmtree(THUMBS_DIR, ignore_errors=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    state.hunt = Hunt(
        settings,
        state.bus.emit,
        browser=state.browser,
        downloader=Downloader(COOKIES_FILE),
        thumbs_dir=THUMBS_DIR,
        screen=(max(body.screen_w, 800), max(body.screen_h, 600)),
        site_urls=SITE_OVERRIDES,
    )
    state.hunt_task = asyncio.create_task(_run_hunt(state.hunt))
    return {"ok": True, "folder": str(state.hunt.folder)}


async def _release_browser() -> None:
    """Don't leave agent windows behind; your logins stay saved in the profile."""
    try:
        if state.browser.running:
            await state.browser.export_cookies()
    finally:
        await state.browser.close()


async def _run_hunt(hunt: Hunt) -> None:
    try:
        await hunt.run()
    finally:
        await _release_browser()


@app.post("/api/hunt/finish")
async def finish_hunt() -> dict:
    """Stop searching and save the best videos found so far."""
    if state.hunt:
        state.hunt.finish()
    return {"ok": True}


@app.post("/api/hunt/stop")
async def stop_hunt() -> dict:
    """Stop everything right now."""
    if state.hunt:
        state.hunt.stop("Stopped by you")
    return {"ok": True}


# ---------------------------------------------------------------- save a single link

class LinkBody(BaseModel):
    url: str


@app.post("/api/save-link")
async def save_link(body: LinkBody) -> dict:
    url = body.url.strip()
    if not re.match(r"^https?://\S+$", url):
        raise HTTPException(400, "Paste a full link that starts with https://")
    task = asyncio.create_task(_save_link(url))
    state.link_tasks.add(task)
    task.add_done_callback(state.link_tasks.discard)
    return {"ok": True}


async def _save_link(url: str) -> None:
    """Download one video from a link (TikTok, Instagram, Pinterest, YouTube…) as a playable MP4."""
    state.bus.emit("link", {"url": url, "status": "working"})
    folder = Path(state.settings.output_dir).expanduser() / "Saved links"
    downloader = Downloader(COOKIES_FILE)
    try:
        info = await asyncio.to_thread(downloader.probe, url)
        if info.get("_type") == "playlist":
            raise NotAVideo("That's a playlist or profile — paste the link of one video")
        platform = safe_name((info.get("extractor_key") or "link").lower(), 20)
        cand = Candidate(platform=platform, id=str(info.get("id") or abs(hash(url))), url=info.get("webpage_url") or url,
                         author=info.get("uploader") or info.get("channel") or "")
        path = await asyncio.to_thread(downloader.download, cand, folder, None)
        media = await asyncio.to_thread(downloader.inspect, path)
        log.info("Saved link %s → %s (%s)", url, path, media.summary())
        state.bus.emit("link", {"url": url, "status": "done", "file": str(path), "folder": str(folder),
                                "summary": media.summary()})
    except Exception as exc:  # noqa: BLE001 - tell the page what went wrong
        log.warning("Couldn't save link %s: %s", url, exc)
        state.bus.emit("link", {"url": url, "status": "failed", "error": short_error(exc)})


# ---------------------------------------------------------------- self-test & report

class SelfTestBody(BaseModel):
    settings: HuntSettings | None = None


@app.post("/api/selftest/{platform}")
async def start_selftest(platform: str, body: SelfTestBody | None = None) -> dict:
    if platform not in PLATFORMS:
        raise HTTPException(404, "Unknown platform")
    if state.hunting:
        raise HTTPException(409, "Stop the hunt first — the self-test needs the agents' browser.")
    if state.testing:
        raise HTTPException(409, "A self-test is already running.")
    settings = body.settings if body and body.settings else state.settings
    test = SelfTest(platform, settings, state.bus.emit, browser=state.browser,
                    downloader=Downloader(COOKIES_FILE), site_url=SITE_OVERRIDES.get(platform))
    state.selftests[platform] = test
    state.selftest_task = asyncio.create_task(_run_selftest(test))
    return {"ok": True, "query": test.query}


async def _run_selftest(test: SelfTest) -> None:
    try:
        await test.run()
    finally:
        await _release_browser()


async def build_report() -> str:
    lines = [f"Reel Finder report — {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    for key, value in diagnostics(state.browser.browser_name).items():
        lines.append(f"{key}: {value}")
    models = await ollama_models()
    if models is None:
        lines.append("Ollama: not running")
    else:
        lines.append(f"Ollama: running · models: {', '.join(models) or 'none'}")
    lines.append(f"Chosen AI model: {state.settings.model}")
    logins = await state.browser.logins()
    lines.append("Logged in: " + ", ".join(f"{PLATFORM_LABELS[p]} {'yes' if ok else 'no'}" for p, ok in logins.items()))
    lines.append("")
    for platform in PLATFORMS:
        test = state.selftests.get(platform)
        lines.append(test.summary() if test else f"{PLATFORM_LABELS[platform]} self-test: not run yet")
        lines.append("")
    lines.append("--- Last 300 log lines ---")
    lines.append(tail(300, LOG_FILE).rstrip())
    return "\n".join(lines) + "\n"


@app.get("/api/report", response_class=PlainTextResponse)
async def report() -> str:
    return await build_report()


@app.post("/api/open-log")
async def open_log() -> dict:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        target = LOG_FILE if LOG_FILE.exists() else LOG_DIR
        subprocess.Popen(["open", "-R", str(target)] if target == LOG_FILE else ["open", str(target)])
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(LOG_DIR)])
    return {"path": str(LOG_FILE)}


@app.websocket("/ws")
async def events(ws: WebSocket) -> None:
    origin_host = (ws.headers.get("origin") or "").split("://")[-1].rsplit(":", 1)[0]
    if origin_host and origin_host not in ALLOWED_HOSTS:
        await ws.close(code=1008)
        return
    await ws.accept()
    queue = state.bus.subscribe()

    async def forward() -> None:
        await ws.send_json({"type": "snapshot", "data": state.hunt.snapshot() if state.hunt else None})
        for test in state.selftests.values():  # a refreshed page still shows the last results
            await ws.send_json({"type": "selftest", "data": test.state()})
        while True:
            await ws.send_json(await queue.get())

    sender = asyncio.create_task(forward())
    try:
        # Reading is what notices a closed tab; without it this handler would wait forever
        # and keep Reel Finder from quitting.
        while True:
            await ws.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sender.cancel()
        state.bus.unsubscribe(queue)


THUMBS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/thumbs", StaticFiles(directory=THUMBS_DIR), name="thumbs")
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
