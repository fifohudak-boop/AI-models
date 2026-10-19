"""AI Studio: make videos (and images) of a model with a choice of providers.

Each model picks a provider in its AI Studio key (Settings → Models): Alibaba Wan, ByteDance
Seedance (video) or ByteDance Seedream (images). The key, region (and, for Wan, workspace) are the
model's own, so every model can be a different paid account. The price is worked out automatically
from the provider's published rates (hub/providers.py) — nobody types a price.

How a "Generate" runs:
  1. what to make: from a prompt, from a photo of the model (first frame), or — Wan only —
     "make this video with my model" (a reference video + the model's photos);
  2. the local files are prepared (Wan: H.264 MP4 + JPEG uploaded to Alibaba's 48-hour storage;
     ByteDance: JPEG sent inline as base64);
  3. the provider's task is created and (for video) polled until it finishes;
  4. the finished MP4 / image is saved into the model's AI Studio folder, ready to post.

Wan follows Alibaba's Wan 3.0 video API; Seedance/Seedream follow BytePlus ModelArk
(contents/generations/tasks and images/generations). Not yet run against the live ByteDance
services — the first real runs are made once a key is connected.
"""

from __future__ import annotations

import asyncio
import base64
import calendar
import json
import logging
import math
import mimetypes
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from . import db, mediainfo, personas, providers, settings
from .config import MEDIA_TMP_DIR
from .events import bus

log = logging.getLogger("ultimate.studio")

# Kept for back-compat with callers/tests; the full list lives in hub/providers.py.
MODELS = {"wan3.0-video": "Wan 3.0", "wan3.0-video-prime": "Wan 3.0 Prime (faster)"}
MODES = {
    "text": "From a prompt",
    "image": "From a photo (first frame)",
    "reference": "Like a reference video, with your model",
}
RESOLUTIONS = ("480P", "720P", "1080P")
RATIOS = ("9:16", "3:4", "1:1", "4:3", "16:9", "21:9", "adaptive")
REGIONS = providers.WAN_REGIONS
CLASSIC_HOSTS = {"cn": "https://dashscope.aliyuncs.com", "hk": "https://dashscope.aliyuncs.com"}
CLASSIC_DEFAULT = "https://dashscope-intl.aliyuncs.com"
WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{1,63}$")

MAX_PHOTOS = 10
MAX_VIDEOS = 5
REFERENCE_TOTAL_S = 15.0
OUTPUT_PLUS_INPUT_S = 30
MIN_S, MAX_S = 2, 30
SEEDANCE_MIN_S, SEEDANCE_MAX_S = 4, 15
WAVESPEED_MIN_S, WAVESPEED_MAX_S = providers.WAVESPEED_MIN_S, providers.WAVESPEED_MAX_S
SMART = -1
ESTIMATE_SECONDS = 5
POLL_EVERY_S = 15
FINAL = {"saved", "failed"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".heic", ".heif", ".tif", ".tiff", ".gif", ".avif"}

_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


class StudioError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- each model's own key

def _default_creds(s: dict | None = None) -> dict:
    s = s or settings.get()
    return {"provider": "wan", "apiKey": s.get("alibabaApiKey") or "",
            "region": s.get("alibabaRegion") or "intl", "workspace": (s.get("alibabaWorkspace") or "").strip()}


def creds(model_id: str | None) -> dict:
    """This model's provider + key + region (+ workspace for Wan): its own if set, else the shared Wan default."""
    s = settings.get()
    entry = (s.get("studioKeys") or {}).get(model_id or "") or {}
    if entry.get("apiKey"):
        prov = entry.get("provider") or "wan"
        return {"provider": prov if prov in providers.PROVIDERS else "wan", "apiKey": entry.get("apiKey") or "",
                "region": entry.get("region") or "intl", "workspace": (entry.get("workspace") or "").strip()}
    return _default_creds(s)


def provider_of(model_id: str | None) -> str:
    return creds(model_id)["provider"]


def save_creds(model_id: str, provider_id: str, api_key: str | None, region: str, workspace: str) -> None:
    """Set (or clear) a model's own key. api_key None keeps the saved key; "" removes the override."""
    s = settings.get()
    keys = dict(s.get("studioKeys") or {})
    if api_key == "":
        keys.pop(model_id, None)
    else:
        existing = keys.get(model_id) or {}
        keys[model_id] = {
            "provider": provider_id if provider_id in providers.PROVIDERS else "wan",
            "apiKey": existing.get("apiKey", "") if api_key is None else api_key,
            "region": region, "workspace": workspace,
        }
    settings.save({"studioKeys": keys})


def connected(model_id: str | None = None) -> bool:
    c = creds(model_id)
    if not c["apiKey"]:
        return False
    if c["provider"] == "wan":
        return bool(c["workspace"])
    return True


def has_key(model_id: str | None = None) -> bool:
    return bool(creds(model_id)["apiKey"])


