"""AI Studio: make videos of a model with Alibaba's Wan 3.0 (Alibaba Cloud Model Studio).

How a "Generate" runs:
  1. what to make: from a text prompt, from a photo of the model (first frame), or "make this video
     with my model" — a reference video (e.g. a Reel Finder find) + the model's photos;
  2. the local files are made the way Wan accepts them (reference videos: H.264 MP4, 15 s in
     total at most; photos: JPEG, ≤ 4096 px) and uploaded to Alibaba's temporary storage (48 hours);
  3. a Wan 3.0 task is created and checked on every 15 seconds;
  4. the finished MP4 is saved into the model's "AI Studio" folder, ready to post.

Follows Alibaba's Wan 3.0 video API reference (help.aliyun.com/en/model-studio/
wan3-video-generation-api-reference) and "Upload a file to obtain a temporary URL"
(…/get-temporary-file-url). Not yet run against the real service: no key was connected when
this was written — the first real videos are made together.
"""

from __future__ import annotations

import asyncio
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

from . import db, mediainfo, personas, settings
from .config import MEDIA_TMP_DIR
from .events import bus

log = logging.getLogger("ultimate.studio")

MODELS = {
    "wan3.0-video": "Wan 3.0",
    "wan3.0-video-prime": "Wan 3.0 Prime (faster)",
}
MODES = {
    "text": "From a prompt",
    "image": "From a photo (first frame)",
    "reference": "Like a reference video, with your model",
}
RESOLUTIONS = ("480P", "720P", "1080P")
RATIOS = ("9:16", "3:4", "1:1", "4:3", "16:9", "21:9", "adaptive")
# region id → (label, region code used in the workspace address). Wan 3.0 is served only on the
# per-workspace address {WorkspaceId}.{code}.maas.aliyuncs.com, so the workspace ID is always needed.
REGIONS: dict[str, tuple[str, str]] = {
    "intl": ("Singapore (international)", "ap-southeast-1"),
    "cn": ("China (Beijing)", "cn-beijing"),
    "us": ("US (Virginia)", "us-east-1"),
    "eu": ("Germany (Frankfurt)", "eu-central-1"),
    "jp": ("Japan (Tokyo)", "ap-northeast-1"),
    "hk": ("China (Hong Kong)", "cn-hongkong"),
}
# China regions go through dashscope.aliyuncs.com, everywhere else through dashscope-intl — only used
# as a fallback for the temporary-upload step, which is also offered on the shared DashScope host.
CLASSIC_HOSTS = {"cn": "https://dashscope.aliyuncs.com", "hk": "https://dashscope.aliyuncs.com"}
CLASSIC_DEFAULT = "https://dashscope-intl.aliyuncs.com"
WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{1,63}$")

MAX_PHOTOS = 10  # reference_image: up to 10
MAX_VIDEOS = 5  # reference_video: up to 5 …
REFERENCE_TOTAL_S = 15.0  # … 15 seconds in total, 1 s at least each
OUTPUT_PLUS_INPUT_S = 30  # with a video in: its length + the new video's length ≤ 30 s
MIN_S, MAX_S = 2, 30
SMART = -1  # Wan picks the length
ESTIMATE_SECONDS = 5  # when the length is Auto, the cost shown before Generate assumes this many seconds
POLL_EVERY_S = 15  # what Alibaba recommends
FINAL = {"saved", "failed"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".heic", ".heif", ".tif", ".tiff", ".gif", ".avif"}

# Tests swap in a fake service here.
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


class StudioError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- each model's own Alibaba key
# A model can have its own key + region + workspace (so Mia and Mike can be on different accounts).
# A model without its own falls back to the shared "default" (the old single key), so nothing breaks.

def _default_creds(s: dict | None = None) -> dict:
    s = s or settings.get()
    return {"apiKey": s.get("alibabaApiKey") or "", "region": s.get("alibabaRegion") or "intl",
            "workspace": (s.get("alibabaWorkspace") or "").strip()}


def creds(model_id: str | None) -> dict:
    """This model's AI Studio key, region and workspace — its own if set, else the shared default."""
    s = settings.get()
    entry = (s.get("studioKeys") or {}).get(model_id or "") or {}
    if entry.get("apiKey"):
        return {"apiKey": entry.get("apiKey") or "", "region": entry.get("region") or "intl",
                "workspace": (entry.get("workspace") or "").strip()}
    return _default_creds(s)


