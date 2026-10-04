"""Downloads with yt-dlp, then makes sure every file is a real video that plays everywhere.

yt-dlp is the open-source downloader that's fixed whenever TikTok, Instagram or Pinterest
change. After it finishes, ffmpeg inspects the file: anything that isn't a video (just
audio, a slideshow's music, a broken page) is thrown away, and anything a Mac can't play
(HEVC/H.265, VP9, AV1, Opus audio, MPEG-TS) is converted to a standard H.264 + AAC MP4.
"""

from __future__ import annotations

import csv
import logging
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import yt_dlp
from yt_dlp.utils import DownloadCancelled

from .logs import ytdlp_logger
from .models import Candidate

log = logging.getLogger("reelfinder.downloader")

ARCHIVE_NAME = ".reelfinder-archive.txt"
LOG_NAME = "reelfinder-log.csv"
LOG_FIELDS = [
    "downloaded_at", "rank", "platform", "type", "file", "url", "author", "caption",
    "views", "likes", "duration", "ai_score", "ai_reason", "query",
]
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
# A single file that already has picture + sound first ("b"); only merge separate streams when a
# site offers nothing else. (Merging "best audio" on TikTok used to add the background-music
# track, which is why some files played only music.) H.264 first so QuickTime can show it.
FORMAT = "b/bv*+ba"
FORMAT_SORT = ["vcodec:h264", "res:1080", "acodec:aac", "ext:mp4:m4a", "proto:https"]
PLAYABLE_VIDEO = {"h264"}
PLAYABLE_AUDIO = {"aac", "mp3"}
IMAGE_EXTS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


class NotAVideo(Exception):
    """The download turned out to be audio only, a photo/slideshow, or not media at all."""


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


def length_problem(duration, min_duration: float = 0, max_duration: float = 0) -> str | None:
    if not isinstance(duration, (int, float)):
        return None
    if min_duration and duration < min_duration:
        return f"Too short ({duration:.0f}s)"
    if max_duration and duration > max_duration:
        return f"Too long ({duration:.0f}s)"
    return None


def add_to_archive(path: Path, archive_id: str) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(archive_id + "\n")


def fill_from_info(c: Candidate, info: dict) -> None:
    """Copy what yt-dlp learned about a video onto the candidate."""
    c.caption = c.caption or info.get("description") or info.get("title") or ""
    c.author = c.author or info.get("uploader") or info.get("channel") or info.get("uploader_id") or ""
    for name, key in (("views", "view_count"), ("likes", "like_count"), ("timestamp", "timestamp")):
        if getattr(c, name) is None and isinstance(info.get(key), (int, float)):
            setattr(c, name, int(info[key]))
    if c.duration is None and isinstance(info.get("duration"), (int, float)):
        c.duration = float(info["duration"])
    c.thumbnail_url = c.thumbnail_url or info.get("thumbnail")


