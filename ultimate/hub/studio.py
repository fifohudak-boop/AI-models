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
# region id → (label, region code in the workspace address, classic address without a workspace ID)
REGIONS: dict[str, tuple[str, str, str | None]] = {
    "intl": ("Singapore (international)", "ap-southeast-1", "https://dashscope-intl.aliyuncs.com"),
    "cn": ("China (Beijing)", "cn-beijing", "https://dashscope.aliyuncs.com"),
    "us": ("US (Virginia)", "us-east-1", None),
    "eu": ("Germany (Frankfurt)", "eu-central-1", None),
    "jp": ("Japan (Tokyo)", "ap-northeast-1", None),
    "hk": ("China (Hong Kong)", "cn-hongkong", None),
}
WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{1,63}$")

MAX_PHOTOS = 10  # reference_image: up to 10
MAX_VIDEOS = 5  # reference_video: up to 5 …
REFERENCE_TOTAL_S = 15.0  # … 15 seconds in total, 1 s at least each
OUTPUT_PLUS_INPUT_S = 30  # with a video in: its length + the new video's length ≤ 30 s
MIN_S, MAX_S = 2, 30
SMART = -1  # Wan picks the length
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


def connected() -> bool:
    return bool(settings.get().get("alibabaApiKey"))


def base_url(region: str | None = None, workspace: str | None = None) -> str:
    """Where to send requests: your workspace's address when you gave its ID, else the classic one."""
    s = settings.get()
    region = region if region is not None else s.get("alibabaRegion") or "intl"
    workspace = (workspace if workspace is not None else s.get("alibabaWorkspace") or "").strip()
    _label, code, classic = REGIONS.get(region, REGIONS["intl"])
    if workspace:
        if not WORKSPACE_ID.match(workspace):
            raise StudioError("That workspace ID doesn't look right — copy it from the Model Studio console.")
        return f"https://{workspace}.{code}.maas.aliyuncs.com"
    if not classic:
        raise StudioError(f"For {REGIONS[region][0]}, add your Model Studio workspace ID (Settings → AI Studio).")
    return classic


def _headers(extra: dict | None = None, key: str | None = None) -> dict:
    key = key if key is not None else settings.get().get("alibabaApiKey") or ""
    if not key:
        raise StudioError("Connect your Alibaba API key first (Settings → AI Studio).", 424)
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
        text += " — make sure Wan 3.0 is enabled in your Model Studio workspace; adding the workspace ID in Settings may help."
    return f"Alibaba: {text}"


async def check_key(key: str, region: str, workspace: str) -> None:
    """A cheap call that tells a wrong key apart from a working one (asks for a task that doesn't exist)."""
    base = base_url(region, workspace)
    async with _client(20) as client:
        resp = await client.get(f"{base}/api/v1/tasks/00000000-0000-0000-0000-000000000000", headers=_headers(key=key))
    if resp.status_code in (401, 403):
        raise StudioError(_message(resp), 400)


async def upload_temp(path: Path, model: str) -> str:
    """Put a local file in Alibaba's temporary storage; returns an oss:// URL valid for 48 hours.

    The policy is asked for the same model the task uses (files can't be shared across models)."""
    base = base_url()
    async with _client(900) as client:
        policy_resp = await client.get(f"{base}/api/v1/uploads", params={"action": "getPolicy", "model": model},
                                       headers=_headers({"Content-Type": "application/json"}))
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


async def create_task(model: str, prompt: str, media: list[dict], parameters: dict) -> str:
    body: dict[str, Any] = {"model": model, "input": {}, "parameters": parameters}
    if prompt:
        body["input"]["prompt"] = prompt[:20000]
    if media:
        body["input"]["media"] = media
    headers = _headers({"X-DashScope-Async": "enable", "Content-Type": "application/json"})
    if any(str(m.get("url", "")).startswith("oss://") for m in media):
        headers["X-DashScope-OssResourceResolve"] = "enable"
    async with _client(60) as client:
        resp = await client.post(f"{base_url()}/api/v1/services/aigc/video-generation/video-synthesis",
                                 headers=headers, json=body)
    if resp.status_code >= 400:
        raise StudioError(_message(resp), 502)
    task_id = ((resp.json() or {}).get("output") or {}).get("task_id")
    if not task_id:
        raise StudioError("Alibaba didn't start the task.", 502)
    return task_id


async def get_task(task_id: str) -> dict:
    async with _client(30) as client:
        resp = await client.get(f"{base_url()}/api/v1/tasks/{task_id}", headers=_headers())
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
    if not connected():
        raise StudioError("Connect your Alibaba API key first (Settings → AI Studio).", 424)
    base_url()  # a region that needs a workspace ID says so now, not after the uploads
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
            media.append({"type": "first_frame", "url": await upload_temp(photo, job["model"])})
        elif job["mode"] == "reference":
            # Up to 15 s of reference video in total, shared between the clips.
            per_clip = REFERENCE_TOTAL_S / len(job["videos"])
            prepared = [await asyncio.to_thread(prepare_video, Path(p), work, per_clip) for p in job["videos"]]
            photos = [await asyncio.to_thread(prepare_photo, Path(p), work) for p in job["photos"]]
            job.update(step="Uploading to Alibaba", referenceSeconds=round(sum(s for _, s in prepared), 1))
            _save(job)
            for photo in photos:
                media.append({"type": "reference_image", "url": await upload_temp(photo, job["model"])})
            for clip, _seconds in prepared:
                media.append({"type": "reference_video", "url": await upload_temp(clip, job["model"])})
            if job["duration"] != SMART:  # the reference's length + the new video's ≤ 30 s
                room = int(OUTPUT_PLUS_INPUT_S - job["referenceSeconds"])
                job["duration"] = max(MIN_S, min(job["duration"], room))
        prompt = default_prompt(len(job["photos"]), job["prompt"]) if job["mode"] == "reference" else job["prompt"]
        parameters = {"resolution": job["resolution"], "ratio": job["ratio"], "duration": job["duration"],
                      "audio": job["audio"], "prompt_extend": True, "watermark": False}
        job.update(step="Waiting for Wan", status="PENDING", sentPrompt=prompt,
                   taskId=await create_task(job["model"], prompt, media, parameters))
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
            out = await get_task(job["taskId"])
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
                job.update(status="saved", step="Saved", error=None,
                           seconds=(out.get("usage") or {}).get("output_video_duration"))
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
            if connected():
                await poll_once()
        except Exception as exc:  # noqa: BLE001 - never stop the loop
            log.warning("AI Studio check failed: %s", exc)
        await asyncio.sleep(POLL_EVERY_S)

