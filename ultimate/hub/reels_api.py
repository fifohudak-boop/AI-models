"""Reel Finder inside Ultimate: the same engine as the Reel Finder app (copied into hub/reels),
with one space per model — its own references, search settings and "Found videos" folder.

The agents' browser (and your TikTok/Instagram/Pinterest logins in it) is shared by all models,
so one hunt or self-test runs at a time.
"""

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
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from . import __version__, library, personas
from .config import REEL_FINDER_HOME
from .events import bus
from .reels.ai import model_installed, ollama_models, pick_brain, sees_images
from .reels.browser import LOGIN_URLS, BrowserManager
from .reels.config import (
    COOKIES_FILE, LOG_DIR, LOG_FILE, OLLAMA_HOST, PLATFORM_LABELS, PLATFORMS, PROFILE_DIR, THUMBS_DIR, HuntSettings,
    migrate,
)
from .reels.downloader import Downloader, NotAVideo, find_ffmpeg, safe_name
from .reels.hunt import Hunt, short_error, validate
from .reels.logs import diagnostics, tail
from .reels.models import Candidate
from .reels.references import MAX_REFERENCES, MAX_UPLOAD_BYTES, Analyzer, ReferenceStore, reference_summary, valid_id
from .reels.selftest import SelfTest
from .reels.similarity import Vision, vision

log = logging.getLogger("reelfinder")
router = APIRouter()

# For testing against a stand-in site, e.g. REELFINDER_SITE_TIKTOK=http://127.0.0.1:9000
SITE_OVERRIDES = {
    p: os.environ[f"REELFINDER_SITE_{p.upper()}"] for p in PLATFORMS if os.environ.get(f"REELFINDER_SITE_{p.upper()}")
}


class ReelsState:
    def __init__(self) -> None:
        self.browser = BrowserManager()
        self.hunt: Hunt | None = None
        self.hunt_model: str | None = None
        self.hunt_task: asyncio.Task | None = None
        self.last_hunts: dict[str, Hunt] = {}  # each model's latest hunt, so its results stay on its page
        self.pull_task: asyncio.Task | None = None
        self.selftests: dict[str, SelfTest] = {}
        self.selftest_task: asyncio.Task | None = None
        self.tasks: set[asyncio.Task] = set()
        self._stores: dict[str, ReferenceStore] = {}

    @property
    def hunting(self) -> bool:
        return self.hunt is not None and self.hunt.running

    @property
    def testing(self) -> bool:
        return self.selftest_task is not None and not self.selftest_task.done()

    def references(self, model_id: str) -> ReferenceStore:
        if model_id not in self._stores:
            self._stores[model_id] = ReferenceStore(personas.data_dir(model_id) / "references")
        return self._stores[model_id]

    def keep(self, task: asyncio.Task) -> asyncio.Task:
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task


state = ReelsState()


# ---------------------------------------------------------------- per-model settings

def _settings_file(model_id: str) -> Path:
    return personas.data_dir(model_id) / "reels-settings.json"


def _model(model_id: str) -> dict:
    try:
        return personas.require(model_id)
    except personas.PersonaError as exc:
        raise HTTPException(404, str(exc)) from exc


def found_folder(persona: dict) -> Path:
    return personas.folder(persona, "found") or Path(personas.default_folder(persona["name"], "found"))


def load_settings(model_id: str) -> HuntSettings:
    persona = _model(model_id)
    try:
        settings = HuntSettings.model_validate(migrate(json.loads(_settings_file(model_id).read_text())))
    except (OSError, ValueError):
        settings = HuntSettings()
    # The model's "Found videos" folder is where its hunts save (change it in Settings → Models).
    settings.output_dir = str(found_folder(persona))
    return settings


def save_settings(model_id: str, settings: HuntSettings) -> HuntSettings:
    persona = _model(model_id)
    settings.output_dir = str(found_folder(persona))
    path = _settings_file(model_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings.model_dump(), indent=2))
    return settings


def current_ai_model() -> str:
    """The AI model the last saved settings use (for analysing references)."""
    if state.hunt:
        return state.hunt.s.model
    return HuntSettings().model


class PromptMakerBody(BaseModel):
    path: str
    caption: str = ""