def append_log(folder: Path, c: Candidate, rank: int | None = None) -> None:
    path = folder / LOG_NAME
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=LOG_FIELDS)
        if new:
            writer.writeheader()
        writer.writerow({
            "downloaded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "rank": rank or "",
            "platform": c.platform,
            "type": c.kind,
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


# ---------------------------------------------------------------- inspecting media

@dataclass
class MediaInfo:
    container: str = ""
    duration: float = 0.0
    video_codec: str | None = None
    video_tag: str = ""
    pix_fmt: str = ""
    width: int = 0
    height: int = 0
    audio_codecs: list[str] = field(default_factory=list)

    @property
    def is_mp4(self) -> bool:
        return "mp4" in self.container

    def summary(self) -> str:
        if not self.video_codec:
            return f"audio only ({self.audio_codecs[0].upper()}), no picture" if self.audio_codecs else "no picture"
        sound = f" + {self.audio_codecs[0].upper()} sound" if self.audio_codecs else " (no sound)"
        return f"{self.video_codec.upper()} {self.width}×{self.height}{sound}, {self.duration:.0f} s"


_DURATION = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")
_INPUT = re.compile(r"^Input #0, ([^,]+(?:,[^,\s']+)*), from", re.M)
_VIDEO = re.compile(r"Stream #0:\d+.*?: Video: (\w+)([^\n]*)")
_AUDIO = re.compile(r"Stream #0:\d+.*?: Audio: (\w+)")


def parse_ffmpeg_info(text: str) -> MediaInfo:
    info = MediaInfo()
    m = _INPUT.search(text)
    info.container = m.group(1) if m else ""
    m = _DURATION.search(text)
    if m:
        h, mi, s = m.groups()
        info.duration = int(h) * 3600 + int(mi) * 60 + float(s)
    for vm in _VIDEO.finditer(text):
        rest = vm.group(2)
        if "attached pic" in rest:  # cover art inside an audio file is not a video
            continue
        info.video_codec = vm.group(1)
        tag = re.search(r"\((\w{4}) / 0x", rest)
        info.video_tag = tag.group(1) if tag else ""
        pix = re.search(r",\s*([a-z0-9]+(?:le|be)?)(?:\(|,)", rest)
        info.pix_fmt = pix.group(1) if pix else ""
        size = re.search(r"\b(\d{2,5})x(\d{2,5})\b", rest)
        if size:
            info.width, info.height = int(size.group(1)), int(size.group(2))
        break
    info.audio_codecs = _AUDIO.findall(text)
    return info


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
            "logger": ytdlp_logger(),
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

    # ------------------------------------------------------------ videos

    def download(self, c: Candidate, folder: Path, archive: Path | None,
                 cancelled: Callable[[], bool] = lambda: False,
                 min_duration: float = 0, max_duration: float = 0) -> Path:
        """Download one video as a playable H.264 MP4. Raises NotAVideo if it has no picture
        (or is outside your length limits — checked before anything is downloaded)."""
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{c.platform}_{safe_name(c.author)}_{safe_name(c.id, 30)}"

        def hook(_status: dict) -> None:
            if cancelled():
                raise DownloadCancelled("Hunt stopped")

        def wrong_length(info: dict, *, incomplete: bool) -> str | None:
            return length_problem(info.get("duration"), min_duration, max_duration)

        def run(opts: dict) -> dict:
            opts.update({
                "outtmpl": str(folder / f"{stem}.%(ext)s"),
                "format": FORMAT,
                "format_sort": FORMAT_SORT,
                "merge_output_format": "mp4",
                "progress_hooks": [hook],
                "match_filter": wrong_length,
            })
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(c.url, download=True) or {}

        try:
            info = self._with_cookies(run)
        except yt_dlp.utils.DownloadError as exc:
            text = str(exc).lower()
            if "no video" in text or "requested format is not available" in text or "no formats" in text:
                raise NotAVideo("There's no video in this post (photo or slideshow)") from exc
            raise
        fill_from_info(c, info)
        problem = length_problem(c.duration, min_duration, max_duration)
        if problem:
            raise NotAVideo(problem)
        path = self._downloaded_file(info, folder, stem)
        final, media = self._make_playable(path)
        if c.duration is None and media.duration:
            c.duration = media.duration
            problem = length_problem(c.duration, min_duration, max_duration)
            if problem:  # some sites only reveal the length once the file is here
                final.unlink(missing_ok=True)
                raise NotAVideo(problem)
        if archive is not None:
            add_to_archive(archive, c.archive_id)
        return final

    @staticmethod
    def _downloaded_file(info: dict, folder: Path, stem: str) -> Path:
        for item in info.get("requested_downloads") or []:
            if item.get("filepath") and Path(item["filepath"]).exists():
                return Path(item["filepath"])
        matches = sorted(folder.glob(f"{stem}.*"), key=lambda p: p.stat().st_size, reverse=True)
        matches = [p for p in matches if p.suffix not in (".part", ".ytdl", ".jpg", ".webp")]
        if not matches:
            raise NotAVideo("Nothing was downloaded")
        return matches[0]

    def inspect(self, path: Path) -> MediaInfo:
        if not self.ffmpeg:
            return MediaInfo(container="mp4" if path.suffix == ".mp4" else "", video_codec="h264")
        proc = subprocess.run([self.ffmpeg, "-hide_banner", "-i", str(path)],
                              capture_output=True, text=True, errors="replace", timeout=60)
        return parse_ffmpeg_info(proc.stderr)

    def ensure_playable(self, path: Path) -> Path:
        """Return a standard H.264/AAC .mp4 next to `path` (converting if needed), or raise NotAVideo."""
        return self._make_playable(path)[0]

    def _make_playable(self, path: Path) -> tuple[Path, MediaInfo]:
        info = self.inspect(path)
        if not info.video_codec or info.duration < 0.3:
            path.unlink(missing_ok=True)
            raise NotAVideo(f"Not a real video — {info.summary()}")
        if not self.ffmpeg:
            return path, info
        video_ok = info.video_codec in PLAYABLE_VIDEO and info.pix_fmt in ("yuv420p", "yuvj420p", "")
        audio_ok = not info.audio_codecs or info.audio_codecs[0] in PLAYABLE_AUDIO
        tidy = info.is_mp4 and path.suffix.lower() == ".mp4" and len(info.audio_codecs) <= 1
        if video_ok and audio_ok and tidy:
            return path, info

        final = path.with_suffix(".mp4")
        tmp = path.with_name(path.stem + ".converting.mp4")
        audio = ["-c:a", "copy"] if audio_ok else ["-c:a", "aac", "-b:a", "160k"]
        encoders = [["-c:v", "copy"]] if video_ok else [
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"],
            ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"],  # Mac hardware encoder
            ["-c:v", "mpeg4", "-q:v", "3"],
        ]
        for video in encoders:
            cmd = [self.ffmpeg, "-y", "-v", "error", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?",
                   *video, *audio, "-movflags", "+faststart", str(tmp)]
            proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=900)
            if proc.returncode == 0 and tmp.exists():
                check = self.inspect(tmp)
                if check.video_codec and check.duration >= 0.3:
                    log.info("Converted %s (%s) → %s", path.name, info.summary(), check.summary())
                    if path != final:
                        path.unlink(missing_ok=True)
                    tmp.replace(final)
                    return final, check
            log.warning("ffmpeg couldn't convert %s with %s: %s", path.name, video[1], proc.stderr[-300:])
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Couldn't convert {path.name} to a playable MP4")

    # ------------------------------------------------------------ images (Pinterest image pins)

    def download_image(self, c: Candidate, folder: Path, archive: Path | None) -> Path:
        url = c.image_url or c.thumbnail_url
        if not url:
            raise NotAVideo("No picture to save")
        folder.mkdir(parents=True, exist_ok=True)
        with httpx.Client(timeout=60, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": BROWSER_UA, "Referer": f"https://www.{c.platform}.com/"})
        ctype = resp.headers.get("content-type", "").split(";")[0].strip()
        if resp.status_code != 200 or not ctype.startswith("image"):
            raise RuntimeError(f"Couldn't fetch the picture (HTTP {resp.status_code})")
        path = folder / f"{c.platform}_{safe_name(c.author)}_{safe_name(c.id, 30)}{IMAGE_EXTS.get(ctype, '.jpg')}"
        path.write_bytes(resp.content)
        if archive is not None:
            add_to_archive(archive, c.archive_id)
        return path

    # ------------------------------------------------------------ helpers

    def to_jpeg(self, image: bytes, max_side: int = 448) -> bytes:
        """Covers arrive as webp/jpeg of any size; the AI and the UI both want a small JPEG."""
        if not self.ffmpeg:
            return image
        scale = f"scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'"
        try:
            proc = subprocess.run(
                [self.ffmpeg, "-v", "error", "-i", "pipe:0", "-frames:v", "1",
                 "-vf", scale, "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "-"],
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
                 "-vf", "scale=448:-2", "-f", "image2", "-c:v", "mjpeg", "-"],
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
