"""A model's library: the videos and pictures in its folders (Reel Finder finds, AI Studio videos,
your reference folder and the model's photos), with small preview images.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from .config import THUMB_CACHE_DIR
from .mediainfo import find_ffmpeg

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"}
MAX_ITEMS = 600


def media_kind(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    return None


def list_folder(root: Path, *, images_only: bool = False, limit: int = MAX_ITEMS) -> list[dict]:
    if not root.is_dir():
        return []
    found: list[tuple[float, Path, int]] = []
    try:
        for path in root.rglob("*"):
            if any(part.startswith(".") for part in path.relative_to(root).parts):
                continue
            kind = media_kind(path)
            if not kind or (images_only and kind != "image") or ".converting." in path.name:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if not path.is_file() or stat.st_size == 0:
                continue
            found.append((stat.st_mtime, path, stat.st_size))
    except OSError:
        pass
    found.sort(key=lambda x: x[0], reverse=True)
    items = []
    for mtime, path, size in found[:limit]:
        rel_dir = str(path.parent.relative_to(root)) if path.parent != root else ""
        items.append({
            "path": str(path),
            "name": path.name,
            "folder": "" if rel_dir == "." else rel_dir,
            "kind": media_kind(path),
            "size": size,
            "modified": mtime,
        })
    return items


def thumbnail(path: Path, width: int = 360) -> Path | None:
    """A small JPEG preview (cached), or None if it can't be made."""
    try:
        stat = path.stat()
    except OSError:
        return None
    key = hashlib.sha1(f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode()).hexdigest()
    target = THUMB_CACHE_DIR / f"{key}.jpg"
    if target.exists():
        return target
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    kind = media_kind(path)
    seek = ["-ss", "1"] if kind == "video" else []
    for attempt in (seek, []):  # a video shorter than a second has no frame at 1 s
        proc = subprocess.run(
            [ffmpeg, "-y", "-v", "error", *attempt, "-i", str(path), "-frames:v", "1",
             "-vf", f"scale='min({width},iw)':-2", "-q:v", "4", str(target)],
            capture_output=True, timeout=60,
        )
        if proc.returncode == 0 and target.exists() and target.stat().st_size > 0:
            return target
        if kind != "video":
            break
    target.unlink(missing_ok=True)
    return None