@router.post("/api/m/{model_id}/prompt-maker")
async def make_prompt(model_id: str, body: PromptMakerBody) -> dict:
    """Prompt Making: read a reference clip (one of this model's own videos) and turn it into a
    ready-to-generate text-to-video prompt, using the same local vision model Reel Finder uses —
    no API, no cost. Paste the result into AI Studio's Wan model to recreate it with this model."""
    persona = _model(model_id)
    file = Path(body.path)
    if not personas.inside_folders(persona, file) or not file.exists():
        raise HTTPException(404, "That video isn't in this model's folders.")
    if library.media_kind(file) != "video":
        raise HTTPException(415, "Pick a video — prompt making reads a reference clip.")
    downloader = Downloader(COOKIES_FILE)
    media = await asyncio.to_thread(downloader.inspect, file)
    frames = await asyncio.to_thread(downloader.extract_frames, file, media.duration, 8)
    if not frames:
        raise HTTPException(422, "Couldn't read frames from that video — is it a real video file?")
    brain, warning = await pick_brain(current_ai_model())
    make = getattr(brain, "generation_prompt", None)
    if make is None:
        raise HTTPException(503, "Prompt making needs a local vision model. Start Ollama and install "
                                 "one (e.g. run: ollama pull qwen3-vl), then try again.")
    try:
        result = await make(frames, body.caption, media.duration)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"The model couldn't make a prompt: {str(exc).splitlines()[0][:200]}") from exc
    return {"prompt": result, "model": getattr(brain, "name", ""),
            "seconds": round(media.duration) if media.duration else None, "warning": warning}


@router.get("/api/m/{model_id}/reels/settings")
async def get_settings(model_id: str) -> HuntSettings:
    return load_settings(model_id)


@router.put("/api/m/{model_id}/reels/settings")
async def put_settings(model_id: str, settings: HuntSettings) -> HuntSettings:
    return save_settings(model_id, settings)


# ---------------------------------------------------------------- status

@router.get("/api/reels/status")
async def status() -> dict:
    models = await ollama_models()
    model = current_ai_model()
    return {
        "version": __version__,
        "os": sys.platform,
        "ollama": {
            "running": models is not None,
            "models": [{"name": m, "vision": sees_images(m)} for m in (models or [])],
            "installed": bool(models) and model_installed(model, models or []),
            "pulling": state.pull_task is not None and not state.pull_task.done(),
        },
        "ffmpeg": find_ffmpeg() is not None,
        "similarity": {
            "installed": Vision.installed(),
            "ready": vision.ready,
            "downloaded": vision.downloaded(),
            "error": vision.error,
        },
        "logins": await state.browser.logins(),
        "browserOpen": state.browser.running,
        "hunting": state.hunting,
        "huntModel": state.hunt_model if state.hunt else None,
        "testing": state.testing,
        "canImportLogins": _reel_finder_profile() is not None,
    }


# ---------------------------------------------------------------- logins (shared by all models)

@router.post("/api/reels/login/{platform}")
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


@router.post("/api/reels/browser/close")
async def close_browser() -> dict:
    if state.hunting or state.testing:
        raise HTTPException(409, "A hunt or self-test is using the browser.")
    if state.browser.running:
        await state.browser.export_cookies()
    await state.browser.close()
    return {"ok": True}


def _reel_finder_profile() -> Path | None:
    profile = REEL_FINDER_HOME / "data" / "browser-profile"
    return profile if profile.is_dir() else None


@router.post("/api/reels/import-logins")
async def import_logins() -> dict:
    """Copy your logins from the Reel Finder app (its browser profile), so you don't log in again."""
    source = _reel_finder_profile()
    if not source:
        raise HTTPException(404, "Reel Finder's logins weren't found on this Mac.")
    if state.hunting or state.testing or state.browser.running:
        raise HTTPException(409, "Close the agents' browser first (no hunt or self-test running).")
    ignore = shutil.ignore_patterns("Cache", "Code Cache", "GPUCache", "Service Worker", "*.log", "Singleton*",
                                    "Crashpad", "ShaderCache", "GrShaderCache")
    tmp = PROFILE_DIR.with_name("browser-profile.importing")
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        await asyncio.to_thread(shutil.copytree, source, tmp, ignore=ignore)
    except OSError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(500, f"Couldn't copy the logins: {exc}") from exc
    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    tmp.replace(PROFILE_DIR)
    cookies = REEL_FINDER_HOME / "data" / "cookies.txt"
    if cookies.exists():
        shutil.copy2(cookies, COOKIES_FILE)
    return {"ok": True, "logins": await state.browser.logins()}


