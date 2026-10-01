"""The local web server behind the Reel Finder page (only reachable from this computer)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .ai import model_installed, ollama_models, sees_images
from .browser import LOGIN_URLS, BrowserManager
from .config import COOKIES_FILE, OLLAMA_HOST, THUMBS_DIR, WEB_DIR, HuntSettings, load_settings, save_settings
from .downloader import Downloader, find_ffmpeg
from .events import EventBus
from .hunt import Hunt, validate

log = logging.getLogger("reelfinder")

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
# For testing against a stand-in site, e.g. REELFINDER_SITE_TIKTOK=http://127.0.0.1:9000
SITE_OVERRIDES = {
    p: os.environ[f"REELFINDER_SITE_{p.upper()}"] for p in ("tiktok", "instagram") if os.environ.get(f"REELFINDER_SITE_{p.upper()}")
}


class AppState:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.bus = EventBus()
        self.browser = BrowserManager()
        self.hunt: Hunt | None = None
        self.hunt_task: asyncio.Task | None = None
        self.pull_task: asyncio.Task | None = None

    @property
    def hunting(self) -> bool:
        return self.hunt is not None and self.hunt.running


state = AppState()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    yield
    if state.hunt:
        state.hunt.stop("Reel Finder closed")
    if state.hunt_task:
        await asyncio.gather(state.hunt_task, return_exceptions=True)
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
    if state.hunting and state.browser.headless:
        raise HTTPException(409, "Stop the hunt first (the agents are running hidden).")
    try:
        await state.browser.open_login(platform)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc)) from exc
    return {"ok": True}


@app.post("/api/browser/close")
async def close_browser() -> dict:
    if state.hunting:
        raise HTTPException(409, "A hunt is using the browser.")
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


async def _run_hunt(hunt: Hunt) -> None:
    try:
        await hunt.run()
    finally:
        # Don't leave agent windows behind; your logins stay saved in the profile.
        try:
            if state.browser.running:
                await state.browser.export_cookies()
        finally:
            await state.browser.close()


@app.post("/api/hunt/stop")
async def stop_hunt() -> dict:
    if state.hunt:
        state.hunt.stop("Stopped by you")
    return {"ok": True}


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
