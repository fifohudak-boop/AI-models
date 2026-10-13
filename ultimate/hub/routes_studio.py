"""AI Studio routes (see studio.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import personas, studio

router = APIRouter()


@router.get("/api/studio/options")
async def options() -> dict:
    return {
        "connected": studio.connected(),
        "models": [{"id": k, "name": v} for k, v in studio.MODELS.items()],
        "modes": [{"id": k, "name": v} for k, v in studio.MODES.items()],
        "resolutions": list(studio.RESOLUTIONS),
        "ratios": list(studio.RATIOS),
        "regions": [{"id": k, "name": v[0], "needsWorkspace": v[2] is None} for k, v in studio.REGIONS.items()],
        "minDuration": studio.MIN_S,
        "maxDuration": studio.MAX_S,
        "maxPhotos": studio.MAX_PHOTOS,
        "maxVideos": studio.MAX_VIDEOS,
        "referenceSeconds": studio.REFERENCE_TOTAL_S,
    }


@router.get("/api/m/{model_id}/studio/jobs")
async def jobs(model_id: str) -> list[dict]:
    personas.require(model_id)
    return studio.list_jobs(model_id)


@router.post("/api/m/{model_id}/studio/jobs", status_code=201)
async def create(model_id: str, body: dict) -> dict:
    try:
        return studio.create_job(model_id, body)
    except studio.StudioError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
