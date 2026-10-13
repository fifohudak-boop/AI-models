"""Turns whatever you post (iPhone .mov, 4K HEVC, a photo, a video Reel Finder found, an AI Studio
video…) into files every network accepts, then hands them to the posting engine.

Same rules as Fifofarm: H.264/AAC MP4 with the index at the front, at most 1920 px on the long
side and 60 fps. Videos that already fit are only re-wrapped (seconds, no quality loss).
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from . import postiz
from .config import MEDIA_TMP_DIR
from .mediainfo import Probe, find_ffmpeg, probe

log = logging.getLogger("ultimate.media")

MAX_LONG_SIDE = 1920
MAX_FPS = 60
MAX_COPY_BITRATE = 12_000_000  # above this even a compatible file is re-encoded (upload limits)
POSTIZ_IMAGE_LIMIT = 10 * 1024 * 1024
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
MEDIA_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".gif", ".jpg", ".jpeg", ".png", ".webp", ".heic"}

_jobs: dict[str, dict[str, Any]] = {}
_tasks: set[asyncio.Task] = set()


def clean_tmp() -> None:
    """Leftovers from a crash or restart mid-upload are never needed again."""
    if MEDIA_TMP_DIR.exists():
        for item in MEDIA_TMP_DIR.iterdir():
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)


def needs_encode(info: Probe) -> bool:
    return (
        info.video_codec != "h264"
        or info.pix_fmt not in ("yuv420p", "yuvj420p")
        or info.hdr
        or max(info.width, info.height) > MAX_LONG_SIDE
        or info.fps > MAX_FPS + 0.5
        or info.bit_rate > MAX_COPY_BITRATE
        or (info.audio_codec is not None and info.audio_codec != "aac")
    )


def encode_args(src: Path, out: Path, info: Probe, *, encoder: str = "libx264", tonemap: bool = True) -> list[str]:
    args = ["-y", "-hide_banner", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1"]
    if not needs_encode(info):
        args += ["-c", "copy"]
    else:
        filters: list[str] = []
        if info.hdr and tonemap:
            # iPhone "HDR" (HLG) looks washed out on most networks unless tone-mapped to normal colors.
            filters += ["zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
                        "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"]
        filters += [
            f"scale='if(gte(iw,ih),trunc(min({MAX_LONG_SIDE},iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min({MAX_LONG_SIDE},ih)/2)*2)'",
            "setsar=1",
        ]
        if info.fps > MAX_FPS + 0.5:
            filters.append(f"fps={MAX_FPS}")
        video = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M",
                  "-profile:v", "high"] if encoder == "libx264"
                 else ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high"])
        args += ["-vf", ",".join(filters), *video, "-pix_fmt", "yuv420p", "-colorspace", "bt709",
                 "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]
    args += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(out)]
    return args


def _update(job: dict, **patch: Any) -> None:
    job.update(patch)
    job["updatedAt"] = time.time()


def _run_ffmpeg(ffmpeg: str, args: list[str], job: dict, total_s: float) -> None:
    # stderr goes to a file: a full pipe would stall ffmpeg while we read its progress.
    with tempfile.TemporaryFile(mode="w+", errors="replace") as err:
        proc = subprocess.Popen([ffmpeg, *args], stdout=subprocess.PIPE, stderr=err, text=True, errors="replace")
        assert proc.stdout is not None
        for line in proc.stdout:
            m = re.match(r"out_time_us=(\d+)", line)
            if m and total_s > 0:
                job["progress"] = max(0, min(99, round(int(m.group(1)) / (total_s * 1e6) * 100)))
        code = proc.wait()
        if code != 0:
            err.seek(0)
            tail = " ".join(err.read().strip().splitlines()[-3:])
            raise RuntimeError(f"ffmpeg failed: {tail}")


def _convert_video(ffmpeg: str, src: Path, out: Path, info: Probe, job: dict) -> bool:
    """Returns whether the video was re-encoded. Tries the Mac's hardware encoder if libx264 is missing."""
    attempts = [{"encoder": "libx264", "tonemap": True}]
    if info.hdr:
        attempts.append({"encoder": "libx264", "tonemap": False})  # ffmpeg without zscale
    attempts.append({"encoder": "h264_videotoolbox", "tonemap": False})
    last: Exception | None = None
    for attempt in attempts:
        try:
            _run_ffmpeg(ffmpeg, encode_args(src, out, info, **attempt), job, info.duration)
            return needs_encode(info)
        except RuntimeError as exc:
            last = exc
            if not needs_encode(info):
                break
            log.warning("Converting %s with %s didn't work: %s", src.name, attempt, exc)
    raise last or RuntimeError("Couldn't convert the video")


def _make_cover(ffmpeg: str, src: Path, out: Path, duration: float) -> None:
    at = f"{min(1.0, duration / 2):.2f}"
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-ss", at, "-i", str(src), "-frames:v", "1",
                    "-vf", "scale='trunc(min(1080,iw)/2)*2':-2", "-q:v", "3", str(out)],
                   check=True, capture_output=True, timeout=120)


