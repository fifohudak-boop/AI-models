"""Downloads with yt-dlp, which is updated whenever TikTok or Instagram change."""

from __future__ import annotations

import csv
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

import httpx
import yt_dlp
from yt_dlp.utils import DownloadCancelled

from .models import Candidate

ARCHIVE_NAME = ".reelfinder-archive.txt"
LOG_NAME = "reelfinder-log.csv"
LOG_FIELDS = [
    "downloaded_at", "platform", "file", "url", "author", "caption",
    "views", "likes", "duration", "ai_score", "ai_reason", "query",
]
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
# Best quality up to 1080p, H.264 preferred so files open in QuickTime and every editor.
FORMAT = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
FORMAT_SORT = ["res:1080", "vcodec:h264"]


def find_ffmpeg() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def safe_name(text: str, limit: int = 40) -> str:
    return re.sub(r"[^\w.-]+", "", text or "")[:limit].strip(".") or "unknown"


def read_archive(path: Path) -> set[str]:
    try:
        return {line.strip() for line in path.read_text().splitlines() if line.strip()}
    except OSError:
        return set()


def fill_from_info(c: Candidate, info: dict) -> None:
    """Copy what yt-dlp learned about a video onto the candidate."""
    c.caption = c.caption or info.get("description") or info.get("title") or ""
    c.author = c.author or info.get("uploader") or info.get("channel") or info.get("uploader_id") or ""
    for field, key in (("views", "view_count"), ("likes", "like_count"), ("timestamp", "timestamp")):
        if getattr(c, field) is None and isinstance(info.get(key), (int, float)):
            setattr(c, field, int(info[key]))
    if c.duration is None and isinstance(info.get("duration"), (int, float)):
        c.duration = float(info["duration"])
    c.thumbnail_url = c.thumbnail_url or info.get("thumbnail")
    c.maybe_not_video = False


def append_log(folder: Path, c: Candidate) -> None:
    path = folder / LOG_NAME
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS)
        if new:
            writer.writeheader()
        writer.writerow({
            "downloaded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "platform": c.platform,
            "file": Path(c.file).name if c.file else "",
            "url": c.url,
            "author": c.author,
            "caption": c.caption.replace("\n", " ")[:500],
            "views": c.views if c.views is not None else "",
            "likes": c.likes if c.likes is not None else "",
            "duration": f"{c.duration:.0f}" if c.duration else "",
            "ai_score": c.score if c.score is not None else "",
            "ai_reason": c.reason,
            "query": c.query,
        })


class Downloader:
    def __init__(self, cookies_file: Path | None = None, ffmpeg: str | None = None):
        self.cookies_file = cookies_file
        self.ffmpeg = ffmpeg if ffmpeg is not None else find_ffmpeg()

    def _opts(self, cookie_copy: str | None) -> dict:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "retries": 3,
            "fragment_retries": 3,
            "socket_timeout": 30,
        }
        if cookie_copy:
            opts["cookiefile"] = cookie_copy
        if self.ffmpeg:
            opts["ffmpeg_location"] = self.ffmpeg
        return opts

    def _with_cookies(self, fn: Callable[[dict], dict]) -> dict:
        # yt-dlp rewrites its cookie file when done; give each call its own copy so
        # parallel downloads never clobber the shared one.
        if self.cookies_file and self.cookies_file.exists():
            with tempfile.TemporaryDirectory() as tmp:
                copy = Path(tmp) / "cookies.txt"
                shutil.copyfile(self.cookies_file, copy)
                return fn(self._opts(str(copy)))
        return fn(self._opts(None))

    def probe(self, url: str) -> dict:
        """Metadata only (no download). Raises yt_dlp DownloadError if it isn't a video."""
        def run(opts: dict) -> dict:
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.sanitize_info(ydl.extract_info(url, download=False)) or {}
        return self._with_cookies(run)

    def download(self, c: Candidate, folder: Path, archive: Path, cancelled: Callable[[], bool] = lambda: False) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{c.platform}_{safe_name(c.author)}_{safe_name(c.id, 30)}"

        def hook(_status: dict) -> None:
            if cancelled():
                raise DownloadCancelled("Hunt stopped")

        def run(opts: dict) -> dict:
            opts.update({
                "outtmpl": str(folder / f"{stem}.%(ext)s"),
                "format": FORMAT,
                "format_sort": FORMAT_SORT,
                "merge_output_format": "mp4",
                "download_archive": str(archive),
                "progress_hooks": [hook],
            })
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(c.url, download=True) or {}

        info = self._with_cookies(run)
        fill_from_info(c, info)
        for item in info.get("requested_downloads") or []:
            if item.get("filepath") and Path(item["filepath"]).exists():
                return Path(item["filepath"])
        matches = sorted(folder.glob(f"{stem}.*"), key=lambda p: p.stat().st_size, reverse=True)
        matches = [p for p in matches if p.suffix not in (".part", ".ytdl")]
        if not matches:
            raise RuntimeError("yt-dlp finished but no file was written")
        return matches[0]

    def to_jpeg(self, image: bytes, max_width: int = 640) -> bytes:
        """Covers arrive as webp/jpeg of any size; the AI and the UI both want a small JPEG."""
        if not self.ffmpeg:
            return image
        try:
            proc = subprocess.run(
                [self.ffmpeg, "-v", "error", "-i", "pipe:0", "-frames:v", "1",
                 "-vf", f"scale='min({max_width},iw)':-2", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "-"],
                input=image, capture_output=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return image
        return proc.stdout if proc.returncode == 0 and proc.stdout else image

    def extract_frames(self, video: Path, duration: float | None, count: int = 3) -> list[bytes]:
        if not self.ffmpeg:
            return []
        length = duration or 6.0
        frames = []
        for i in range(count):
            t = length * (0.15 + 0.7 * i / max(count - 1, 1))
            proc = subprocess.run(
                [self.ffmpeg, "-v", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1",
                 "-vf", "scale=512:-2", "-f", "image2", "-c:v", "mjpeg", "-"],
                capture_output=True, timeout=60,
            )
            if proc.returncode == 0 and proc.stdout:
                frames.append(proc.stdout)
        return frames


async def fetch_image(url: str, referer: str) -> bytes | None:
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": BROWSER_UA, "Referer": referer})
            if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image"):
                return resp.content
    except httpx.HTTPError:
        pass
    return None