def any_connected() -> bool:
    s = settings.get()
    if _default_creds(s)["apiKey"]:
        return True
    return any(bool(e.get("apiKey")) for e in (s.get("studioKeys") or {}).values())


# ---------------------------------------------------------------- automatic price & spending

def currency() -> str:
    return "USD"  # all provider rates we track are in USD


def estimate(model_id: str, model: str, region: str, resolution: str,
             seconds: float | None = None, images: int = 1) -> float | None:
    return providers.price(provider_of(model_id), model, region, resolution, seconds, images)


def _job_cost(job: dict) -> float | None:
    return providers.price(job.get("provider") or "wan", job.get("model") or "", job.get("region") or "intl",
                           job.get("resolution") or "", job.get("seconds"), int(job.get("images") or 1))


def spending(model_id: str) -> dict:
    """What a model has spent so far — only its own generations that finished (billed on success)."""
    total = 0.0
    count = 0
    seconds = 0.0
    per_resolution: dict[str, dict] = {}
    per_month: dict[str, dict] = {}
    per_provider: dict[str, dict] = {}
    for job in list_jobs(model_id, limit=1000):
        if job.get("status") != "saved" or job.get("cost") is None:
            continue
        cost = float(job["cost"])
        secs = float(job.get("seconds") or 0)
        total += cost
        count += 1
        seconds += secs
        res = job.get("resolution") or "?"
        rb = per_resolution.setdefault(res, {"videos": 0, "cost": 0.0, "seconds": 0.0})
        rb["videos"] += 1
        rb["cost"] += cost
        rb["seconds"] += secs
        month = str(job.get("createdAt") or "")[:7] or "?"
        mb = per_month.setdefault(month, {"month": month, "videos": 0, "cost": 0.0})
        mb["videos"] += 1
        mb["cost"] += cost
        prov = job.get("provider") or "wan"
        pb = per_provider.setdefault(prov, {"provider": prov, "name": providers.provider(prov)["name"],
                                            "videos": 0, "cost": 0.0})
        pb["videos"] += 1
        pb["cost"] += cost
    return {
        "currency": currency(),
        "total": round(total, 2),
        "videos": count,
        "seconds": round(seconds, 1),
        "perResolution": {k: {**v, "cost": round(v["cost"], 2), "seconds": round(v["seconds"], 1)}
                          for k, v in per_resolution.items()},
        "perMonth": [{**v, "cost": round(v["cost"], 2)} for v in sorted(per_month.values(), key=lambda m: m["month"])],
        "perProvider": [{**v, "cost": round(v["cost"], 2)} for v in per_provider.values()],
    }


# ---------------------------------------------------------------- Wan: endpoints

def _region_workspace(region: str | None, workspace: str | None, model_id: str | None = None) -> tuple[str, str]:
    c = creds(model_id)
    region = region if region is not None else c["region"]
    workspace = (workspace if workspace is not None else c["workspace"]).strip()
    return (region if region in REGIONS else "intl"), workspace


def base_url(model_id: str | None = None, region: str | None = None, workspace: str | None = None) -> str:
    region, workspace = _region_workspace(region, workspace, model_id)
    if not workspace:
        raise StudioError("Add your Model Studio workspace ID (Settings → Models → AI Studio key) — Wan 3.0 needs it.", 424)
    if not WORKSPACE_ID.match(workspace):
        raise StudioError("That workspace ID doesn't look right — copy it from the Model Studio console.")
    return f"https://{workspace}.{REGIONS[region][1]}.maas.aliyuncs.com"


def classic_url(model_id: str | None = None, region: str | None = None) -> str:
    region, _ = _region_workspace(region, "", model_id)
    return CLASSIC_HOSTS.get(region, CLASSIC_DEFAULT)


def bytedance_base(region: str) -> str:
    entry = providers.BYTEDANCE_REGIONS.get(region) or providers.BYTEDANCE_REGIONS["intl"]
    return entry[1]


def _headers(extra: dict | None = None, key: str | None = None, model_id: str | None = None) -> dict:
    key = key if key is not None else creds(model_id)["apiKey"]
    if not key:
        raise StudioError("Connect this model's API key first (Settings → Models → AI Studio key).", 424)
    return {"Authorization": f"Bearer {key}", **(extra or {})}


def _client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, transport=_transport, follow_redirects=True)


def _message(resp: httpx.Response, brand: str = "Alibaba") -> str:
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    err = data.get("error") if isinstance(data.get("error"), dict) else {}
    code = data.get("code") or err.get("code") or ""
    message = data.get("message") or err.get("message") or ""
    if resp.status_code in (401, 403) or code in ("InvalidApiKey", "Unauthorized", "AuthenticationError"):
        return f"{brand} didn't accept the API key — check it, and that the region matches where you made it."
    text = f"{message} ({code})" if message and code else message or code or f"HTTP {resp.status_code}"
    lower = message.lower()
    if code in ("Model.AccessDenied", "Model.NotFound", "ModelNotFound", "ModelNotOpen") or (
        "model" in lower and ("not exist" in lower or "not found" in lower or "access" in lower or "not open" in lower)
    ):
        text += " — open the provider's console and activate this model for your account."
    return f"{brand}: {text}"