async def _process_video(job: dict, src: Path, info: Probe, work: Path, ffmpeg: str) -> dict:
    output = work / "video.mp4"
    cover = work / "cover.jpg"
    _update(job, status="processing", step="Converting video for all networks" if needs_encode(info)
            else "Preparing video", progress=0)
    reencoded = await asyncio.to_thread(_convert_video, ffmpeg, src, output, info, job)
    await asyncio.to_thread(_make_cover, ffmpeg, output, cover, info.duration)
    final = await asyncio.to_thread(probe, output, ffmpeg)
    size = output.stat().st_size
    _update(job, step="Sending video to the posting engine", progress=100)
    video, cover_up = await asyncio.gather(postiz.upload(output, "video/mp4"), postiz.upload(cover, "image/jpeg"))
    return {
        "kind": "video",
        "video": {"id": video.get("id"), "path": video.get("path")},
        "cover": {"id": cover_up.get("id"), "path": cover_up.get("path")},
        "previewUrl": cover_up.get("path"),
        "durationSeconds": final.duration,
        "width": final.width,
        "height": final.height,
        "sizeBytes": size,
        "reencoded": reencoded,
    }


async def _process_image(job: dict, src: Path, info: Probe, work: Path, ffmpeg: str) -> dict:
    file = src
    mime = {"png": "image/png", "mjpeg": "image/jpeg"}.get(info.video_codec or "")
    if not mime or src.stat().st_size > POSTIZ_IMAGE_LIMIT:
        _update(job, status="processing", step="Converting photo", progress=0)
        file = work / "photo.jpg"
        await asyncio.to_thread(subprocess.run, [ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(src),
                                                 "-frames:v", "1", "-vf", "scale='trunc(min(4096,iw)/2)*2':-2",
                                                 "-q:v", "2", str(file)], check=True, capture_output=True,
                                timeout=120)
        mime = "image/jpeg"
    _update(job, status="processing", step="Sending photo to the posting engine", progress=100)
    uploaded = await postiz.upload(file, mime)
    return {
        "kind": "images",
        "images": [{"id": uploaded.get("id"), "path": uploaded.get("path")}],
        "previewUrl": uploaded.get("path"),
        "width": info.width,
        "height": info.height,
        "sizeBytes": file.stat().st_size,
    }


async def _run_job(job: dict, src: Path, delete_source: bool) -> None:
    work = MEDIA_TMP_DIR / job["id"]
    work.mkdir(parents=True, exist_ok=True)
    try:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("ffmpeg is missing — quit and reopen Fifofarm Ultimate to install it.")
        info = await asyncio.to_thread(probe, src, ffmpeg)
        if not info.has_video:
            raise RuntimeError("This file has no video or picture in it.")
        if info.is_still_image:
            result = await _process_image(job, src, info, work, ffmpeg)
        else:
            result = await _process_video(job, src, info, work, ffmpeg)
        result["name"] = job["name"]
        if job.get("sourcePath"):
            result["sourcePath"] = job["sourcePath"]
        _update(job, status="ready", step="Ready", progress=100, result=result)
    except Exception as exc:  # noqa: BLE001 - shown on the Post page
        text = str(exc)
        if re.search(r"Invalid data found|could not find codec|moov atom not found", text, re.I):
            text = "This file isn't a video or photo we can read."
        log.warning("Media job %s failed: %s", job["id"], text)
        _update(job, status="failed", error=text)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if delete_source:
            src.unlink(missing_ok=True)


def _start(src: Path, name: str, *, delete_source: bool, source_path: str | None = None) -> dict:
    job = {"id": uuid.uuid4().hex, "name": name, "status": "processing", "step": "Checking file", "progress": 0,
           "result": None, "error": None, "updatedAt": time.time(), "sourcePath": source_path}
    _jobs[job["id"]] = job
    task = asyncio.create_task(_run_job(job, src, delete_source))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    _forget_old()
    return public(job)


def start_upload_job(saved: Path, name: str) -> dict:
    """A file you dropped on the Post page (already saved to the temp folder)."""
    return _start(saved, name, delete_source=True)


def start_local_job(path: Path) -> dict:
    """A file from one of the model's folders (a Reel Finder find, an AI Studio video…). Never deleted."""
    return _start(path, path.name, delete_source=False, source_path=str(path))


def public(job: dict | None) -> dict | None:
    if not job:
        return None
    return {k: v for k, v in job.items() if k != "sourcePath"} | {"source": "library" if job.get("sourcePath") else "upload"}


def processing() -> bool:
    return any(job.get("status") == "processing" for job in _jobs.values())


def get_job(job_id: str) -> dict | None:
    return public(_jobs.get(job_id))


def get_result(job_id: str) -> dict | None:
    job = _jobs.get(job_id)
    return dict(job["result"]) if job and job["status"] == "ready" else None


def _forget_old() -> None:
    cutoff = time.time() - 24 * 3600
    for job_id in [k for k, j in _jobs.items() if j["updatedAt"] < cutoff]:
        _jobs.pop(job_id, None)


def new_upload_path() -> Path:
    MEDIA_TMP_DIR.mkdir(parents=True, exist_ok=True)
    return MEDIA_TMP_DIR / f"in-{uuid.uuid4().hex}"
