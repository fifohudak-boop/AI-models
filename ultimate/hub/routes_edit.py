"""Editor routes (see editor.py): the clips you can edit, the music you add, and the edit jobs."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from . import editor, library, personas

router = APIRouter()

MAX_MUSIC_BYTES = 60 * 1024 * 1024


@router.get("/api/edit/options")
async def options() -> dict:
    return {
        "aspects": [{"id": k, "name": v[0]} for k, v in editor.ASPECTS.items()],
        "captionSizes": list(editor.CAPTION_SIZES.keys()),
        "captionPositions": list(editor.CAPTION_POSITIONS),
    }


@router.get("/api/m/{model_id}/edit/clips")
async def clips(model_id: str) -> list[dict]:
    persona = personas.require(model_id)
    seen: dict[str, dict] = {}
    for kind in ("edited", "generated", "found", "references"):
        root = personas.folder(persona, kind)
        if not root:
            continue
        for item in library.list_folder(root, images_only=False):
            if item["kind"] == "video" and item["path"] not in seen:
                seen[item["path"]] = item
    return sorted(seen.values(), key=lambda i: i["modified"], reverse=True)


@router.get("/api/m/{model_id}/edit/music")
async def music(model_id: str) -> list[dict]:
    personas.require(model_id)
    return editor.list_music(model_id)


@router.post("/api/m/{model_id}/edit/music")
async def add_music(model_id: str, request: Request, name: str = "music.mp3") -> dict:
    personas.require(model_id)
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_MUSIC_BYTES:
            raise HTTPException(413, "That track is over 60 MB — trim it or use a shorter file.")
    if not data:
        raise HTTPException(400, "The file was empty.")
    try:
        return editor.save_music(model_id, Path(name).name, data)
    except editor.EditError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/api/m/{model_id}/edit/jobs")
async def jobs(model_id: str) -> list[dict]:
    personas.require(model_id)
    return editor.list_jobs(model_id)


@router.post("/api/m/{model_id}/edit/jobs", status_code=201)
async def create(model_id: str, body: dict) -> dict:
    try:
        return editor.create_job(model_id, body)
    except editor.EditError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
