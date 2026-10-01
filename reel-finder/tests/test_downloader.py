import csv
import functools
import http.server
import subprocess
import threading
from pathlib import Path

import pytest

from reelfinder.downloader import (
    LOG_NAME,
    Downloader,
    append_log,
    fill_from_info,
    find_ffmpeg,
    read_archive,
    safe_name,
)
from reelfinder.models import Candidate

FFMPEG = find_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")


@pytest.fixture(scope="module")
def video_server(tmp_path_factory):
    """Serves a 4-second test clip over HTTP, like a video CDN would."""
    root = tmp_path_factory.mktemp("cdn")
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=4",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(root / "clip.mp4")], check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", root
    server.shutdown()


def test_safe_name():
    assert safe_name("drift king!! 🚗/..") == "driftking"
    assert safe_name("") == "unknown"
    assert safe_name("a" * 99) == "a" * 40
    assert "%" not in safe_name("100%_real")


def test_fill_from_info_only_fills_gaps():
    c = Candidate(platform="instagram", id="C1", url="u", caption="kept", maybe_not_video=True)
    fill_from_info(c, {"description": "new", "uploader": "who", "view_count": 5, "like_count": 2,
                       "duration": 12.5, "timestamp": 99, "thumbnail": "http://t"})
    assert (c.caption, c.author, c.views, c.likes, c.duration, c.timestamp, c.thumbnail_url) == (
        "kept", "who", 5, 2, 12.5, 99, "http://t")
    assert c.maybe_not_video is False


def test_log_and_archive(tmp_path):
    c = Candidate(platform="tiktok", id="7", url="https://x", caption="line1\nline2", author="me",
                  views=10, duration=12.0, score=88, reason="great", query="#q", file=str(tmp_path / "a.mp4"))
    append_log(tmp_path, c)
    append_log(tmp_path, c)
    rows = list(csv.DictReader((tmp_path / LOG_NAME).open()))
    assert len(rows) == 2 and rows[0]["caption"] == "line1 line2" and rows[0]["ai_score"] == "88"
    assert rows[0]["file"] == "a.mp4" and rows[0]["likes"] == ""
    (tmp_path / "arch.txt").write_text("tiktok 1\n\ninstagram C2\n")
    assert read_archive(tmp_path / "arch.txt") == {"tiktok 1", "instagram C2"}
    assert read_archive(tmp_path / "missing.txt") == set()


@needs_ffmpeg
def test_download_names_file_records_archive_and_extracts_frames(video_server, tmp_path):
    base, _root = video_server
    dl = Downloader(cookies_file=None)
    c = Candidate(platform="tiktok", id="abc123", url=f"{base}/clip.mp4", author="tester")
    archive = tmp_path / ".reelfinder-archive.txt"
    path = dl.download(c, tmp_path / "hunt", archive)
    assert path.name == "tiktok_tester_abc123.mp4" and path.stat().st_size > 1000
    assert read_archive(archive)  # yt-dlp recorded it, so it's never downloaded twice
    frames = dl.extract_frames(path, 4.0)
    assert len(frames) == 3 and all(f[:2] == b"\xff\xd8" for f in frames)  # JPEGs


@needs_ffmpeg
def test_download_can_be_cancelled(video_server, tmp_path):
    from yt_dlp.utils import DownloadCancelled

    base, _root = video_server
    c = Candidate(platform="tiktok", id="zzz", url=f"{base}/clip.mp4", author="tester")
    with pytest.raises(DownloadCancelled):
        Downloader().download(c, tmp_path, tmp_path / "arch.txt", cancelled=lambda: True)


@needs_ffmpeg
def test_to_jpeg_shrinks_and_converts(tmp_path):
    png = tmp_path / "big.png"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=red:size=1080x1920", "-frames:v", "1", str(png)],
                   check=True)
    out = Downloader().to_jpeg(png.read_bytes())
    assert out[:2] == b"\xff\xd8"
    probe = tmp_path / "out.jpg"
    probe.write_bytes(out)
    info = subprocess.run([FFMPEG, "-i", str(probe)], capture_output=True, text=True).stderr
    assert "640x1138" in info  # width capped at 640, even height
    assert Downloader().to_jpeg(b"not an image") == b"not an image"


def test_cookies_are_copied_per_call(tmp_path):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n")
    seen = []
    dl = Downloader(cookies_file=cookies, ffmpeg="")
    dl._with_cookies(lambda opts: seen.append(opts.get("cookiefile")) or {})
    assert seen[0] and Path(seen[0]) != cookies and not Path(seen[0]).exists()  # temp copy, cleaned up


def test_ytdlp_warnings_reach_our_log(caplog):
    from reelfinder.logs import ytdlp_logger

    logger = ytdlp_logger()
    with caplog.at_level("WARNING", logger="reelfinder.ytdlp"):
        logger.debug("[debug] noise")
        logger.warning("[Instagram] login required")
        logger.error("ERROR: unable to download")
    assert [r.getMessage() for r in caplog.records] == ["[Instagram] login required", "ERROR: unable to download"]
    assert "logger" in Downloader()._opts(None)