# ---------------------------------------------------------------- Wan: key check, upload, task

async def check_key(key: str, region: str, workspace: str, provider_id: str = "wan") -> None:
    """Check the key works where it says. Any JSON reply from the API means it's reachable; a 401
    means the key is wrong or from another region; an empty 404 means the address itself is wrong."""
    if provider_id in ("seedance", "seedream"):
        host = bytedance_base(region)
        async with _client(20) as client:
            # A tiny images call with an empty/short prompt: a 401 = bad key, anything else = reachable.
            resp = await client.post(f"{host}/api/v3/images/generations",
                                     headers=_headers({"Content-Type": "application/json"}, key=key),
                                     json={"model": "connectivity-check", "prompt": "ping"})
        if resp.status_code in (401, 403):
            raise StudioError(_message(resp, "ByteDance"), 400)
        return  # reachable (a model/validation error is fine — the key itself was accepted)

    if provider_id == "wavespeed":
        async with _client(20) as client:
            # Asking for a non-existent prediction: a 401 = bad key, anything else = reachable.
            resp = await client.get(f"{providers.WAVESPEED_HOST}/predictions/connectivity-check/result",
                                    headers=_headers(key=key))
        if resp.status_code in (401, 403):
            raise StudioError(_message(resp, "WaveSpeed"), 400)
        return

    if provider_id == "argolink":
        async with _client(20) as client:
            resp = await client.get(f"{providers.ARGOLINK_HOST}/models", headers=_headers(key=key))
        if resp.status_code in (401, 403):
            raise StudioError(_message(resp, "ArgoLink"), 400)
        return

    base = base_url(region=region, workspace=workspace)
    async with _client(20) as client:
        resp = await client.get(f"{base}/api/v1/tasks/connectivity-check", headers=_headers(key=key))
    if resp.status_code in (401, 403):
        raise StudioError(_message(resp), 400)
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and (body.get("code") or body.get("message") or body.get("request_id") or body.get("output")):
        return
    if resp.status_code == 200:
        return
    if resp.status_code == 404:
        raise StudioError("Couldn't reach Wan 3.0 at that address — the key, region and workspace ID must all be from "
                          "the same place. Wan 3.0 may also not be offered in that region yet: during preview it runs "
                          "in Singapore, so a Singapore workspace + key is the safe choice.", 400)
    raise StudioError(_message(resp), 400)


async def upload_temp(path: Path, model: str, model_id: str) -> str:
    async with _client(900) as client:
        policy_resp = await client.get(f"{base_url(model_id)}/api/v1/uploads",
                                       params={"action": "getPolicy", "model": model},
                                       headers=_headers({"Content-Type": "application/json"}, model_id=model_id))
        if policy_resp.status_code == 404:
            policy_resp = await client.get(f"{classic_url(model_id)}/api/v1/uploads",
                                           params={"action": "getPolicy", "model": model},
                                           headers=_headers({"Content-Type": "application/json"}, model_id=model_id))
        if policy_resp.status_code >= 400:
            raise StudioError(_message(policy_resp), 502)
        policy = (policy_resp.json() or {}).get("data") or {}
        if not policy.get("upload_host") or not policy.get("upload_dir"):
            raise StudioError("Alibaba didn't give an upload address.", 502)
        limit_mb = policy.get("max_file_size_mb")
        size_mb = path.stat().st_size / 1_000_000
        if isinstance(limit_mb, (int, float)) and limit_mb and size_mb > limit_mb:
            raise StudioError(f"{path.name} is {size_mb:.0f} MB — Alibaba takes up to {limit_mb} MB per file.")
        safe = re.sub(r"[^\w.-]", "_", path.name)[-80:] or "file"
        key = f"{policy['upload_dir']}/{uuid.uuid4().hex[:8]}-{safe}"
        with path.open("rb") as fh:
            form = {
                "OSSAccessKeyId": policy.get("oss_access_key_id", ""),
                "Signature": policy.get("signature", ""),
                "policy": policy.get("policy", ""),
                "x-oss-object-acl": policy.get("x_oss_object_acl", "private"),
                "x-oss-forbid-overwrite": policy.get("x_oss_forbid_overwrite", "true"),
                "key": key,
                "success_action_status": "200",
            }
            files = {"file": (safe, fh, mimetypes.guess_type(path.name)[0] or "application/octet-stream")}
            up = await client.post(policy["upload_host"], data=form, files=files)
        if up.status_code >= 400:
            raise StudioError(f"Uploading {path.name} to Alibaba failed (HTTP {up.status_code}).", 502)
    return f"oss://{key}"


