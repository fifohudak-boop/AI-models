"""The Editor: turn a clip into a ready reel — trim, crop to shape, add music and captions — with
ffmpeg (free, on this Mac). Captions are drawn with Pillow and overlaid, so no special ffmpeg build
is needed. Finished reels land in the model's "Edited reels" folder, ready to post."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from . import mediainfo, personas
from .config import MEDIA_TMP_DIR, THUMB_CACHE_DIR
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
CAPTION_SIZES = {"S": 0.045, "M": 0.062, "L": 0.085, "XL": 0.11}
CAPTION_POSITIONS = ("top", "middle", "bottom")
CAPTION_STYLES = ("outline", "box", "plain")  # outline = TikTok-style, box = chip behind, plain = soft shadow
CAPTION_COLORS: dict[str, tuple[int, int, int]] = {
    "white": (255, 255, 255), "black": (17, 17, 17), "yellow": (255, 214, 10),
    "pink": (255, 92, 170), "mint": (86, 230, 170),
}
# How fast the reel plays back. 1.0 = normal.
SPEEDS = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
FILL_MODES = ("crop", "blur")  # crop = fill the frame (center-cut); blur = fit whole frame on a blurred bg
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


# ---------------------------------------------------------------- the trim bar's filmstrip

FILMSTRIP_COLS = 14
FILMSTRIP_CELL = (120, 68)  # each thumbnail (16:9-ish); the whole strip is COLS wide


def _strips_dir() -> Path:
    d = THUMB_CACHE_DIR / "edit-strips"
    d.mkdir(parents=True, exist_ok=True)
    return d


def filmstrip(model_id: str, source_path: str) -> Path:
    """A row of thumbnails across the clip, as one JPEG — the background of the trim bar. Cached per
    file (by path + size + time), so dragging the trim handles is instant."""
    persona = personas.require(model_id)
    src = Path(str(source_path or "")).expanduser()
    if not src.is_file() or not personas.inside_folders(persona, src):
        raise EditError("Pick a video from this model's folders.", 404)
    stat = src.stat()
    cw, ch = FILMSTRIP_CELL
    key = hashlib.sha1(f"{src}:{int(stat.st_mtime)}:{stat.st_size}:{FILMSTRIP_COLS}x{cw}x{ch}".encode()).hexdigest()
    out = _strips_dir() / f"{key[:24]}.jpg"
    if out.exists():
        return out
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise EditError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.", 500)
    info = mediainfo.probe(src)
    if not info.has_video or info.is_still_image:
        raise EditError("That file isn't a video.")
    dur = info.duration or 0
    fps = (FILMSTRIP_COLS / dur) if dur and dur > 0.2 else 1.0
    vf = (f"fps={fps:.6f},scale={cw}:{ch}:force_original_aspect_ratio=increase,"
          f"crop={cw}:{ch},setsar=1,tile={FILMSTRIP_COLS}x1")
    tmp = out.with_suffix(".part.jpg")
    proc = subprocess.run([ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(src),
                           "-vf", vf, "-frames:v", "1", "-q:v", "4", str(tmp)],
                          capture_output=True, text=True, errors="replace")
    if proc.returncode != 0 or not tmp.exists():
        raise EditError("Couldn't read the clip's frames.", 500)
    tmp.replace(out)
    return out


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


def _caption_png(cap: dict, out_w: int, out_h: int, path: Path) -> None:
    from PIL import Image, ImageDraw  # noqa: PLC0415

    text, position = cap["text"], cap["position"]
    size, style = cap["size"], cap["style"]
    colour = CAPTION_COLORS.get(cap["color"], (255, 255, 255))
    img = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font_px = max(16, int(out_h * CAPTION_SIZES.get(size, 0.062)))
    font = _font(font_px)
    pad = int(font_px * 0.5)
    max_text_w = int(out_w * 0.88)
    lines = _wrap(draw, text.strip(), font, max_text_w)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + int(out_h * 0.012)
    block_h = line_h * len(lines)
    block_w = min(max_text_w, max((int(draw.textlength(ln, font=font)) for ln in lines), default=0))
    if position == "top":
        top = int(out_h * 0.07)
    elif position == "bottom":
        top = out_h - block_h - int(out_h * 0.11)
    else:
        top = (out_h - block_h) // 2

    # A contrasting edge colour for the outline (dark text → light edge, and the reverse).
    light = (colour[0] * 0.299 + colour[1] * 0.587 + colour[2] * 0.114) > 150
    edge = (0, 0, 0) if light else (255, 255, 255)

    if style == "box":
        box = [(out_w - block_w) // 2 - pad, top - int(pad * 0.7),
               (out_w + block_w) // 2 + pad, top + block_h + int(pad * 0.7)]
        draw.rounded_rectangle(box, radius=int(font_px * 0.35), fill=(0, 0, 0, 165))

    y = top
    for ln in lines:
        w = draw.textlength(ln, font=font)
        x = (out_w - w) / 2
        if style == "outline":
            draw.text((x, y), ln, font=font, fill=(*colour, 255),
                      stroke_width=max(2, int(font_px * 0.09)), stroke_fill=(*edge, 255))
        elif style == "plain":
            off = max(2, int(font_px * 0.05))
            draw.text((x + off, y + off), ln, font=font, fill=(0, 0, 0, 150))
            draw.text((x, y), ln, font=font, fill=(*colour, 255))
        else:  # box
            draw.text((x, y), ln, font=font, fill=(*colour, 255))
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
    fill = req.get("fill") if req.get("fill") in FILL_MODES else "crop"
    mirror = bool(req.get("mirror"))
    try:
        speed = min(2.0, max(0.5, float(req.get("speed", 1.0))))
    except (TypeError, ValueError):
        speed = 1.0
    captions = []
    for c in (req.get("captions") or [])[:5]:
        text = str((c or {}).get("text") or "").strip()[:300]
        if not text:
            continue
        captions.append({
            "text": text,
            "position": c.get("position") if c.get("position") in CAPTION_POSITIONS else "bottom",
            "size": c.get("size") if c.get("size") in CAPTION_SIZES else "M",
            "style": c.get("style") if c.get("style") in CAPTION_STYLES else "outline",
            "color": c.get("color") if c.get("color") in CAPTION_COLORS else "white",
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
        "fill": fill, "mirror": mirror, "speed": speed,
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


def _video_base(plan: dict, out_w: int, out_h: int) -> list[str]:
    """Steps that turn [0:v] into [v0]: speed, mirror, then the chosen shape (fill by cropping, or
    fit the whole frame on a blurred background)."""
    pre = []
    if abs(plan["speed"] - 1.0) > 1e-3:
        pre.append(f"setpts={1.0 / plan['speed']:.6f}*PTS")
    if plan["mirror"]:
        pre.append("hflip")
    head = (",".join(pre) + ",") if pre else ""
    if plan["aspect"] == "original":
        return [f"[0:v]{head}scale={out_w}:{out_h},setsar=1[v0]"]
    if plan["fill"] == "blur":
        return [
            f"[0:v]{head}split=2[bgsrc][fgsrc]",
            f"[bgsrc]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h},boxblur=26:2,eq=brightness=-0.05[bg]",
            f"[fgsrc]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,setsar=1[fg]",
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]",
        ]
    ar = out_w / out_h
    return [f"[0:v]{head}crop='min(iw,ih*{ar:.6f})':'min(ih,iw/{ar:.6f})',"
            f"scale={out_w}:{out_h},setsar=1[v0]"]


def _render_blocking(job: dict, plan: dict, work: Path) -> None:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise EditError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    info: mediainfo.Probe = plan["info"]
    out_w, out_h = _output_size(info, plan["aspect"])
    trim_len = plan["end"] - plan["start"]          # seconds of the source to take
    duration = trim_len / plan["speed"]             # seconds the finished reel plays for
    job.update(status="processing", step="Building the reel", progress=1)
    _emit(job)

    # Captions → transparent PNGs the size of the output.
    caption_pngs: list[Path] = []
    for i, cap in enumerate(plan["captions"]):
        png = work / f"cap{i}.png"
        _caption_png(cap, out_w, out_h, png)
        caption_pngs.append(png)

    # Inputs: [0] trimmed source, [1..] caption PNGs, [last] music (looped).
    args: list[str] = ["-y", "-hide_banner", "-v", "error",
                       "-ss", f"{plan['start']:.3f}", "-t", f"{trim_len:.3f}", "-i", str(plan["source"])]
    # Each caption and the music are looped to fill the reel, but bounded with -t so ffmpeg stops.
    for png in caption_pngs:
        args += ["-loop", "1", "-t", f"{duration:.3f}", "-i", str(png)]
    music_index = None
    if plan["music"]:
        music_index = 1 + len(caption_pngs)
        args += ["-stream_loop", "-1", "-t", f"{duration:.3f}", "-i", str(plan["music"])]

    # Video: speed/mirror/shape → [v0], then captions, then fade.
    steps = _video_base(plan, out_w, out_h)
    last = "v0"
    for i in range(len(caption_pngs)):
        steps.append(f"[{last}][{i + 1}:v]overlay=0:0:format=auto[v{i + 1}]")
        last = f"v{i + 1}"
    if plan["fade"] and duration > 0.8:
        steps.append(f"[{last}]fade=t=in:st=0:d=0.3,fade=t=out:st={duration - 0.3:.3f}:d=0.3[vout]")
    else:
        steps.append(f"[{last}]null[vout]")

    # Audio: original (retimed to match the speed) and/or music, mixed; silent if there's nothing.
    has_orig = info.audio_codec is not None and plan["keepOriginalAudio"]
    orig_speed = f"atempo={plan['speed']:.4f}," if abs(plan["speed"] - 1.0) > 1e-3 else ""
    audio_label = None
    if music_index is not None:
        mfade = f",afade=t=out:st={max(0, duration - 0.6):.3f}:d=0.6" if plan["fade"] else ""
        steps.append(f"[{music_index}:a]atrim=0:{duration:.3f},asetpts=PTS-STARTPTS,"
                     f"volume={plan['musicVolume']:.3f}{mfade}[music]")
        if has_orig:
            steps.append(f"[0:a]{orig_speed}asetpts=PTS-STARTPTS,volume=1.0[orig]")
            steps.append("[orig][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]")
            audio_label = "aout"
        else:
            audio_label = "music"
    elif has_orig:
        afade = f",afade=t=out:st={max(0, duration - 0.4):.3f}:d=0.4" if plan["fade"] else ""
        steps.append(f"[0:a]{orig_speed}asetpts=PTS-STARTPTS{afade}[aout]")
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