# ---------------------------------------------------------------- AI model (Ollama)

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
                        bus.emit("model_pull", {"model": model, "error": data["error"]})
                        return
                    total, done = data.get("total") or 0, data.get("completed") or 0
                    pct = int(100 * done / total) if total else None
                    if pct != last:
                        last = pct
                        bus.emit("model_pull", {"model": model, "status": data.get("status", ""), "percent": pct})
        bus.emit("model_pull", {"model": model, "status": "success", "percent": 100, "done": True})
    except (httpx.HTTPError, ValueError) as exc:
        bus.emit("model_pull", {"model": model, "error": f"Couldn't reach Ollama: {exc}"})


@router.post("/api/reels/ollama/pull")
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


@router.post("/api/m/{model_id}/reels/hunt/start")
async def start_hunt(model_id: str, body: StartBody) -> dict:
    if state.hunting:
        name = (personas.get(state.hunt_model or "") or {}).get("name", "another model")
        raise HTTPException(409, f"A hunt for {name} is already running — one hunt at a time.")
    if state.testing:
        raise HTTPException(409, "Wait for the self-test to finish.")
    settings = save_settings(model_id, body.settings)
    store = state.references(model_id)
    if any(r.status == "analyzing" for r in store.all()):
        raise HTTPException(409, "Wait a moment — a reference video is still being analysed.")
    references = store.info()
    problem = validate(settings, references.count)
    if problem:
        raise HTTPException(400, problem)
    thumbs = thumbs_dir(model_id)
    shutil.rmtree(thumbs, ignore_errors=True)
    thumbs.mkdir(parents=True, exist_ok=True)
    emit = bus.for_model(model_id)
    state.hunt = Hunt(
        settings,
        emit,
        browser=state.browser,
        downloader=Downloader(COOKIES_FILE),
        thumbs_dir=thumbs,
        screen=(max(body.screen_w, 800), max(body.screen_h, 600)),
        site_urls=SITE_OVERRIDES,
        references=references,
        vision=vision if Vision.installed() else None,
    )
    state.hunt_model = model_id
    state.last_hunts[model_id] = state.hunt
    state.hunt_task = state.keep(asyncio.create_task(_run_hunt(state.hunt)))
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


@router.post("/api/reels/hunt/finish")
async def finish_hunt() -> dict:
    """Stop searching and save the best videos found so far."""
    if state.hunt:
        state.hunt.finish()
    return {"ok": True}


@router.post("/api/reels/hunt/stop")
async def stop_hunt() -> dict:
    """Stop everything right now."""
    if state.hunt:
        state.hunt.stop("Stopped by you")
    return {"ok": True}


def snapshot(model_id: str | None) -> dict | None:
    """This model's latest hunt — running or finished (a page that just opened catches up with it)."""
    hunt = state.last_hunts.get(model_id or "")
    return hunt.snapshot() if hunt else None


@router.get("/api/m/{model_id}/reels/snapshot")
async def get_snapshot(model_id: str) -> dict:
    _model(model_id)
    return {"hunt": snapshot(model_id), "selftests": selftest_states()}


def thumbs_dir(model_id: str) -> Path:
    return THUMBS_DIR / model_id


# ---------------------------------------------------------------- save one link

class LinkBody(BaseModel):
    url: str


@router.post("/api/m/{model_id}/reels/save-link")
async def save_link(model_id: str, body: LinkBody) -> dict:
    persona = _model(model_id)
    url = body.url.strip()
    if not re.match(r"^https?://\S+$", url):
        raise HTTPException(400, "Paste a full link that starts with https://")
    state.keep(asyncio.create_task(_save_link(model_id, found_folder(persona) / "Saved links", url)))
    return {"ok": True}


async def _save_link(model_id: str, folder: Path, url: str) -> None:
    """Download one video from a link (TikTok, Instagram, Pinterest, YouTube…) as a playable MP4."""
    emit = bus.for_model(model_id)
    emit("link", {"url": url, "status": "working"})
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
        emit("link", {"url": url, "status": "done", "file": str(path), "folder": str(folder), "summary": media.summary()})
    except Exception as exc:  # noqa: BLE001 - tell the page what went wrong
        log.warning("Couldn't save link %s: %s", url, exc)
        emit("link", {"url": url, "status": "failed", "error": short_error(exc)})


