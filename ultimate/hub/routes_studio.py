"""AI Studio routes (see studio.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import personas, settings, studio

router = APIRouter()


@router.get("/api/studio/options")
async def options() -> dict:
    return {
        "connected": studio.connected(),
        "models": [{"id": k, "name": v} for k, v in studio.MODELS.items()],
        "modes": [{"id": k, "name": v} for k, v in studio.MODES.items()],
        "resolutions": list(studio.RESOLUTIONS),
        "ratios": list(studio.RATIOS),
        "regions": [{"id": k, "name": v[0]} for k, v in studio.REGIONS.items()],
        "workspaceRequired": True,
        "minDuration": studio.MIN_S,
        "maxDuration": studio.MAX_S,
        "estimateSeconds": studio.ESTIMATE_SECONDS,
        "maxPhotos": studio.MAX_PHOTOS,
        "maxVideos": studio.MAX_VIDEOS,
        "referenceSeconds": studio.REFERENCE_TOTAL_S,
        "currency": studio.currency(),
        "rates": studio.rates(),
    }


@router.get("/api/m/{model_id}/studio/spending")
async def spending(model_id: str) -> dict:
    personas.require(model_id)
    return studio.spending(model_id)


class RatesBody(BaseModel):
    currency: str = "USD"
    rates: dict


@router.put("/api/studio/rates")
async def save_rates(body: RatesBody) -> dict:
    cur = (body.currency or "USD").strip()[:8] or "USD"
    clean: dict[str, dict[str, float]] = {}
    for model, by_res in (body.rates or {}).items():
        if model not in studio.MODELS or not isinstance(by_res, dict):
            continue
        clean[model] = {}
        for res, value in by_res.items():
            if res not in studio.RESOLUTIONS:
                continue
            try:
                rate = float(value)
            except (TypeError, ValueError) as exc:
                raise HTTPException(400, f"{model} {res}: that isn't a number.") from exc
            if rate < 0:
                raise HTTPException(400, "A price can't be negative.")
            clean[model][res] = round(rate, 6)
    settings.save({"studioCurrency": cur, "studioRates": clean})
    return {"currency": cur, "rates": clean}


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