async def create_task(model: str, prompt: str, media: list[dict], parameters: dict, model_id: str) -> str:
    body: dict[str, Any] = {"model": model, "input": {}, "parameters": parameters}
    if prompt:
        body["input"]["prompt"] = prompt[:20000]
    if media:
        body["input"]["media"] = media
    headers = _headers({"X-DashScope-Async": "enable", "Content-Type": "application/json"}, model_id=model_id)
    if any(str(m.get("url", "")).startswith("oss://") for m in media):
        headers["X-DashScope-OssResourceResolve"] = "enable"
    async with _client(60) as client:
        resp = await client.post(f"{base_url(model_id)}/api/v1/services/aigc/video-generation/video-synthesis",
                                 headers=headers, json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp), 502)
    task_id = ((resp.json() or {}).get("output") or {}).get("task_id")
    if not task_id:
        raise StudioError("Alibaba didn't start the task.", 502)
    return task_id


async def get_task(task_id: str, model_id: str) -> dict:
    async with _client(30) as client:
        resp = await client.get(f"{base_url(model_id)}/api/v1/tasks/{task_id}", headers=_headers(model_id=model_id))
    if resp.status_code >= 400:
        raise StudioError(_message(resp), 502)
    data = resp.json() or {}
    return {**(data.get("output") or {}), "usage": data.get("usage") or {}}


# ---------------------------------------------------------------- ByteDance: inline files, task

def _data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


_BYTE_STATUS = {"queued": "RUNNING", "running": "RUNNING", "pending": "RUNNING", "processing": "RUNNING",
                "succeeded": "SUCCEEDED", "success": "SUCCEEDED", "done": "SUCCEEDED",
                "failed": "FAILED", "cancelled": "CANCELED", "canceled": "CANCELED"}


async def seedance_create(job: dict, first_frame: Path | None) -> str:
    c = creds(job["modelId"])
    content: list[dict] = [{"type": "text", "text": job["sentPrompt"][:20000]}] if job["sentPrompt"] else []
    if first_frame is not None:
        content.append({"type": "image_url", "role": "first_frame", "image_url": {"url": _data_uri(first_frame)}})
    body = {"model": job["model"], "content": content, "ratio": job["ratio"],
            "duration": job["duration"], "resolution": job["resolution"].lower(),
            "watermark": False, "generate_audio": bool(job.get("audio"))}
    async with _client(60) as client:
        resp = await client.post(f"{bytedance_base(c['region'])}/api/v3/contents/generations/tasks",
                                 headers=_headers({"Content-Type": "application/json"}, model_id=job["modelId"]),
                                 json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "ByteDance"), 502)
    task_id = (resp.json() or {}).get("id")
    if not task_id:
        raise StudioError("ByteDance didn't start the task.", 502)
    return task_id


async def seedance_get(task_id: str, model_id: str) -> dict:
    c = creds(model_id)
    async with _client(30) as client:
        resp = await client.get(f"{bytedance_base(c['region'])}/api/v3/contents/generations/tasks/{task_id}",
                                headers=_headers(model_id=model_id))
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "ByteDance"), 502)
    data = resp.json() or {}
    status = _BYTE_STATUS.get(str(data.get("status") or "").lower(), "RUNNING")
    url = ((data.get("content") or {}).get("video_url")) or ""
    err = data.get("error") if isinstance(data.get("error"), dict) else {}
    return {"task_status": status, "video_url": url, "message": err.get("message") or "", "code": err.get("code") or ""}


def _seedream_size(size_label: str, ratio: str) -> str:
    base = {"1K": 1024, "2K": 2048, "4K": 4096}.get(size_label, 2048)
    try:
        rw, rh = (int(x) for x in ratio.split(":"))
    except ValueError:
        rw, rh = 1, 1
    if rw >= rh:
        w, h = base, max(1024, round(base * rh / rw))
    else:
        h, w = base, max(1024, round(base * rw / rh))
    # keep inside Seedream's 1024..4096 per-side window
    w = min(4096, max(1024, round(w / 64) * 64))
    h = min(4096, max(1024, round(h / 64) * 64))
    return f"{w}x{h}"


async def seedream_run(job: dict, reference: Path | None) -> list[str]:
    """Seedream is synchronous — this returns the generated image URL(s) directly."""
    c = creds(job["modelId"])
    body: dict[str, Any] = {"model": job["model"], "prompt": job["sentPrompt"][:4000],
                            "size": _seedream_size(job["resolution"], job["ratio"]),
                            "response_format": "url", "watermark": False,
                            "sequential_image_generation": "disabled"}
    if reference is not None:
        body["image"] = [_data_uri(reference)]
    async with _client(120) as client:
        resp = await client.post(f"{bytedance_base(c['region'])}/api/v3/images/generations",
                                 headers=_headers({"Content-Type": "application/json"}, model_id=job["modelId"]),
                                 json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "ByteDance"), 502)
    data = resp.json() or {}
    urls = [item.get("url") for item in (data.get("data") or []) if item.get("url")]
    if not urls:
        raise StudioError("ByteDance didn't return an image.", 502)
    return urls