def save_creds(model_id: str, api_key: str | None, region: str, workspace: str) -> None:
    """Set (or clear) a model's own key. api_key None keeps the saved key; "" removes the model's
    override so it goes back to the shared default."""
    s = settings.get()
    keys = dict(s.get("studioKeys") or {})
    if api_key == "":
        keys.pop(model_id, None)  # back to the default
    else:
        existing = keys.get(model_id) or {}
        keys[model_id] = {"apiKey": existing.get("apiKey", "") if api_key is None else api_key,
                          "region": region, "workspace": workspace}
    settings.save({"studioKeys": keys})


def connected(model_id: str | None = None) -> bool:
    c = creds(model_id)
    return bool(c["apiKey"]) and bool(c["workspace"])


def has_key(model_id: str | None = None) -> bool:
    return bool(creds(model_id)["apiKey"])


def any_connected() -> bool:
    """Is at least one model (or the default) ready to reach Wan? (So the poller knows to run.)"""
    s = settings.get()
    if _default_creds(s)["apiKey"]:
        return True
    return any(bool(e.get("apiKey")) for e in (s.get("studioKeys") or {}).values())


# ---------------------------------------------------------------- what a video costs

def currency() -> str:
    return settings.get().get("studioCurrency") or "USD"


def rates() -> dict:
    return settings.get().get("studioRates") or {}


def price_per_second(model: str, resolution: str) -> float | None:
    """What Wan charges per second of finished video, for this model and resolution (None if unknown)."""
    try:
        value = rates().get(model, {}).get(resolution)
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def estimate_cost(model: str, resolution: str, seconds: float) -> float | None:
    rate = price_per_second(model, resolution)
    if rate is None or not seconds or seconds <= 0:
        return None
    return round(rate * seconds, 4)


def spending(model_id: str) -> dict:
    """What a model has spent on Wan so far — only its own videos that finished (Alibaba bills on success)."""
    cur = currency()
    total = 0.0
    videos = 0
    seconds = 0.0
    per_resolution: dict[str, dict] = {}
    per_month: dict[str, dict] = {}
    for job in list_jobs(model_id, limit=1000):
        if job.get("status") != "saved" or job.get("cost") is None:
            continue
        cost = float(job["cost"])
        secs = float(job.get("seconds") or 0)
        total += cost
        videos += 1
        seconds += secs
        res = job.get("resolution") or "?"
        bucket = per_resolution.setdefault(res, {"videos": 0, "cost": 0.0, "seconds": 0.0})
        bucket["videos"] += 1
        bucket["cost"] += cost
        bucket["seconds"] += secs
        month = str(job.get("createdAt") or "")[:7] or "?"
        mb = per_month.setdefault(month, {"month": month, "videos": 0, "cost": 0.0})
        mb["videos"] += 1
        mb["cost"] += cost
    return {
        "currency": cur,
        "total": round(total, 2),
        "videos": videos,
        "seconds": round(seconds, 1),
        "perResolution": {k: {**v, "cost": round(v["cost"], 2), "seconds": round(v["seconds"], 1)}
                          for k, v in per_resolution.items()},
        "perMonth": [{**v, "cost": round(v["cost"], 2)} for v in sorted(per_month.values(), key=lambda m: m["month"])],
    }


def _region_workspace(region: str | None, workspace: str | None, model_id: str | None = None) -> tuple[str, str]:
    c = creds(model_id)
    region = region if region is not None else c["region"]
    workspace = (workspace if workspace is not None else c["workspace"]).strip()
    return (region if region in REGIONS else "intl"), workspace


def base_url(model_id: str | None = None, region: str | None = None, workspace: str | None = None) -> str:
    """Wan 3.0's address: this model's workspace host. The workspace ID is required — without it
    Alibaba has no endpoint for Wan 3.0 (the shared dashscope host returns 404)."""
    region, workspace = _region_workspace(region, workspace, model_id)
    if not workspace:
        raise StudioError("Add your Model Studio workspace ID (Settings → Models → AI Studio key) — Wan 3.0 needs it.", 424)
    if not WORKSPACE_ID.match(workspace):
        raise StudioError("That workspace ID doesn't look right — copy it from the Model Studio console.")
    return f"https://{workspace}.{REGIONS[region][1]}.maas.aliyuncs.com"


def classic_url(model_id: str | None = None, region: str | None = None) -> str:
    """The shared DashScope host for this region (temporary uploads also work here)."""
    region, _ = _region_workspace(region, "", model_id)
    return CLASSIC_HOSTS.get(region, CLASSIC_DEFAULT)


