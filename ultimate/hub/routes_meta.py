"""Metadata routes (see metadata.py): list a model's files with what they carry, and clean them."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import library, metadata, personas

router = APIRouter()


@router.get("/api/m/{model_id}/metadata/files")
async def files(model_id: str) -> list[dict]:
    persona = personas.require(model_id)
    seen: dict[str, dict] = {}
    for kind in ("edited", "generated", "found", "references", "photos"):
        root = personas.folder(persona, kind)
        if not root:
            continue
        for item in library.list_folder(root, images_only=False):
            if item["path"] in seen:
                continue
            scan = await asyncio.to_thread(metadata.scan, Path(item["path"]))
            seen[item["path"]] = {**item, "clean": scan["clean"], "tags": scan["tags"]}
    return sorted(seen.values(), key=lambda i: (i["clean"], -i["modified"]))


class CleanBody(BaseModel):
    paths: list[str]


@router.post("/api/m/{model_id}/metadata/clean")
async def clean(model_id: str, body: CleanBody) -> dict:
    persona = personas.require(model_id)
    if not body.paths:
        raise HTTPException(400, "Pick at least one file.")
    if len(body.paths) > 500:
        raise HTTPException(400, "That's a lot at once — clean up to 500 files at a time.")
    cleaned: list[dict] = []
    failed: list[dict] = []
    for p in body.paths:
        path = Path(p).expanduser()
        try:
            await asyncio.to_thread(metadata.clean_file, persona, path)
            cleaned.append({"path": p, "name": path.name})
        except metadata.MetadataError as exc:
            failed.append({"path": p, "name": path.name, "error": str(exc)})
    return {"cleaned": cleaned, "failed": failed}