# ---------------------------------------------------------------- ArgoLink (images, synchronous)

async def argolink_run(job: dict, reference: Path | None) -> dict:
    """ArgoLink is synchronous — returns the generated image item ({url} or {b64_json})."""
    body: dict[str, Any] = {"model": job["model"], "prompt": job["sentPrompt"][:4000],
                            "resolution": job["resolution"].lower(), "aspect_ratio": job["ratio"],
                            "n": 1, "response_format": "url"}
    if reference is not None:
        body["images"] = [{"image_url": _data_uri(reference)}]
        endpoint = f"{providers.ARGOLINK_HOST}/images/edits"
    else:
        endpoint = f"{providers.ARGOLINK_HOST}/images/generations"
    async with _client(900) as client:  # ArgoLink images can take minutes
        resp = await client.post(endpoint, headers=_headers({"Content-Type": "application/json"}, model_id=job["modelId"]),
                                 json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "ArgoLink"), 502)
    items = (resp.json() or {}).get("data") or []
    if not items or not (items[0].get("url") or items[0].get("b64_json")):
        raise StudioError("ArgoLink didn't return an image.", 502)
    return items[0]


def _save_b64_image(job: dict, b64: str) -> str:
    persona = personas.require(job["modelId"])
    folder = personas.folder(persona, "generated") or Path(personas.default_folder(persona["name"], "generated"))
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{time.strftime('%Y-%m-%d %H.%M')} {job['mode']} {job['id'][:6]}.png"
    target.write_bytes(base64.b64decode(b64))
    return str(target)


# ---------------------------------------------------------------- WaveSpeed (aggregator)

_WAVE_STATUS = {"created": "RUNNING", "queued": "RUNNING", "processing": "RUNNING",
                "completed": "SUCCEEDED",
                "failed": "FAILED", "cancelled": "CANCELED", "canceled": "CANCELED",
                "timeout": "FAILED", "deleted": "FAILED"}


async def wavespeed_create(job: dict, first_frame: Path | None) -> str:
    path = providers.wavespeed_path(job["model"], job["mode"])
    body: dict[str, Any] = {"prompt": job["sentPrompt"][:20000], "aspect_ratio": job["ratio"],
                            "resolution": job["resolution"].lower(), "duration": job["duration"],
                            "generate_audio": bool(job.get("audio"))}
    if first_frame is not None:
        body["image"] = _data_uri(first_frame)
    async with _client(60) as client:
        resp = await client.post(f"{providers.WAVESPEED_HOST}/{path}",
                                 headers=_headers({"Content-Type": "application/json"}, model_id=job["modelId"]),
                                 json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "WaveSpeed"), 502)
    task_id = ((resp.json() or {}).get("data") or {}).get("id")
    if not task_id:
        raise StudioError("WaveSpeed didn't start the task.", 502)
    return task_id


async def wavespeed_get(task_id: str, model_id: str) -> dict:
    async with _client(30) as client:
        resp = await client.get(f"{providers.WAVESPEED_HOST}/predictions/{task_id}/result",
                                headers=_headers(model_id=model_id))
    if resp.status_code >= 400:
        raise StudioError(_message(resp, "WaveSpeed"), 502)
    data = (resp.json() or {}).get("data") or {}
    status = _WAVE_STATUS.get(str(data.get("status") or "").lower(), "RUNNING")
    outputs = data.get("outputs") or []
    return {"task_status": status, "video_url": outputs[0] if outputs else "",
            "message": data.get("error") or "", "code": ""}


# ---------------------------------------------------------------- preparing files for Wan

def _run(args: list[str], timeout: float = 600) -> None:
    proc = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout)
    if proc.returncode != 0:
        raise StudioError(f"Couldn't prepare the file: {' '.join(proc.stderr.strip().splitlines()[-2:])[:300]}")


def _scale(width: int, height: int, max_side: int, min_side: int = 240) -> str:
    if not width or not height:
        return (f"scale='if(gte(iw,ih),trunc(min({max_side},iw)/2)*2,-2)':"
                f"'if(gte(iw,ih),-2,trunc(min({max_side},ih)/2)*2)'")
    factor = min(1.0, max_side / max(width, height))
    if min(width, height) * factor < min_side:
        factor = min_side / min(width, height)
    return f"scale={max(2, round(width * factor / 2) * 2)}:{max(2, round(height * factor / 2) * 2)}"