def _headers(extra: dict | None = None, key: str | None = None, model_id: str | None = None) -> dict:
    key = key if key is not None else creds(model_id)["apiKey"]
    if not key:
        raise StudioError("Connect this model's Alibaba API key first (Settings → Models → AI Studio key).", 424)
    return {"Authorization": f"Bearer {key}", **(extra or {})}


def _client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, transport=_transport, follow_redirects=True)


def _message(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    code, message = data.get("code") or "", data.get("message") or ""
    if resp.status_code in (401, 403) or code in ("InvalidApiKey", "Unauthorized"):
        return "Alibaba didn't accept the API key — check it, and that the region matches where you made it."
    text = f"{message} ({code})" if message and code else message or code or f"HTTP {resp.status_code}"
    lower = message.lower()
    if code in ("Model.AccessDenied", "Model.NotFound", "ModelNotFound") or (
        "model" in lower and ("not exist" in lower or "not found" in lower or "access" in lower)
    ):
        text += " — open the Model Studio console and activate Wan 3.0 for this workspace."
    return f"Alibaba: {text}"


async def check_key(key: str, region: str, workspace: str) -> None:
    """Check the key, region and workspace work together by asking Wan 3.0's own address about a
    (non-existent) task. It's a plain GET that creates nothing and costs nothing: any reply from the
    API — even "no such task" — means the address and key are good; a 401 means the key is wrong; an
    empty 404 means the address itself is wrong, which is the usual cause of the HTTP 404 on Generate."""
    base = base_url(region=region, workspace=workspace)  # raises if the workspace ID is missing or malformed
    async with _client(20) as client:
        resp = await client.get(f"{base}/api/v1/tasks/connectivity-check", headers=_headers(key=key))
    if resp.status_code in (401, 403):
        raise StudioError(_message(resp), 400)
    try:
        body = resp.json()
    except ValueError:
        body = None
    # Any JSON reply from the API (an error about the task is fine) means Wan 3.0 is reachable here.
    if isinstance(body, dict) and (body.get("code") or body.get("message") or body.get("request_id")
                                   or body.get("output")):
        return
    if resp.status_code == 200:
        return
    if resp.status_code == 404:
        raise StudioError("Couldn't reach Wan 3.0 at that address — the key, region and workspace ID must all be from "
                          "the same place. Wan 3.0 may also not be offered in that region yet: during preview it runs "
                          "in Singapore, so a Singapore workspace + key is the safe choice.", 400)
    raise StudioError(_message(resp), 400)


async def upload_temp(path: Path, model: str, model_id: str) -> str:
    """Put a local file in Alibaba's temporary storage; returns an oss:// URL valid for 48 hours.

    The policy is asked for the same model the task uses (files can't be shared across models)."""
    async with _client(900) as client:
        policy_resp = await client.get(f"{base_url(model_id)}/api/v1/uploads",
                                       params={"action": "getPolicy", "model": model},
                                       headers=_headers({"Content-Type": "application/json"}, model_id=model_id))
        if policy_resp.status_code == 404:
            # Some accounts serve temporary uploads only on the shared DashScope host.
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
            # The order matters to OSS: the fields first, the file last.
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


# ---------------------------------------------------------------- getting files ready for Wan

def _run(args: list[str], timeout: float = 600) -> None:
    proc = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout)
    if proc.returncode != 0:
        raise StudioError(f"Couldn't prepare the file: {' '.join(proc.stderr.strip().splitlines()[-2:])[:300]}")


def _scale(width: int, height: int, max_side: int, min_side: int = 240) -> str:
    """An ffmpeg scale filter that fits the picture between Wan's smallest and biggest sizes."""
    if not width or not height:
        return (f"scale='if(gte(iw,ih),trunc(min({max_side},iw)/2)*2,-2)':"
                f"'if(gte(iw,ih),-2,trunc(min({max_side},ih)/2)*2)'")
    factor = min(1.0, max_side / max(width, height))
    if min(width, height) * factor < min_side:
        factor = min_side / min(width, height)
    return f"scale={max(2, round(width * factor / 2) * 2)}:{max(2, round(height * factor / 2) * 2)}"


