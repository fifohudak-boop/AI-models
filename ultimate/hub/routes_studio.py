"""AI Studio routes (see studio.py). Each model picks a provider in its key; prices are automatic."""

from __future__ import annotations

from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import library, personas, providers, settings, studio

router = APIRouter()


def _durations(provider_id: str) -> dict:
    if providers.kind_of(provider_id) == "image":
        return {"min": 0, "max": 0, "auto": False, "default": 0}
    if provider_id == "seedance":
        return {"min": studio.SEEDANCE_MIN_S, "max": studio.SEEDANCE_MAX_S, "auto": False, "default": 5}
    if provider_id == "wavespeed":
        return {"min": studio.WAVESPEED_MIN_S, "max": studio.WAVESPEED_MAX_S, "auto": False, "default": 5}
    if provider_id == "videorouter":
        return {"min": studio.VIDEOROUTER_MIN_S, "max": studio.VIDEOROUTER_MAX_S, "auto": False, "default": 5}
    if provider_id == "argolink-video":
        return {"min": studio.ARGOLINK_VIDEO_MIN_S, "max": studio.ARGOLINK_VIDEO_MAX_S, "auto": False, "default": 5}
    return {"min": studio.MIN_S, "max": studio.MAX_S, "auto": True, "default": 5}


def _options(model_id: str | None, provider_id: str | None = None) -> dict:
    """Options for one provider (the selected one, or this model's default-connected one), plus the
    full provider list with a `connected` flag so AI Studio can offer a switcher."""
    prov_id = provider_id if provider_id in providers.PROVIDERS else studio.default_provider(model_id)
    prov = providers.provider(prov_id)
    c = studio.creds(model_id, prov_id)
    conn = set(studio.connected_providers(model_id))
    return {
        "connected": studio.connected(model_id, prov_id),
        "anyConnected": bool(conn),
        "provider": prov_id,
        "providerName": prov["name"],
        "kind": prov["kind"],
        "needsWorkspace": prov_id == "wan" and studio.has_key(model_id, "wan") and not c["workspace"],
        "providers": [{"id": p["id"], "name": p["name"], "kind": p["kind"], "connected": p["id"] in conn}
                      for p in providers.PROVIDERS.values()],
        "models": prov["models"],
        "modes": [{"id": m, "name": (studio.IMAGE_MODE_LABELS if prov["kind"] == "image" else studio.MODES).get(m, m)}
                  for m in prov["modes"]],
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
async def model_options(model_id: str, provider: str | None = None) -> dict:
    personas.require(model_id)
    return _options(model_id, provider)


@router.get("/api/m/{model_id}/studio/price")
async def price(model_id: str, model: str, resolution: str, seconds: float = 0, images: int = 1,
                provider: str | None = None) -> dict:
    """The automatic price for one generation with these settings (None when it can't be worked out)."""
    personas.require(model_id)
    prov_id = provider if provider in providers.PROVIDERS else studio.default_provider(model_id)
    region = studio.creds(model_id, prov_id)["region"]
    value = providers.price(prov_id, model, region, resolution, seconds or None, images)
    return {"price": value, "currency": studio.currency()}


@router.get("/api/m/{model_id}/studio/key")
async def get_model_key(model_id: str) -> dict:
    """Every provider's key status for this model (owner only). Keys are only ever shown masked.
    A model can hold a key for each provider at once, so this returns one entry per provider."""
    personas.require(model_id)
    s = settings.get()
    mk = studio.model_keys(model_id, s)  # {provider: {apiKey, region, workspace}}
    keys = {}
    for pid, p in providers.PROVIDERS.items():
        if p.get("sharesKeyWith"):
            continue  # no key of its own — it reuses another provider's key for this model
        c = studio.creds(model_id, pid)
        own = mk.get(pid) or {}
        keys[pid] = {
            "hasKey": bool(own.get("apiKey")),
            "keyMasked": settings.mask(c["apiKey"]),
            "region": c["region"],
            "workspace": c["workspace"],
            "connected": studio.connected(model_id, pid),
            "usingDefault": False,  # no shared fallback — each model uses its own key, so billing is separate
        }
    return {
        "defaultConnected": False,
        "keys": keys,
        "providers": [{"id": p["id"], "name": p["name"], "kind": p["kind"], "needsWorkspace": p["needsWorkspace"],
                       "regions": p["regions"], "keyHint": p["keyHint"], "console": p["console"]}
                      for p in providers.PROVIDERS.values() if not p.get("sharesKeyWith")],
    }


class ModelKeyBody(BaseModel):
    provider: str = "wan"
    apiKey: str | None = None  # None keeps the saved key; "" removes this provider's key for the model
    region: str = "intl"
    workspace: str = ""


@router.put("/api/m/{model_id}/studio/key")
async def set_model_key(model_id: str, body: ModelKeyBody) -> dict:
    personas.require(model_id)
    if body.provider not in providers.PROVIDERS:
        raise HTTPException(400, "Pick a provider.")
    if body.apiKey == "":  # remove just this provider's key, leaving the model's other keys intact
        studio.save_creds(model_id, body.provider, "", body.region, "")
        return await get_model_key(model_id)
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
    saved = studio.model_keys(model_id).get(body.provider) or {}
    key = saved.get("apiKey", "") if body.apiKey is None else body.apiKey.strip()
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


@router.post("/api/m/{model_id}/studio/upload", status_code=201)
async def upload(model_id: str, request: Request, name: str = "file") -> dict:
    """A picture or reference video dragged straight onto the AI Studio page (one file per request —
    a whole folder is many of these). The bytes are the raw request body. Saved into the model's drop
    area so it's usable and served like any library file. Returns its path, so Generate can use it."""
    personas.require(model_id)
    if library.media_kind(Path(name)) is None:
        raise HTTPException(415, f"{Path(name).name} isn't a picture or video.")
    target = studio.staged_upload_path(model_id, name)
    size = 0
    try:
        with target.open("wb") as fh:
            async for chunk in request.stream():
                size += len(chunk)
                if size > studio.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "That file is too big (over 4 GB).")
                fh.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if size == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(400, "No file received.")
    studio.forget_old_uploads(model_id)
    return {"path": str(target), "name": Path(name).name, "kind": library.media_kind(target)}
