"""What's inside a video or picture, read from ffmpeg's own description of the file.

(The Mac doesn't come with ffprobe, but Ultimate always has ffmpeg, so this parses `ffmpeg -i`.)
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

HDR_TRANSFERS = ("arib-std-b67", "smpte2084")  # HLG (iPhone), PQ
IMAGE_CODECS = {"mjpeg", "png", "webp", "gif", "bmp", "tiff", "heif", "hevc_image"}
IMAGE_FORMATS = re.compile(r"image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|tiff_pipe|heif")


def find_ffmpeg() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - optional package
        return None


@dataclass
class Probe:
    format_name: str = ""
    major_brand: str = ""
    duration: float = 0.0
    bit_rate: int = 0
    video_codec: str | None = None
    pix_fmt: str = ""
    width: int = 0
    height: int = 0
    fps: float = 0.0
    hdr: bool = False
    audio_codec: str | None = None

    @property
    def has_video(self) -> bool:
        return self.video_codec is not None

    @property
    def is_still_image(self) -> bool:
        if not self.video_codec:
            return False
        return self.video_codec in IMAGE_CODECS and (bool(IMAGE_FORMATS.search(self.format_name)) or self.duration == 0)


def split_top_level(text: str) -> list[str]:
    """Split on commas that aren't inside parentheses."""
    parts, depth, current = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return parts


_INPUT = re.compile(r"^Input #0, (.+?), from ", re.M)
_BRAND = re.compile(r"^\s*major_brand\s*:\s*(\S*)", re.M)
_DURATION = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")
_BITRATE = re.compile(r"Duration:.*?bitrate: (\d+) kb/s")
_STREAM = re.compile(r"^\s*Stream #0:\d+[^:]*: (Video|Audio): (.+)$", re.M)
_ROTATION = re.compile(r"rotation of (-?\d+(?:\.\d+)?) degrees|^\s*rotate\s*:\s*(-?\d+)", re.M)


def parse(text: str) -> Probe:
    info = Probe()
    m = _INPUT.search(text)
    info.format_name = m.group(1) if m else ""
    m = _BRAND.search(text)
    info.major_brand = m.group(1).strip() if m else ""
    m = _DURATION.search(text)
    if m:
        h, mi, s = m.groups()
        info.duration = int(h) * 3600 + int(mi) * 60 + float(s)
    m = _BITRATE.search(text)
    info.bit_rate = int(m.group(1)) * 1000 if m else 0
    rotation = 0
    m = _ROTATION.search(text)
    if m:
        rotation = abs(round(float(m.group(1) or m.group(2) or 0))) % 360
    for kind, rest in _STREAM.findall(text):
        if kind == "Video" and info.video_codec is None:
            if "attached pic" in rest:  # cover art inside an audio file is not a video
                continue
            parts = split_top_level(rest)
            info.video_codec = parts[0].split()[0] if parts and parts[0] else None
            if len(parts) > 1:
                pm = re.match(r"([a-z0-9_]+)", parts[1])
                info.pix_fmt = pm.group(1) if pm else ""
                info.hdr = any(t in parts[1] for t in HDR_TRANSFERS)
            for part in parts[1:]:
                size = re.match(r"(\d{2,5})x(\d{2,5})\b", part)
                if size and not info.width:
                    info.width, info.height = int(size.group(1)), int(size.group(2))
                fps = re.match(r"([\d.]+)(k?) fps", part)
                if fps and not info.fps:
                    info.fps = float(fps.group(1)) * (1000 if fps.group(2) else 1)
            if not info.fps:
                tbr = re.search(r"([\d.]+) tbr", rest)
                info.fps = float(tbr.group(1)) if tbr else 0.0
        elif kind == "Audio" and info.audio_codec is None:
            info.audio_codec = rest.split()[0].rstrip(",")
    if rotation in (90, 270):
        info.width, info.height = info.height, info.width
    return info


def probe(path: Path, ffmpeg: str | None = None) -> Probe:
    exe = ffmpeg or find_ffmpeg()
    if not exe:
        raise RuntimeError("ffmpeg is missing — quit and reopen Fifofarm Ultimate to install it.")
    proc = subprocess.run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                          errors="replace", timeout=120)
    return parse(proc.stderr)