def prepare_photo(src: Path, out_dir: Path) -> Path:
    """Any photo → a JPEG Wan accepts (JPEG/PNG/BMP/WEBP, 240–8000 px, ≤ 20 MB, no transparency)."""
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise StudioError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    source = src
    if src.suffix.lower() in (".heic", ".heif") and sys.platform == "darwin" and shutil.which("sips"):
        source = out_dir / f"{src.stem}-sips.jpg"  # iPhone photos: macOS converts them best
        _run(["sips", "-s", "format", "jpeg", str(src), "--out", str(source)], timeout=120)
    info = mediainfo.probe(source)
    out = out_dir / f"{uuid.uuid4().hex[:6]}-{src.stem[:40]}.jpg"
    _run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(source), "-frames:v", "1",
          "-vf", f"{_scale(info.width, info.height, 4096)},format=yuvj420p", "-q:v", "2", str(out)], timeout=120)
    return out


def prepare_video(src: Path, out_dir: Path, seconds: float) -> tuple[Path, float]:
    """A reference video → H.264 MP4 at most `seconds` long (Wan: 1–15 s per clip, ≥ 16 fps, ≤ 4096 px)."""
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise StudioError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    info = mediainfo.probe(src)
    if not info.has_video or info.is_still_image:
        raise StudioError(f"{src.name} isn't a video.")
    length = min(info.duration or seconds, seconds)
    if length < 1:
        raise StudioError(f"{src.name} is shorter than 1 second — Wan needs at least 1 second of video.")
    length = math.floor(length * 10) / 10  # never a hair over the limit
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
        _run([ffmpeg, *common, "-c:v", "h264_videotoolbox", "-b:v", "8M", *tail])  # ffmpeg without libx264
    return out, length


def default_prompt(photos: int, extra: str) -> str:
    """Reference mode: tell Wan what Video 1 and Image 1… are (they're numbered in the order sent)."""
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
    mode = req.get("mode")
    if mode not in MODES:
        raise StudioError("Pick what to make.")
    prompt = str(req.get("prompt") or "").strip()[:5000]
    if mode == "text" and not prompt:
        raise StudioError("Describe the video you want.")
    model = req.get("model") if req.get("model") in MODELS else "wan3.0-video"
    resolution = req.get("resolution") if req.get("resolution") in RESOLUTIONS else "1080P"
    ratio = req.get("ratio") if req.get("ratio") in RATIOS else "9:16"
    try:
        duration = int(req.get("duration") if req.get("duration") is not None else 5)
    except (TypeError, ValueError):
        duration = 5
    duration = SMART if duration == SMART else max(MIN_S, min(MAX_S, duration))
    inputs: dict[str, Any] = {}
    for field, limit in (("photos", MAX_PHOTOS), ("videos", MAX_VIDEOS)):
        paths = [Path(p).expanduser() for p in (req.get(field) or [])]
        if len(paths) > limit:
            raise StudioError(f"Wan takes up to {limit} {field} at a time.")
        for p in paths:
            if not p.is_file() or not personas.inside_folders(persona, p):
                raise StudioError(f"{p.name} isn't in this model's folders.")
        inputs[field] = [str(p) for p in paths]
    if mode == "text":
        inputs = {"photos": [], "videos": []}
    if mode == "image":
        if not inputs["photos"]:
            raise StudioError("Pick a photo of the model to start from.")
        inputs = {"photos": inputs["photos"][:1], "videos": []}
    if mode == "reference" and not inputs["videos"]:
        raise StudioError("Pick a reference video (for example one Reel Finder found).")
    for p in inputs["photos"]:
        if Path(p).suffix.lower() not in IMAGE_SUFFIXES:
            raise StudioError(f"{Path(p).name} isn't a photo.")
    return {"mode": mode, "prompt": prompt, "model": model, "resolution": resolution, "ratio": ratio,
            "duration": duration, "audio": req.get("audio") is not False, **inputs}


def create_job(model_id: str, req: dict) -> dict:
    if not connected(model_id):
        raise StudioError("Connect this model's Alibaba API key first (Settings → Models → AI Studio key).", 424)
    base_url(model_id)  # a region that needs a workspace ID says so now, not after the uploads
    clean = validate_request(model_id, req)
    job = {"id": uuid.uuid4().hex, "modelId": model_id, "createdAt": _now(), "status": "starting",
           "step": "Getting your files ready", "error": None, "taskId": None, "file": None, **clean}
    _save(job)
    _tasks.add(task := asyncio.create_task(_start(job)))
    task.add_done_callback(_tasks.discard)
    return job


_tasks: set[asyncio.Task] = set()