# ---------------------------------------------------------------- reference videos (per model)

def _analyze(model_id: str, ref, file: Path | None = None) -> None:
    analyzer = Analyzer(state.references(model_id), Downloader(COOKIES_FILE), vision, pick_brain,
                        lambda: load_settings(model_id).model, bus.for_model(model_id))
    state.keep(asyncio.create_task(analyzer.run(ref, file)))


def _room_for_reference(model_id: str) -> None:
    if len(state.references(model_id).all()) >= MAX_REFERENCES:
        raise HTTPException(409, f"You can use up to {MAX_REFERENCES} reference videos — remove one first.")


@router.get("/api/m/{model_id}/reels/references")
async def list_references(model_id: str) -> list[dict]:
    _model(model_id)
    return [r.model_dump() for r in state.references(model_id).all()]


@router.post("/api/m/{model_id}/reels/references/upload")
async def upload_reference(model_id: str, request: Request, name: str = "video") -> dict:
    """The file arrives as the raw request body (no form encoding), straight from the page."""
    _model(model_id)
    _room_for_reference(model_id)
    store = state.references(model_id)
    suffix = Path(name).suffix.lower()
    suffix = suffix if re.match(r"^\.[a-z0-9]{1,5}$", suffix) else ".bin"
    ref = store.create("file", Path(name).name or "video")
    target = store.folder(ref.id) / f"source{suffix}"
    size = 0
    try:
        with target.open("wb") as fh:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "That file is over 2 GB — trim it to the part you want matched.")
                fh.write(chunk)
    except BaseException:
        store.delete(ref.id)
        raise
    if size == 0:
        store.delete(ref.id)
        raise HTTPException(400, "The file was empty.")
    bus.emit("reference", ref.model_dump(), model_id)
    _analyze(model_id, ref, target)
    return ref.model_dump()


class LocalBody(BaseModel):
    path: str


@router.post("/api/m/{model_id}/reels/references/local")
async def local_reference(model_id: str, body: LocalBody) -> dict:
    """A video or picture from one of the model's folders (a find, your reference folder…)."""
    persona = _model(model_id)
    source = Path(body.path).expanduser()
    if not source.is_file() or not personas.inside_folders(persona, source):
        raise HTTPException(404, "That file isn't in this model's folders.")
    _room_for_reference(model_id)
    store = state.references(model_id)
    ref = store.create("file", source.name)
    suffix = source.suffix.lower()
    if not re.match(r"^\.[a-z0-9]{1,5}$", suffix):
        suffix = ".bin"
    target = store.folder(ref.id) / f"source{suffix}"
    try:
        await asyncio.to_thread(shutil.copy2, source, target)
    except OSError as exc:
        store.delete(ref.id)
        raise HTTPException(500, f"Couldn't read that file: {exc}") from exc
    bus.emit("reference", ref.model_dump(), model_id)
    _analyze(model_id, ref, target)
    return ref.model_dump()


@router.post("/api/m/{model_id}/reels/references/link")
async def link_reference(model_id: str, body: LinkBody) -> dict:
    _model(model_id)
    url = body.url.strip()
    if not re.match(r"^https?://\S+$", url):
        raise HTTPException(400, "Paste a full link that starts with https://")
    _room_for_reference(model_id)
    ref = state.references(model_id).create("link", url, url=url)
    bus.emit("reference", ref.model_dump(), model_id)
    _analyze(model_id, ref)
    return ref.model_dump()


@router.delete("/api/m/{model_id}/reels/references/{ref_id}")
async def delete_reference(model_id: str, ref_id: str) -> dict:
    _model(model_id)
    if not valid_id(ref_id) or not state.references(model_id).delete(ref_id):
        raise HTTPException(404, "No such reference")
    bus.emit("reference_removed", {"id": ref_id}, model_id)
    return {"ok": True}


@router.get("/api/m/{model_id}/reels/references/{ref_id}/frame/{n}.jpg")
async def reference_frame(model_id: str, ref_id: str, n: int) -> FileResponse:
    if not personas.valid_id(model_id) or not valid_id(ref_id) or not 1 <= n <= 50:
        raise HTTPException(404)
    path = state.references(model_id).frame_file(ref_id, n)
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/jpeg")