def prepare_photo(src: Path, out_dir: Path) -> Path:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise StudioError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    source = src
    if src.suffix.lower() in (".heic", ".heif") and sys.platform == "darwin" and shutil.which("sips"):
        source = out_dir / f"{src.stem}-sips.jpg"
        _run(["sips", "-s", "format", "jpeg", str(src), "--out", str(source)], timeout=120)
    info = mediainfo.probe(source)
    out = out_dir / f"{uuid.uuid4().hex[:6]}-{src.stem[:40]}.jpg"
    _run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(source), "-frames:v", "1",
          "-vf", f"{_scale(info.width, info.height, 4096)},format=yuvj420p", "-q:v", "2", str(out)], timeout=120)
    return out


def prepare_video(src: Path, out_dir: Path, seconds: float) -> tuple[Path, float]:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise StudioError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    info = mediainfo.probe(src)
    if not info.has_video or info.is_still_image:
        raise StudioError(f"{src.name} isn't a video.")
    length = min(info.duration or seconds, seconds)
    if length < 1:
        raise StudioError(f"{src.name} is shorter than 1 second — Wan needs at least 1 second of video.")
    length = math.floor(length * 10) / 10
    filters = [_scale(info.width, info.height, 1920), "setsar=1"]
    if not 16 <= (info.fps or 30) <= 60.5:
        filters.append("fps=30")
    out = out_dir / f"{uuid.uuid4().hex[:6]}-{src.stem[:40]}.mp4"
    common = ["-y", "-hide_banner", "-v", "error", "-i", str(src), "-t", f"{length:.1f}", "-map", "0:v:0",
              "-map", "0:a:0?", "-map_metadata", "-1", "-vf", ",".join(filters)]
    tail = ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", str(out)]
    try:
        _run([ffmpeg, *common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", *tail])
    except StudioError:
        _run([ffmpeg, *common, "-c:v", "h264_videotoolbox", "-b:v", "8M", *tail])
    return out, length


def default_prompt(photos: int, extra: str) -> str:
    if photos == 0:
        base = "Recreate Video 1: the same moves, camera, framing and timing as Video 1."
    elif photos == 1:
        base = ("The person in Image 1 performs Video 1: the same moves, camera, framing and timing as Video 1, "
                "with the face, hair, body and look of the person in Image 1.")
    else:
        base = (f"The person shown in Images 1 to {photos} (all the same person) performs Video 1: the same moves, "
                "camera, framing and timing as Video 1, with that person's face, hair, body and look.")
    return f"{base} {extra}".strip()


# ---------------------------------------------------------------- jobs (one per "Generate")

def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def list_jobs(model_id: str, limit: int = 50) -> list[dict]:
    return [json.loads(r["data"]) for r in db.rows(
        "SELECT data FROM studio_jobs WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?", (model_id, limit))]


def _save(job: dict) -> None:
    db.run("""INSERT INTO studio_jobs (id, persona_id, created_at, data) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET data = excluded.data""",
           (job["id"], job["modelId"], job["createdAt"], json.dumps(job)))
    bus.emit("studio_job", job, job["modelId"])


def validate_request(model_id: str, req: dict) -> dict:
    persona = personas.require(model_id)
    prov_id = provider_of(model_id)
    prov = providers.provider(prov_id)
    kind = prov["kind"]
    mode = req.get("mode")
    if mode not in prov["modes"]:
        mode = prov["modes"][0]
    prompt = str(req.get("prompt") or "").strip()[:5000]
    if mode == "text" and not prompt:
        raise StudioError("Describe what you want." if kind == "image" else "Describe the video you want.")
    model = req.get("model") if req.get("model") in providers.model_ids(prov_id) else providers.model_ids(prov_id)[0]
    res_choices = providers.resolutions(prov_id)
    resolution = req.get("resolution") if req.get("resolution") in res_choices else res_choices[-1 if kind == "video" else 1]
    ratio = req.get("ratio") if req.get("ratio") in prov["ratios"] else prov["ratios"][0]

    if kind == "image":
        duration = None
    elif prov_id in ("seedance", "wavespeed"):
        lo, hi = (WAVESPEED_MIN_S, WAVESPEED_MAX_S) if prov_id == "wavespeed" else (SEEDANCE_MIN_S, SEEDANCE_MAX_S)
        try:
            duration = int(req.get("duration") if req.get("duration") is not None else 5)
        except (TypeError, ValueError):
            duration = 5
        duration = max(lo, min(hi, duration))
    else:
        try:
            duration = int(req.get("duration") if req.get("duration") is not None else 5)
        except (TypeError, ValueError):
            duration = 5
        duration = SMART if duration == SMART else max(MIN_S, min(MAX_S, duration))

    inputs: dict[str, Any] = {}
    for field, limit in (("photos", MAX_PHOTOS), ("videos", MAX_VIDEOS)):
        paths = [Path(p).expanduser() for p in (req.get(field) or [])]
        if len(paths) > limit:
            raise StudioError(f"Up to {limit} {field} at a time.")
        for p in paths:
            if not p.is_file() or not personas.inside_folders(persona, p):
                raise StudioError(f"{p.name} isn't in this model's folders.")
        inputs[field] = [str(p) for p in paths]
    if mode == "text":
        inputs = {"photos": [], "videos": []}
    elif mode == "image":
        if not inputs["photos"]:
            raise StudioError("Pick a photo of the model to start from.")
        inputs = {"photos": inputs["photos"][:1], "videos": []}
    elif mode == "reference" and not inputs["videos"]:
        raise StudioError("Pick a reference video (for example one Reel Finder found).")
    for p in inputs["photos"]:
        if Path(p).suffix.lower() not in IMAGE_SUFFIXES:
            raise StudioError(f"{Path(p).name} isn't a photo.")

    return {"provider": prov_id, "kind": kind, "mode": mode, "prompt": prompt, "model": model,
            "resolution": resolution, "ratio": ratio, "duration": duration,
            "region": creds(model_id)["region"], "audio": req.get("audio") is not False, **inputs}


def create_job(model_id: str, req: dict) -> dict:
    if not connected(model_id):
        raise StudioError("Connect this model's API key first (Settings → Models → AI Studio key).", 424)
    if provider_of(model_id) == "wan":
        base_url(model_id)  # fail early if the workspace ID is missing
    clean = validate_request(model_id, req)
    job = {"id": uuid.uuid4().hex, "modelId": model_id, "createdAt": _now(), "status": "starting",
           "step": "Getting your files ready", "error": None, "taskId": None, "file": None, "images": 1, **clean}
    _save(job)
    _tasks.add(task := asyncio.create_task(_run_job(job)))
    task.add_done_callback(_tasks.discard)
    return job


_tasks: set[asyncio.Task] = set()


async def _run_job(job: dict) -> None:
    work = MEDIA_TMP_DIR / f"studio-{job['id'][:12]}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        if job["provider"] == "wan":
            await _start_wan(job, work)
        elif job["provider"] == "seedance":
            await _start_seedance(job, work)
        elif job["provider"] == "wavespeed":
            await _start_wavespeed(job, work)
        elif job["provider"] == "seedream":
            await _run_seedream(job, work)
        elif job["provider"] == "argolink":
            await _run_argolink(job, work)
    except Exception as exc:  # noqa: BLE001 - shown on the page
        log.warning("AI Studio job %s failed to start: %s", job["id"], exc)
        job.update(status="failed", error=str(exc) or type(exc).__name__, step="")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _save(job)


async def _start_wan(job: dict, work: Path) -> None:
    media: list[dict] = []
    if job["mode"] == "image":
        photo = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
        job.update(step="Uploading the photo to Alibaba")
        _save(job)
        media.append({"type": "first_frame", "url": await upload_temp(photo, job["model"], job["modelId"])})
    elif job["mode"] == "reference":
        per_clip = REFERENCE_TOTAL_S / len(job["videos"])
        prepared = [await asyncio.to_thread(prepare_video, Path(p), work, per_clip) for p in job["videos"]]
        photos = [await asyncio.to_thread(prepare_photo, Path(p), work) for p in job["photos"]]
        job.update(step="Uploading to Alibaba", referenceSeconds=round(sum(s for _, s in prepared), 1))
        _save(job)
        for photo in photos:
            media.append({"type": "reference_image", "url": await upload_temp(photo, job["model"], job["modelId"])})
        for clip, _seconds in prepared:
            media.append({"type": "reference_video", "url": await upload_temp(clip, job["model"], job["modelId"])})
        if job["duration"] != SMART:
            room = int(OUTPUT_PLUS_INPUT_S - job["referenceSeconds"])
            job["duration"] = max(MIN_S, min(job["duration"], room))
    prompt = default_prompt(len(job["photos"]), job["prompt"]) if job["mode"] == "reference" else job["prompt"]
    parameters = {"resolution": job["resolution"], "ratio": job["ratio"], "duration": job["duration"],
                  "audio": job["audio"], "prompt_extend": True, "watermark": False}
    job.update(step="Waiting for Wan", status="PENDING", sentPrompt=prompt,
               taskId=await create_task(job["model"], prompt, media, parameters, job["modelId"]))
    _save(job)


async def _start_seedance(job: dict, work: Path) -> None:
    first_frame = None
    if job["mode"] == "image":
        first_frame = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
    job.update(step="Waiting for Seedance", status="PENDING",
               sentPrompt=job["prompt"] or "A short, natural video.")
    _save(job)
    job["taskId"] = await seedance_create(job, first_frame)
    _save(job)


async def _start_wavespeed(job: dict, work: Path) -> None:
    first_frame = None
    if job["mode"] == "image" and job["photos"]:
        first_frame = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
    job.update(step="Waiting for WaveSpeed", status="PENDING",
               sentPrompt=job["prompt"] or "A short, natural video.")
    _save(job)
    job["taskId"] = await wavespeed_create(job, first_frame)
    _save(job)


async def _run_seedream(job: dict, work: Path) -> None:
    reference = None
    if job["mode"] == "image" and job["photos"]:
        reference = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
    job.update(step="Making the image", status="RUNNING", sentPrompt=job["prompt"] or "A photo.")
    _save(job)
    urls = await seedream_run(job, reference)
    job.update(status="downloading", step="Saving the image")
    _save(job)
    job["file"] = await _download(job, urls[0], suffix=".png")
    job.update(status="saved", step="Saved", error=None, images=1, seconds=0,
               cost=_job_cost({**job, "images": 1}), costCurrency=currency())
    _save(job)


async def _run_argolink(job: dict, work: Path) -> None:
    reference = None
    if job["mode"] == "image" and job["photos"]:
        reference = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
    job.update(step="Making the image", status="RUNNING", sentPrompt=job["prompt"] or "A photo.")
    _save(job)
    item = await argolink_run(job, reference)
    job.update(status="downloading", step="Saving the image")
    _save(job)
    job["file"] = await _download(job, item["url"], suffix=".png") if item.get("url") \
        else await asyncio.to_thread(_save_b64_image, job, item["b64_json"])
    job.update(status="saved", step="Saved", error=None, images=1, seconds=0,
               cost=_job_cost({**job, "images": 1}), costCurrency=currency())
    _save(job)


def recover() -> None:
    for row in db.rows("SELECT data FROM studio_jobs ORDER BY created_at DESC LIMIT 200"):
        job = json.loads(row["data"])
        if job.get("status") == "starting":
            job.update(status="failed", step="", error="Fifofarm Ultimate was closed while sending it — try again.")
            _save(job)


def _age_s(job: dict) -> float:
    try:
        return time.time() - calendar.timegm(time.strptime(job["createdAt"], "%Y-%m-%dT%H:%M:%SZ"))
    except (KeyError, ValueError):
        return 0.0


async def poll_once() -> None:
    for row in db.rows("SELECT data FROM studio_jobs ORDER BY created_at DESC LIMIT 100"):
        job = json.loads(row["data"])
        if job["status"] in FINAL or not job.get("taskId"):
            continue
        getter = {"seedance": seedance_get, "wavespeed": wavespeed_get}.get(job.get("provider"), get_task)
        try:
            out = await getter(job["taskId"], job["modelId"])
        except Exception as exc:  # noqa: BLE001
            if _age_s(job) > 24 * 3600:
                job.update(status="failed", step="", error="The result expired (it's kept for 24 hours).")
                _save(job)
            else:
                log.warning("Checking task %s failed: %s", job["taskId"], exc)
            continue
        status = out.get("task_status") or job["status"]
        if status == "SUCCEEDED" and out.get("video_url"):
            job.update(status="downloading", step="Saving the video")
            _save(job)
            try:
                job["file"] = await _download(job, out["video_url"], suffix=".mp4")
                secs = (out.get("usage") or {}).get("output_video_duration")
                if not secs and job.get("duration") not in (None, SMART):
                    secs = job["duration"]
                job.update(status="saved", step="Saved", error=None, seconds=secs,
                           cost=_job_cost({**job, "seconds": float(secs or 0)}), costCurrency=currency())
            except Exception as exc:  # noqa: BLE001
                job.update(status="SUCCEEDED", step="Saving the video", error=f"Couldn't save the video yet: {exc}")
        elif status in ("FAILED", "CANCELED", "UNKNOWN"):
            why = out.get("message") or {"CANCELED": "The task was canceled.",
                                          "UNKNOWN": "The provider doesn't know this task any more."}.get(status, "")
            job.update(status="failed", step="", error=f"{why}" + (f" ({out['code']})" if out.get("code") else ""))
        else:
            job.update(status=status, step="Making it" if status == "RUNNING" else "Waiting")
        _save(job)


async def _download(job: dict, url: str, suffix: str = ".mp4") -> str:
    persona = personas.require(job["modelId"])
    folder = personas.folder(persona, "generated") or Path(personas.default_folder(persona["name"], "generated"))
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{time.strftime('%Y-%m-%d %H.%M')} {job['mode']} {job['id'][:6]}{suffix}"
    partial = target.with_suffix(suffix + ".part")
    async with _client(900) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with partial.open("wb") as fh:
                async for chunk in resp.aiter_bytes():
                    fh.write(chunk)
    partial.replace(target)
    return str(target)


async def poll_loop() -> None:
    recover()
    while True:
        try:
            if any_connected():
                await poll_once()
        except Exception as exc:  # noqa: BLE001
            log.warning("AI Studio check failed: %s", exc)
        await asyncio.sleep(POLL_EVERY_S)
