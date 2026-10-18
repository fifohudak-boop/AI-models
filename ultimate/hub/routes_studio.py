"""AI Studio routes (see studio.py). Each model picks a provider in its key; prices are automatic."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import personas, providers, settings, studio

router = APIRouter()


def _durations(provider_id: str) -> dict:
    if providers.kind_of(provider_id) == "image":
        return {"min": 0, "max": 0, "auto": False, "default": 0}
    if provider_id == "seedance":
        return {"min": studio.SEEDANCE_MIN_S, "max": studio.SEEDANCE_MAX_S, "auto": False, "default": 5}
    if provider_id == "wavespeed":
        return {"min": studio.WAVESPEED_MIN_S, "max": studio.WAVESPEED_MAX_S, "auto": False, "default": 5}
    return {"min": studio.MIN_S, "max": studio.MAX_S, "auto": True, "default": 5}


def _options(model_id: str | None) -> dict:
    prov_id = studio.provider_of(model_id)
    prov = providers.provider(prov_id)
    c = studio.creds(model_id)
    return {
        "connected": studio.connected(model_id),
        "provider": prov_id,
        "providerName": prov["name"],
        "kind": prov["kind"],
        "needsWorkspace": prov_id == "wan" and studio.has_key(model_id) and not c["workspace"],
        "providers": [{"id": p["id"], "name": p["name"], "kind": p["kind"]} for p in providers.PROVIDERS.values()],
        "models": prov["models"],
        "modes": [{"id": m, "name": studio.MODES.get(m, m)} for m in prov["modes"]],
        "resolutions": providers.resolutions(prov_id),
        "ratios": prov["ratios"],
        "regions": prov["regions"],
        "durations": _durations(prov_id),
        "estimateSeconds": studio.ESTIMATE_SECONDS,
        "maxPhotos": studio.MAX_PHOTOS,
        "maxVideos": studio.MAX_VIDEOS,
        "referenceSeconds": studio.REFERENCE_TOTAL_S,
        "currency": studio.currency(),
    }


@router.get("/api/studio/options")
async def options() -> dict:
    return _options(None)


@router.get("/api/m/{model_id}/studio/options")
async def model_options(model_id: str) -> dict:
    personas.require(model_id)
    return _options(model_id)


@router.get("/api/m/{model_id}/studio/price")
async def price(model_id: str, model: str, resolution: str, seconds: float = 0, images: int = 1) -> dict:
    """The automatic price for one generation with these settings (None when it can't be worked out)."""
    personas.require(model_id)
    prov_id = studio.provider_of(model_id)
    region = studio.creds(model_id)["region"]
    value = providers.price(prov_id, model, region, resolution, seconds or None, images)
    return {"price": value, "currency": studio.currency()}


@router.get("/api/m/{model_id}/studio/key")
async def get_model_key(model_id: str) -> dict:
    """What key this model uses (owner only) — the key itself is only ever shown masked."""
    personas.require(model_id)
    s = settings.get()
    own = (s.get("studioKeys") or {}).get(model_id) or {}
    default = studio._default_creds(s)
    c = studio.creds(model_id)
    return {
        "hasOwnKey": bool(own.get("apiKey")),
        "usingDefault": not bool(own.get("apiKey")),
        "provider": c["provider"],
        "keyMasked": settings.mask(c["apiKey"]),
        "region": c["region"],
        "workspace": c["workspace"],
        "needsWorkspace": c["provider"] == "wan",
        "defaultConnected": bool(default["apiKey"]) and bool(default["workspace"]),
        "providers": [{"id": p["id"], "name": p["name"], "kind": p["kind"], "needsWorkspace": p["needsWorkspace"],
                       "regions": p["regions"], "keyHint": p["keyHint"], "console": p["console"]}
                      for p in providers.PROVIDERS.values()],
    }


class ModelKeyBody(BaseModel):
    provider: str = "wan"
    apiKey: str | None = None  # None keeps the saved key; "" removes this model's own key
    region: str = "intl"
    workspace: str = ""


@router.put("/api/m/{model_id}/studio/key")
async def set_model_key(model_id: str, body: ModelKeyBody) -> dict:
    personas.require(model_id)
    if body.apiKey == "":
        studio.save_creds(model_id, "wan", "", body.region, "")
        return await get_model_key(model_id)
    if body.provider not in providers.PROVIDERS:
        raise HTTPException(400, "Pick a provider.")
    prov = providers.provider(body.provider)
    region_ids = {r["id"] for r in prov["regions"]}
    if body.region not in region_ids:
        raise HTTPException(400, "Pick a region for this provider.")
    workspace = body.workspace.strip()
    if prov["needsWorkspace"]:
        if workspace and not studio.WORKSPACE_ID.match(workspace):
            raise HTTPException(400, "That workspace ID doesn't look right — copy it from the Model Studio console.")
    else:
        workspace = ""
    own = (settings.get().get("studioKeys") or {}).get(model_id) or {}
    key = own.get("apiKey", "") if body.apiKey is None else body.apiKey.strip()
    # Check only once everything the provider needs is present (Wan also needs the workspace).
    ready = bool(key) and (workspace or not prov["needsWorkspace"])
    if ready:
        try:
            await studio.check_key(key, body.region, workspace, body.provider)
        except studio.StudioError as exc:
            raise HTTPException(400, str(exc)) from exc
        except httpx.HTTPError:
            pass  # offline: keep it, it's checked again when you generate
    studio.save_creds(model_id, body.provider, key, body.region, workspace)
    return await get_model_key(model_id)


@router.get("/api/m/{model_id}/studio/spending")
async def spending(model_id: str) -> dict:
    personas.require(model_id)
    return studio.spending(model_id)


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