@router.get("/api/m/{model_id}/reels/thumbs/{name}")
async def thumb(model_id: str, name: str) -> FileResponse:
    if not personas.valid_id(model_id) or not re.match(r"^[\w-][\w.-]{0,199}$", name):
        raise HTTPException(404)
    path = thumbs_dir(model_id) / name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


# ---------------------------------------------------------------- self-test & report

class SelfTestBody(BaseModel):
    settings: HuntSettings | None = None


@router.post("/api/reels/selftest/{platform}")
async def start_selftest(platform: str, body: SelfTestBody | None = None) -> dict:
    if platform not in PLATFORMS:
        raise HTTPException(404, "Unknown platform")
    if state.hunting:
        raise HTTPException(409, "Stop the hunt first — the self-test needs the agents' browser.")
    if state.testing:
        raise HTTPException(409, "A self-test is already running.")
    settings = body.settings if body and body.settings else HuntSettings()
    test = SelfTest(platform, settings, bus.for_model(None), browser=state.browser,
                    downloader=Downloader(COOKIES_FILE), site_url=SITE_OVERRIDES.get(platform))
    state.selftests[platform] = test
    state.selftest_task = state.keep(asyncio.create_task(_run_selftest(test)))
    return {"ok": True, "query": test.query}


async def _run_selftest(test: SelfTest) -> None:
    try:
        await test.run()
    finally:
        await _release_browser()


def selftest_states() -> list[dict]:
    return [t.state() for t in state.selftests.values()]


async def build_report() -> str:
    lines = [f"Fifofarm Ultimate · Reel Finder report — {time.strftime('%Y-%m-%d %H:%M:%S')} — {__version__}", ""]
    for key, value in diagnostics(state.browser.browser_name).items():
        lines.append(f"{key}: {value}")
    models = await ollama_models()
    lines.append("Ollama: not running" if models is None else f"Ollama: running · models: {', '.join(models) or 'none'}")
    if not Vision.installed():
        lines.append("Similarity model: not installed")
    else:
        lines.append(f"Similarity model: {'loaded' if vision.ready else 'downloaded' if vision.downloaded() else 'not downloaded yet'}"
                     + (f" · error: {vision.error}" if vision.error else ""))
    for persona in personas.list_all():
        refs = state.references(persona["id"]).all()
        lines.append(f"{persona['name']}: reference videos: {reference_summary(refs) if refs else 'none'}")
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


@router.get("/api/reels/report", response_class=PlainTextResponse)
async def report() -> str:
    return await build_report()


@router.post("/api/reels/open-log")
async def open_log() -> dict:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        target = LOG_FILE if LOG_FILE.exists() else LOG_DIR
        subprocess.Popen(["open", "-R", str(target)] if target == LOG_FILE else ["open", str(target)])
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(LOG_DIR)])
    return {"path": str(LOG_FILE)}


# ---------------------------------------------------------------- app lifecycle

def forget_model(model_id: str) -> None:
    """A model was removed: drop its last hunt and thumbnails (its files and folders stay)."""
    state.last_hunts.pop(model_id, None)
    state._stores.pop(model_id, None)
    if personas.valid_id(model_id):
        shutil.rmtree(thumbs_dir(model_id), ignore_errors=True)


def on_startup() -> None:
    shutil.rmtree(THUMBS_DIR, ignore_errors=True)  # thumbnails of hunts from the last time the app ran
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    for persona in personas.list_all():
        store = state.references(persona["id"])
        for ref in store.all():
            if ref.status == "analyzing":  # Ultimate was closed half-way through
                ref.status, ref.step, ref.error = "failed", "", "Interrupted — remove it and add it again"
                store.save(ref)


async def on_shutdown() -> None:
    for task in list(state.tasks):
        if task is not state.hunt_task:
            task.cancel()
    if state.hunt:
        state.hunt.stop("Fifofarm Ultimate closed")
    if state.hunt_task:
        await asyncio.gather(state.hunt_task, return_exceptions=True)
    if state.testing and state.selftest_task:
        state.selftest_task.cancel()
        await asyncio.gather(state.selftest_task, return_exceptions=True)
    await state.browser.close()


def busy() -> dict[str, Any]:
    return {"hunting": state.hunting, "huntModel": state.hunt_model if state.hunting else None, "testing": state.testing}