async def _start(job: dict) -> None:
    work = MEDIA_TMP_DIR / f"studio-{job['id'][:12]}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        media: list[dict] = []
        if job["mode"] == "image":
            photo = await asyncio.to_thread(prepare_photo, Path(job["photos"][0]), work)
            job.update(step="Uploading the photo to Alibaba")
            _save(job)
            media.append({"type": "first_frame", "url": await upload_temp(photo, job["model"], job["modelId"])})
        elif job["mode"] == "reference":
            # Up to 15 s of reference video in total, shared between the clips.
            per_clip = REFERENCE_TOTAL_S / len(job["videos"])
            prepared = [await asyncio.to_thread(prepare_video, Path(p), work, per_clip) for p in job["videos"]]
            photos = [await asyncio.to_thread(prepare_photo, Path(p), work) for p in job["photos"]]
            job.update(step="Uploading to Alibaba", referenceSeconds=round(sum(s for _, s in prepared), 1))
            _save(job)
            for photo in photos:
                media.append({"type": "reference_image", "url": await upload_temp(photo, job["model"], job["modelId"])})
            for clip, _seconds in prepared:
                media.append({"type": "reference_video", "url": await upload_temp(clip, job["model"], job["modelId"])})
            if job["duration"] != SMART:  # the reference's length + the new video's ≤ 30 s
                room = int(OUTPUT_PLUS_INPUT_S - job["referenceSeconds"])
                job["duration"] = max(MIN_S, min(job["duration"], room))
        prompt = default_prompt(len(job["photos"]), job["prompt"]) if job["mode"] == "reference" else job["prompt"]
        parameters = {"resolution": job["resolution"], "ratio": job["ratio"], "duration": job["duration"],
                      "audio": job["audio"], "prompt_extend": True, "watermark": False}
        job.update(step="Waiting for Wan", status="PENDING", sentPrompt=prompt,
                   taskId=await create_task(job["model"], prompt, media, parameters, job["modelId"]))
    except Exception as exc:  # noqa: BLE001 - shown on the page
        log.warning("AI Studio job %s failed to start: %s", job["id"], exc)
        job.update(status="failed", error=str(exc) or type(exc).__name__, step="")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _save(job)


def recover() -> None:
    """At start: jobs that were still uploading when the app closed can't continue."""
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
        try:
            out = await get_task(job["taskId"], job["modelId"])
        except Exception as exc:  # noqa: BLE001 - try again on the next round
            if _age_s(job) > 24 * 3600:  # Alibaba keeps tasks and results for 24 hours
                job.update(status="failed", step="", error="Wan's result expired (it's kept for 24 hours).")
                _save(job)
            else:
                log.warning("Checking Wan task %s failed: %s", job["taskId"], exc)
            continue
        status = out.get("task_status") or job["status"]
        if status == "SUCCEEDED" and out.get("video_url"):
            job.update(status="downloading", step="Saving the video")
            _save(job)
            try:
                job["file"] = await _download(job, out["video_url"])
                secs = (out.get("usage") or {}).get("output_video_duration")
                if not secs and job.get("duration") not in (None, SMART):
                    secs = job["duration"]
                job.update(status="saved", step="Saved", error=None, seconds=secs,
                           cost=estimate_cost(job["model"], job["resolution"], float(secs or 0)),
                           costCurrency=currency())
            except Exception as exc:  # noqa: BLE001 - tried again next round while the link works
                job.update(status="SUCCEEDED", step="Saving the video", error=f"Couldn't save the video yet: {exc}")
        elif status in ("FAILED", "CANCELED", "UNKNOWN"):
            why = out.get("message") or {"CANCELED": "The task was canceled.",
                                          "UNKNOWN": "Alibaba doesn't know this task any more."}.get(status, "")
            job.update(status="failed", step="", error=f"Wan: {why}" + (f" ({out['code']})" if out.get("code") else ""))
        else:
            job.update(status=status, step="Wan is making it" if status == "RUNNING" else "Waiting for Wan")
        _save(job)


async def _download(job: dict, url: str) -> str:
    persona = personas.require(job["modelId"])
    folder = personas.folder(persona, "generated") or Path(personas.default_folder(persona["name"], "generated"))
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{time.strftime('%Y-%m-%d %H.%M')} {job['mode']} {job['id'][:6]}.mp4"
    partial = target.with_suffix(".part")
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
        except Exception as exc:  # noqa: BLE001 - never stop the loop
            log.warning("AI Studio check failed: %s", exc)
        await asyncio.sleep(POLL_EVERY_S)

