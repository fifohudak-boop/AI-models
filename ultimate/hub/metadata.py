"""Metadata clean-up: strip the hidden data files carry — camera make/model, GPS location, dates,
editing/AI tags — so what you post reveals nothing you didn't intend. This only *removes* metadata
(the normal step before posting); it never writes fake camera or device information into a file."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from . import library, mediainfo, personas

log = logging.getLogger("ultimate.metadata")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".tif", ".heic", ".heif", ".bmp", ".gif"}
# What we look for and report, in plain words.
LOCATION_KEYS = ("location", "gps", "com.apple.quicktime.location")
DEVICE_KEYS = ("make", "model", "com.apple.quicktime.make", "com.apple.quicktime.model", "device", "software", "encoder")
DATE_KEYS = ("creation_time", "date", "com.apple.quicktime.creationdate", "datetimeoriginal")


class MetadataError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _label(key: str) -> str | None:
    k = key.lower()
    if any(s in k for s in LOCATION_KEYS):
        return "location"
    if any(s in k for s in DEVICE_KEYS):
        return "device"
    if any(s in k for s in DATE_KEYS):
        return "date"
    return "other"


# Tags every file carries no matter what (ffmpeg writes them on any copy) — not worth flagging.
BENIGN = {"major_brand", "minor_version", "compatible_brands", "handler_name", "vendor_id", "encoder"}


def _video_tags(path: Path) -> list[str]:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        return []
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-v", "error", "-i", str(path), "-f", "ffmetadata", "-"],
                             capture_output=True, text=True, errors="replace", timeout=30).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    tags: set[str] = set()
    for line in out.splitlines():
        if line.startswith("["):  # only the global section — per-stream handler tags are unavoidable
            break
        if "=" in line and not line.startswith((";", "#")):
            key, _, value = line.partition("=")
            if value.strip() and key.strip().lower() not in BENIGN:
                label = _label(key)
                if label:
                    tags.add(label)
    return sorted(tags)


def _image_tags(path: Path) -> list[str]:
    tags: set[str] = set()
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(path) as img:
            exif = img.getexif()
            if exif:
                if exif.get(271) or exif.get(272) or exif.get(305):  # Make, Model, Software
                    tags.add("device")
                if exif.get(306) or exif.get(36867):  # DateTime, DateTimeOriginal
                    tags.add("date")
                if 34853 in exif:  # GPSInfo
                    tags.add("location")
                if exif and not tags:
                    tags.add("other")
    except Exception:  # noqa: BLE001 - unreadable metadata just means we report none
        pass
    # XMP / C2PA (AI provenance) lives in the raw bytes.
    try:
        head = path.read_bytes()[:200_000]
        if b"c2pa" in head or b"contentauth" in head.lower() or b"<x:xmpmeta" in head:
            tags.add("AI/edit tag")
    except OSError:
        pass
    return sorted(tags)


def scan(path: Path) -> dict:
    kind = library.media_kind(path)
    tags = _image_tags(path) if path.suffix.lower() in IMAGE_EXT else _video_tags(path) if kind == "video" else []
    return {"tags": tags, "clean": not tags}


def _clean_video(path: Path) -> None:
    ffmpeg = mediainfo.find_ffmpeg()
    if not ffmpeg:
        raise MetadataError("ffmpeg is missing — reopen Fifofarm Ultimate to reinstall it.")
    tmp = path.with_suffix(f".clean{path.suffix}")
    # Copy the streams (no re-encode), drop all metadata and chapters.
    proc = subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-v", "error", "-i", str(path), "-map", "0", "-map_metadata", "-1",
         "-map_metadata:s", "-1", "-map_chapters", "-1", "-c", "copy", "-movflags", "+faststart", str(tmp)],
        capture_output=True, text=True, errors="replace", timeout=600)
    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise MetadataError(f"Couldn't clean {path.name}: {' '.join(proc.stderr.strip().splitlines()[-2:])[:200]}", 500)
    tmp.replace(path)


def _clean_image(path: Path) -> None:
    from PIL import Image  # noqa: PLC0415

    suffix = path.suffix.lower()
    tmp = path.with_suffix(f".clean{path.suffix}")
    try:
        with Image.open(path) as img:
            fmt = img.format
            data = img.convert(img.mode if img.mode in ("RGB", "RGBA", "L") else "RGB")
            params: dict = {}
            if (fmt or "").upper() in ("JPEG", "JPG") or suffix in (".jpg", ".jpeg"):
                params = {"quality": 95, "format": "JPEG"}
                data = data.convert("RGB")
            # Saving a fresh image with no exif/xmp/icc drops camera, GPS, date and AI tags.
            data.save(tmp, **params)
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise MetadataError(f"Couldn't clean {path.name}: {exc}", 500) from exc
    tmp.replace(path)


def clean_file(persona: dict, path: Path) -> None:
    if not path.is_file() or not personas.inside_folders(persona, path):
        raise MetadataError(f"{path.name} isn't in this model's folders.")
    if path.suffix.lower() in IMAGE_EXT:
        _clean_image(path)
    elif library.media_kind(path) == "video":
        _clean_video(path)
    else:
        raise MetadataError(f"{path.name} isn't a photo or video.")
