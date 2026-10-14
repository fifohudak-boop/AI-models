"""The app itself: status, settings, models (with their folders) and each model's library."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import __version__, library, media, personas, postiz, settings, studio
from .config import APP_DIR, BRAND_NAME, REPO

router = APIRouter()


class UpdateWatch:
    available = False


update_watch = UpdateWatch()


def installed_commit() -> str:
    try:
        return (APP_DIR / ".installed_commit").read_text().strip()
    except OSError:
        return ""


async def watch_for_updates(every_s: float = 6 * 3600) -> None:
    """Notice when a newer version is out, so the page can say "reopen the app to update"."""
    installed = installed_commit()
    if not installed:
        return
    try:
        ref = (APP_DIR / ".installed_ref").read_text().strip() or "main"
    except OSError:
        ref = "main"
    while True:
        try:
            # The newest commit that changed this app (changes to Fifofarm or Reel Finder don't count).
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"https://api.github.com/repos/{REPO}/commits",
                                        params={"sha": ref, "path": "ultimate", "per_page": 1},
                                        headers={"Accept": "application/vnd.github+json"})
            commits = resp.json() if resp.status_code == 200 else []
            latest = commits[0].get("sha", "") if isinstance(commits, list) and commits else ""
            if latest and latest != installed:
                update_watch.available = True
                return
        except (httpx.HTTPError, ValueError):
            pass
        await asyncio.sleep(every_s)


# ---------------------------------------------------------------- status & settings

@router.get("/api/busy")
async def busy() -> dict:
    """Whether restarting now would interrupt something (start.command asks before updating)."""
    from .reels_api import busy as reels_busy  # noqa: PLC0415 - avoid a cycle at import time

    reels = reels_busy()
    reasons = []
    if reels["hunting"]:
        reasons.append("a Reel Finder hunt is running")
    if reels["testing"]:
        reasons.append("a Reel Finder self-test is running")
    if media.processing():
        reasons.append("a video is being prepared for posting")
    return {"busy": bool(reasons), "reasons": reasons}


@router.get("/api/status")
async def status() -> dict:
    s = settings.get()
    engine: dict[str, Any] = {"url": postiz.root_url(), "configured": postiz.configured(), "state": "not-connected"}
    if postiz.configured():
        try:
            await postiz.check_key()
            engine["state"] = "ok"
        except postiz.PostizError as exc:
            engine["state"] = "bad-key" if exc.status == 401 else "unreachable"
            engine["detail"] = str(exc)
    return {
        "brand": BRAND_NAME,
        "version": __version__,
        "build": installed_commit()[:7] or "dev",
        "updateAvailable": update_watch.available,
        "engine": engine,
        "studio": {"connected": studio.connected(), "hasKey": studio.has_key(),
                   "needsWorkspace": studio.has_key() and not (s.get("alibabaWorkspace") or "").strip(),
                   "region": s.get("alibabaRegion", "intl")},
        "activeModel": s.get("activeModel") or "",
    }


@router.get("/api/settings")
async def get_settings() -> dict:
    s = settings.get()
    return {
        "engineUrl": s["engineUrl"],
        "engineKey": settings.mask(s["engineApiKey"]),
        "alibabaKey": settings.mask(s["alibabaApiKey"]),
        "alibabaRegion": s["alibabaRegion"],
        "alibabaWorkspace": s.get("alibabaWorkspace", ""),
    }


class EngineBody(BaseModel):
    url: str
    apiKey: str | None = None
    email: str | None = None
    password: str | None = None


@router.put("/api/settings/engine")
async def connect_engine(body: EngineBody) -> dict:
    url = body.url.strip()
    if not url.startswith(("https://", "http://")):
        raise HTTPException(400, "Use the full address, like https://postiz.yourname.duckdns.org")
    if body.email and body.password:
        key = await postiz.key_from_login(url, body.email.strip(), body.password)
    elif body.apiKey and body.apiKey.strip():
        key = body.apiKey.strip()
    else:
        raise HTTPException(400, "Paste the API key, or sign in with the Postiz login.")
    try:
        await postiz.check_key(key, url)
    except postiz.PostizError as exc:
        if exc.status == 401:
            raise HTTPException(400, "The posting engine didn't accept that API key.") from exc
        raise HTTPException(400, f"Couldn't reach {postiz.root_url(url)}: {exc}") from exc
    settings.save({"engineUrl": postiz.root_url(url), "engineApiKey": key})
    return await get_settings()


@router.delete("/api/settings/engine")
async def disconnect_engine() -> dict:
    settings.save({"engineApiKey": ""})
    return await get_settings()


class StudioKeyBody(BaseModel):
    apiKey: str | None = None  # None keeps the saved key; "" removes it
    region: str = "intl"
    workspace: str = ""


@router.put("/api/settings/studio")
async def save_studio_key(body: StudioKeyBody) -> dict:
    if body.region not in studio.REGIONS:
        raise HTTPException(400, "Pick a region.")
    workspace = body.workspace.strip()
    if workspace and not studio.WORKSPACE_ID.match(workspace):
        raise HTTPException(400, "That workspace ID doesn't look right — copy it from the Model Studio console.")
    old = settings.get()
    key = old["alibabaApiKey"] if body.apiKey is None else body.apiKey.strip()
    # Wan 3.0 needs the key, region and workspace together, so only check once all three are present.
    if key and workspace:
        try:
            await studio.check_key(key, body.region, workspace)
        except studio.StudioError as exc:
            raise HTTPException(400, str(exc)) from exc
        except httpx.HTTPError:
            pass  # offline: keep it, it's checked again when you generate
    settings.save({"alibabaApiKey": key, "alibabaRegion": body.region, "alibabaWorkspace": workspace})
    return await get_settings()


class ActiveBody(BaseModel):
    id: str


@router.put("/api/active-model")
async def set_active(body: ActiveBody) -> dict:
    personas.require(body.id)
    settings.save({"activeModel": body.id})
    return {"ok": True}


# ---------------------------------------------------------------- models

@router.get("/api/models")
async def list_models() -> list[dict]:
    return personas.list_all()


class ModelBody(BaseModel):
    name: str
    color: str | None = None


@router.post("/api/models", status_code=201)
async def create_model(body: ModelBody) -> dict:
    persona = personas.create(body.name, body.color)
    if not settings.get().get("activeModel"):
        settings.save({"activeModel": persona["id"]})
    return persona


@router.put("/api/models/{model_id}")
async def update_model(model_id: str, patch: dict) -> dict:
    return personas.update(model_id, patch)


class OrderBody(BaseModel):
    ids: list[str]


@router.put("/api/models-order")
async def reorder(body: OrderBody) -> list[dict]:
    return personas.reorder(body.ids)


@router.delete("/api/models/{model_id}")
async def delete_model(model_id: str) -> dict:
    from .reels_api import forget_model, state as reels_state  # noqa: PLC0415 - avoid a cycle at import time

    if reels_state.hunting and reels_state.hunt_model == model_id:
        raise HTTPException(409, "Stop this model's hunt first.")
    personas.remove(model_id)
    forget_model(model_id)
    if settings.get().get("activeModel") == model_id:
        remaining = personas.list_all()
        settings.save({"activeModel": remaining[0]["id"] if remaining else ""})
    return {"ok": True}


# ---------------------------------------------------------------- folders

def _pick_folder_blocking(current: str, prompt: str) -> str | None:
    if sys.platform == "darwin":
        default = f' default location (POSIX file "{current}")' if current and Path(current).is_dir() else ""
        safe_prompt = prompt.replace('"', "'")
        script = f'POSIX path of (choose folder with prompt "{safe_prompt}"{default})'
        proc = subprocess.run(["osascript", "-e", "activate", "-e", script], capture_output=True, text=True)
        return (proc.stdout.strip() or None) if proc.returncode == 0 else None
    try:
        import tkinter  # noqa: PLC0415
        from tkinter import filedialog  # noqa: PLC0415

        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        chosen = filedialog.askdirectory(initialdir=current or str(Path.home()), title=prompt)
        root.destroy()
        return chosen or None
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(501, "No folder picker on this system — type the folder path instead.") from exc


class PickBody(BaseModel):
    current: str = ""
    prompt: str = "Choose a folder"


@router.post("/api/pick-folder")
async def pick_folder(body: PickBody) -> dict:
    chosen = await asyncio.to_thread(_pick_folder_blocking, os.path.expanduser(body.current), body.prompt[:120])
    return {"path": chosen.rstrip("/") if chosen and chosen != "/" else chosen}


class OpenBody(BaseModel):
    path: str


@router.post("/api/open-folder")
async def open_folder(body: OpenBody) -> dict:
    target = Path(body.path).expanduser()
    if target.is_file():
        reveal = True
    else:
        reveal = False
        target.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(target)] if reveal else ["open", str(target)])
    elif shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", str(target.parent if reveal else target)])
    return {"path": str(target)}


# ---------------------------------------------------------------- library

@router.get("/api/m/{model_id}/library")
async def model_library(model_id: str) -> dict:
    persona = personas.require(model_id)
    out: dict[str, Any] = {}
    for kind in personas.FOLDER_KINDS:
        root = personas.folder(persona, kind)
        out[kind] = {
            "folder": str(root) if root else "",
            "connected": bool(root),
            "exists": bool(root and root.is_dir()),
            "items": await asyncio.to_thread(library.list_folder, root, images_only=kind == "photos") if root else [],
        }
    return out


def _library_file(model_id: str, path: str) -> Path:
    persona = personas.require(model_id)
    file = Path(path).expanduser()
    if not file.is_file() or not personas.inside_folders(persona, file) or not library.media_kind(file):
        raise HTTPException(404, "Not found.")
    return file


@router.get("/api/m/{model_id}/library/thumb")
async def library_thumb(model_id: str, path: str) -> FileResponse:
    file = _library_file(model_id, path)
    thumb = await asyncio.to_thread(library.thumbnail, file)
    if not thumb:
        raise HTTPException(404, "No preview.")
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@router.get("/api/m/{model_id}/library/file")
async def library_file(model_id: str, path: str) -> FileResponse:
    return FileResponse(_library_file(model_id, path))
