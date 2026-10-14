"""The Editor: turn a clip into a ready reel — trim, crop to shape, add music and captions — with
ffmpeg (free, on this Mac). Captions are drawn with Pillow and overlaid, so no special ffmpeg build
is needed. Finished reels land in the model's "Edited reels" folder, ready to post."""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from . import mediainfo, personas
from .config import MEDIA_TMP_DIR
from .events import bus

log = logging.getLogger("ultimate.editor")

# aspect id → (label, width, height). "original" keeps the clip's own shape.
ASPECTS: dict[str, tuple[str, int, int]] = {
    "9:16": ("9:16 — Reels, TikTok, Shorts", 1080, 1920),
    "4:5": ("4:5 — Instagram feed", 1080, 1350),
    "1:1": ("1:1 — square", 1080, 1080),
    "16:9": ("16:9 — YouTube", 1920, 1080),
    "original": ("Keep original shape", 0, 0),
}
CAPTION_SIZES = {"S": 0.045, "M": 0.062, "L": 0.085}
CAPTION_POSITIONS = ("top", "middle", "bottom")
MAX_LONG_SIDE = 1920
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff", ".wma"}

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


class EditError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- music the user adds

def music_dir(model_id: str) -> Path:
    path = personas.data_dir(model_id) / "music"
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_music(model_id: str) -> list[dict]:
    out = []
    for f in sorted(music_dir(model_id).glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.is_file() and f.suffix.lower() in AUDIO_EXT:
            out.append({"name": f.name, "path": str(f), "size": f.stat().st_size})
    return out


def save_music(model_id: str, name: str, data: bytes) -> dict:
    suffix = Path(name).suffix.lower()
    if suffix not in AUDIO_EXT:
        raise EditError("That isn't an audio file (MP3, M4A, WAV…).")
    safe = re.sub(r"[^\w.-]", "_", Path(name).name)[-80:] or f"music{suffix}"
    target = music_dir(model_id) / safe
    i = 1
    while target.exists():
        target = music_dir(model_id) / f"{Path(safe).stem}-{i}{suffix}"
        i += 1
    target.write_bytes(data)
    return {"name": target.name, "path": str(target), "size": target.stat().st_size}


# ---------------------------------------------------------------- building the reel

def _even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


def _output_size(info: mediainfo.Probe, aspect: str) -> tuple[int, int]:
    if aspect in ASPECTS and aspect != "original":
        _, w, h = ASPECTS[aspect]
        return w, h
    w, h = info.width or 1080, info.height or 1920
    scale = min(1.0, MAX_LONG_SIDE / max(w, h))
    return _even(w * scale), _even(h * scale)


def _font(size: int):
    from PIL import ImageFont  # noqa: PLC0415

    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap(draw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        words = paragraph.split(" ")
        line = ""
        for word in words:
            trial = f"{line} {word}".strip()
            if draw.textlength(trial, font=font) <= max_width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def _caption_png(text: str, position: str, size: str, out_w: int, out_h: int, path: Path) -> None:
    from PIL import Image, ImageDraw  # noqa: PLC0415

    img = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _font(max(16, int(out_h * CAPTION_SIZES.get(size, 0.062))))
    pad = int(out_h * 0.02)
    max_text_w = int(out_w * 0.86)
    lines = _wrap(draw, text.strip(), font, max_text_w)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + int(out_h * 0.01)
    block_h = line_h * len(lines)
    block_w = min(max_text_w, max((int(draw.textlength(ln, font=font)) for ln in lines), default=0))
    if position == "top":
        top = int(out_h * 0.06)
    elif position == "bottom":
        top = out_h - block_h - int(out_h * 0.1)
    else:
        top = (out_h - block_h) // 2
    box = [(out_w - block_w) // 2 - pad, top - pad, (out_w + block_w) // 2 + pad, top + block_h + pad]
    radius = int(out_h * 0.015)
    draw.rounded_rectangle(box, radius=radius, fill=(0, 0, 0, 150))
    y = top
    for ln in lines:
        w = draw.textlength(ln, font=font)
        draw.text(((out_w - w) / 2, y), ln, font=font, fill=(255, 255, 255, 255))
        y += line_h
    img.save(path)


def _run_ffmpeg(ffmpeg: str, args: list[str], job: dict, total_s: float) -> None:
    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryFile(mode="w+", errors="replace") as err:
        proc = subprocess.Popen([ffmpeg, *args], stdout=subprocess.PIPE, stderr=err, text=True, errors="replace")
        assert proc.stdout is not None
        for line in proc.stdout:
            m = re.match(r"out_time_us=(\d+)", line)
            if m and total_s > 0:
                job["progress"] = max(1, min(99, round(int(m.group(1)) / (total_s * 1e6) * 100)))
                _emit(job)
        if proc.wait() != 0:
            err.seek(0)
            tail = " ".join(err.read().strip().splitlines()[-4:])
            raise EditError(f"The editor couldn't finish: {tail[:400]}", 500)


def _validate(persona: dict, req: dict) -> dict:
    source = Path(str(req.get("source") or "")).expanduser()
    if not source.is_file() or not personas.inside_folders(persona, source):
        raise EditError("Pick a video from this model's folders.")
    info = mediainfo.probe(source)
    if not info.has_video or info.is_still_image:
        raise EditError("That file isn't a video.")
    dur = info.duration or 0
    try:
        start = max(0.0, float(req.get("trimStart") or 0))
        end = float(req.get("trimEnd")) if req.get("trimEnd") not in (None, "") else dur
    except (TypeError, ValueError) as exc:
        raise EditError("The trim times aren't valid.") from exc
    end = min(end, dur) if dur else end
    if end - start < 0.3:
        raise EditError("The trimmed clip is too short — give it at least a third of a second.")
    aspect = req.get("aspect") if req.get("aspect") in ASPECTS else "9:16"
    captions = []
    for c in (req.get("captions") or [])[:4]:
        text = str((c or {}).get("text") or "").strip()[:300]
        if not text:
            continue
        captions.append({
            "text": text,
            "position": c.get("position") if c.get("position") in CAPTION_POSITIONS else "bottom",
            "size": c.get("size") if c.get("size") in CAPTION_SIZES else "M",
        })
    music_name = str(req.get("music") or "").strip()
    music_path = None
    if music_name:
        candidate = music_dir(persona["id"]) / Path(music_name).name
        if not candidate.is_file():
            raise EditError("That music file isn't here any more — add it again.")
        music_path = candidate
    try:
        music_volume = min(1.5, max(0.0, float(req.get("musicVolume", 0.8))))
    except (TypeError, ValueError):
        music_volume = 0.8
    return {
        "source": source, "info": info, "start": start, "end": end, "aspect": aspect,
        "captions": captions, "music": music_path, "musicVolume": music_volume,
        "keepOriginalAudio": req.get("keepOriginalAudio") is not False,
        "fade": bool(req.get("fade", True)),
    }


# in-memory recent jobs per model (the finished file lives in the library regardless)
_jobs: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()


def _emit(job: dict) -> None:
    bus.emit("edit_job", {k: v for k, v in job.items() if k != "_plan"}, job["modelId"])


def list_jobs(model_id: str, limit: int = 30) -> list[dict]:
    jobs = [j for j in _jobs.values() if j["modelId"] == model_id]
    jobs.sort(key=lambda j: j["createdAt"], reverse=True)
    return [{k: v for k, v in j.items() if k != "_plan"} for j in jobs[:limit]]


def create_job(model_id: str, req: dict) -> dict:
    persona = personas.require(model_id)
    plan = _validate(persona, req)
    job = {
        "id": uuid.uuid4().hex, "modelId": model_id,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "starting", "step": "Getting ready", "progress": 0, "error": None, "file": None,
        "name": plan["source"].name, "_plan": plan,
    }
    _jobs[job["id"]] = job
    task = asyncio.create_task(_render(job))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    _emit(job)
    return {k: v for k, v in job.items() if k != "_plan"}


async def _render(job: dict) -> None:
    plan = job["_plan"]
    work = MEDIA_TMP_DIR / f"edit-{job['id'][:12]}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(_render_blocking, job, plan, work)
        job.update(status="saved", step="Saved", progress=100, error=None)
    except EditError as exc:
        job.update(status="failed", step="", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - shown on the page
        log.warning("Edit job %s failed: %s", job["id"], exc)
        job.update(status="failed", step="", error=str(exc) or type(exc).__name__)
    finally:
        import shutil  # noqa: PLC0415

        shutil.rmtree(work, ignore_errors=True)
    _emit(job)


def _render_blocking(job: dict, plan: dict, work: Path) -> None:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise EditError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    info: mediainfo.Probe = plan["info"]
    out_w, out_h = _output_size(info, plan["aspect"])
    duration = plan["end"] - plan["start"]
    job.update(status="processing", step="Building the reel", progress=1)
    _emit(job)

    # Captions → transparent PNGs the size of the output.
    caption_pngs: list[Path] = []
    for i, cap in enumerate(plan["captions"]):
        png = work / f"cap{i}.png"
        _caption_png(cap["text"], cap["position"], cap["size"], out_w, out_h, png)
        caption_pngs.append(png)

    # Inputs: [0] trimmed source, [1..] caption PNGs, [last] music (looped).
    args: list[str] = ["-y", "-hide_banner", "-v", "error",
                       "-ss", f"{plan['start']:.3f}", "-t", f"{duration:.3f}", "-i", str(plan["source"])]
    # Each caption and the music are looped to fill the clip, but bounded with -t so ffmpeg stops.
    for png in caption_pngs:
        args += ["-loop", "1", "-t", f"{duration:.3f}", "-i", str(png)]
    music_index = None
    if plan["music"]:
        music_index = 1 + len(caption_pngs)
        args += ["-stream_loop", "-1", "-t", f"{duration:.3f}", "-i", str(plan["music"])]

    # Video: crop to the chosen shape (centered), scale to the exact output, then captions and fade.
    if plan["aspect"] == "original":
        vchain = f"scale={out_w}:{out_h},setsar=1"
    else:
        ar = out_w / out_h
        vchain = f"crop='min(iw,ih*{ar:.6f})':'min(ih,iw/{ar:.6f})',scale={out_w}:{out_h},setsar=1"
    steps = [f"[0:v]{vchain}[v0]"]
    last = "v0"
    for i in range(len(caption_pngs)):
        steps.append(f"[{last}][{i + 1}:v]overlay=0:0:format=auto[v{i + 1}]")
        last = f"v{i + 1}"
    if plan["fade"] and duration > 0.8:
        steps.append(f"[{last}]fade=t=in:st=0:d=0.3,fade=t=out:st={duration - 0.3:.3f}:d=0.3[vout]")
    else:
        steps.append(f"[{last}]null[vout]")

    # Audio: original and/or music, mixed; silent if there's nothing.
    has_orig = info.audio_codec is not None and plan["keepOriginalAudio"]
    audio_label = None
    if music_index is not None:
        mfade = f",afade=t=out:st={max(0, duration - 0.6):.3f}:d=0.6" if plan["fade"] else ""
        steps.append(f"[{music_index}:a]atrim=0:{duration:.3f},asetpts=PTS-STARTPTS,"
                     f"volume={plan['musicVolume']:.3f}{mfade}[music]")
        if has_orig:
            steps.append(f"[0:a]volume=1.0[orig]")
            steps.append("[orig][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]")
            audio_label = "aout"
        else:
            audio_label = "music"
    elif has_orig:
        afade = f",afade=t=out:st={max(0, duration - 0.4):.3f}:d=0.4" if plan["fade"] else ""
        steps.append(f"[0:a]asetpts=PTS-STARTPTS{afade}[aout]")
        audio_label = "aout"

    args += ["-filter_complex", ";".join(steps), "-map", "[vout]"]
    if audio_label:
        args += ["-map", f"[{audio_label}]", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]
    else:
        args += ["-an"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", "-shortest", "-progress", "pipe:1", "-nostats"]

    persona = personas.require(job["modelId"])
    folder = personas.folder(persona, "edited") or Path(personas.default_folder(persona["name"], "edited"))
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{time.strftime('%Y-%m-%d %H.%M')} reel {job['id'][:6]}.mp4"
    partial = target.with_suffix(".part.mp4")
    args.append(str(partial))

    try:
        _run_ffmpeg(ffmpeg, args, job, duration)
    except EditError:
        # Some Mac ffmpeg builds lack libx264: fall back to the hardware encoder.
        args[args.index("libx264")] = "h264_videotoolbox"
        _run_ffmpeg(ffmpeg, args, job, duration)
    partial.replace(target)
    job["file"] = str(target)
