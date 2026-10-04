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
    NotAVideo,
    append_log,
    fill_from_info,
    find_ffmpeg,
    parse_ffmpeg_info,
    read_archive,
    safe_name,
)
from reelfinder.models import Candidate

FFMPEG = find_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="ffmpeg not available")


def ff(*args: str) -> None:
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def video_server(tmp_path_factory):
    """Serves test media over HTTP, like a video CDN would — including the kinds of files that
    used to arrive broken: music only, HEVC video, and an MPEG-TS stream with an .mp4 name."""
    root = tmp_path_factory.mktemp("cdn")
    ff("-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=4", "-f", "lavfi", "-i",
       "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
       str(root / "clip.mp4"))
    ff("-f", "lavfi", "-i", "sine=frequency=500:duration=4", "-c:a", "aac", str(root / "music_only.mp4"))
    ff("-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=3", "-f", "lavfi", "-i",
       "sine=frequency=700:duration=3", "-shortest", "-c:v", "libx265", "-tag:v", "hev1", "-pix_fmt", "yuv420p",
       "-c:a", "aac", str(root / "hevc.mp4"))
    ff("-f", "lavfi", "-i", "testsrc=size=320x568:rate=25:duration=3", "-f", "lavfi", "-i",
       "sine=frequency=300:duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
       "-f", "mpegts", str(root / "stream.ts"))
    (root / "page.html").write_text("<html><body>not a video</body></html>")
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
    c = Candidate(platform="instagram", id="C1", url="u", caption="kept")
    fill_from_info(c, {"description": "new", "uploader": "who", "view_count": 5, "like_count": 2,
                       "duration": 12.5, "timestamp": 99, "thumbnail": "http://t"})
    assert (c.caption, c.author, c.views, c.likes, c.duration, c.timestamp, c.thumbnail_url) == (
        "kept", "who", 5, 2, 12.5, 99, "http://t")


def test_log_and_archive(tmp_path):
    c = Candidate(platform="tiktok", id="7", url="https://x", caption="line1\nline2", author="me",
                  views=10, duration=12.0, score=88, reason="great", query="#q", file=str(tmp_path / "a.mp4"))
    append_log(tmp_path, c, rank=1)
    append_log(tmp_path, c, rank=2)
    rows = list(csv.DictReader((tmp_path / LOG_NAME).open()))
    assert len(rows) == 2 and rows[0]["caption"] == "line1 line2" and rows[0]["ai_score"] == "88"
    assert rows[0]["file"] == "a.mp4" and rows[0]["likes"] == "" and rows[1]["rank"] == "2"
    assert rows[0]["type"] == "video"
    (tmp_path / "arch.txt").write_text("tiktok 1\n\ninstagram C2\n")
    assert read_archive(tmp_path / "arch.txt") == {"tiktok 1", "instagram C2"}
    assert read_archive(tmp_path / "missing.txt") == set()


def test_parse_ffmpeg_info():
    text = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:00:14.03, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), yuv420p10le(tv, bt709), 1080x1920, 2000 kb/s
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:2[0x3](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s"""
    info = parse_ffmpeg_info(text)
    assert (info.container, info.video_codec, info.video_tag, info.pix_fmt) == (
        "mov,mp4,m4a,3gp,3g2,mj2", "hevc", "hev1", "yuv420p10le")
    assert (info.width, info.height, round(info.duration, 2), info.audio_codecs) == (1080, 1920, 14.03, ["aac", "aac"])
    music = parse_ffmpeg_info("""Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'm.m4a':
  Duration: 00:00:30.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: aac (LC), 44100 Hz, stereo
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 600x600 [SAR 1:1 DAR 1:1], 90k tbn (attached pic)""")
    assert music.video_codec is None and "audio only" in music.summary()


@needs_ffmpeg
def test_download_names_file_records_archive_and_extracts_frames(video_server, tmp_path):
    base, _root = video_server
    dl = Downloader(cookies_file=None)
    c = Candidate(platform="tiktok", id="abc123", url=f"{base}/clip.mp4", author="tester")
    archive = tmp_path / ".reelfinder-archive.txt"
    path = dl.download(c, tmp_path / "hunt", archive)
    assert path.name == "tiktok_tester_abc123.mp4" and path.stat().st_size > 1000
    assert "tiktok abc123" in read_archive(archive)  # never downloaded twice
    assert dl.inspect(path).video_codec == "h264"
    frames = dl.extract_frames(path, 4.0)
    assert len(frames) == 3 and all(f[:2] == b"\xff\xd8" for f in frames)  # JPEGs


@needs_ffmpeg
def test_music_only_files_are_rejected(video_server, tmp_path):
    base, _root = video_server
    c = Candidate(platform="tiktok", id="slideshow1", url=f"{base}/music_only.mp4", author="x")
    archive = tmp_path / "arch.txt"
    with pytest.raises(NotAVideo, match="audio only"):
        Downloader().download(c, tmp_path / "hunt", archive)
    assert list((tmp_path / "hunt").glob("*")) == []  # nothing left behind
    assert read_archive(archive) == set()  # and it can be retried later


@needs_ffmpeg
def test_hevc_is_converted_to_h264(video_server, tmp_path):
    base, _root = video_server
    dl = Downloader()
    c = Candidate(platform="tiktok", id="hevc1", url=f"{base}/hevc.mp4", author="x")
    path = dl.download(c, tmp_path, None)
    info = dl.inspect(path)
    assert path.suffix == ".mp4" and info.video_codec == "h264" and info.pix_fmt == "yuv420p"
    assert info.audio_codecs == ["aac"] and info.duration > 2
    assert [p.name for p in tmp_path.iterdir()] == [path.name]  # the HEVC original is gone


@needs_ffmpeg
def test_mpegts_is_remuxed_to_a_real_mp4(video_server, tmp_path):
    _base, root = video_server
    bad = tmp_path / "pinterest_x_1.mp4"
    bad.write_bytes((root / "stream.ts").read_bytes())  # TS data with an .mp4 name: QuickTime refuses it
    dl = Downloader()
    assert not dl.inspect(bad).is_mp4
    fixed = dl.ensure_playable(bad)
    assert fixed == bad and dl.inspect(fixed).is_mp4 and dl.inspect(fixed).video_codec == "h264"


@needs_ffmpeg
def test_length_limits_are_checked_before_saving(video_server, tmp_path):
    base, _root = video_server
    c = Candidate(platform="tiktok", id="long1", url=f"{base}/clip.mp4", author="x")
    with pytest.raises(NotAVideo, match="Too long"):
        Downloader().download(c, tmp_path, None, max_duration=2)
    with pytest.raises(NotAVideo, match="Too short"):
        Downloader().download(c, tmp_path, None, min_duration=10)


@needs_ffmpeg
def test_a_web_page_is_not_a_video(video_server, tmp_path):
    base, _root = video_server
    c = Candidate(platform="tiktok", id="page1", url=f"{base}/page.html", author="x")
    with pytest.raises(Exception):
        Downloader().download(c, tmp_path, None)
    assert not [p for p in tmp_path.glob("*") if p.suffix == ".mp4"]


@needs_ffmpeg
def test_download_can_be_cancelled(video_server, tmp_path):
    from yt_dlp.utils import DownloadCancelled

    base, _root = video_server
    c = Candidate(platform="tiktok", id="zzz", url=f"{base}/clip.mp4", author="tester")
    with pytest.raises(DownloadCancelled):
        Downloader().download(c, tmp_path, tmp_path / "arch.txt", cancelled=lambda: True)


@needs_ffmpeg
def test_image_pins_are_saved_as_pictures(video_server, tmp_path):
    _base, root = video_server
    ff("-f", "lavfi", "-i", "color=blue:size=200x300", "-frames:v", "1", str(root / "pin.jpg"))
    base = video_server[0]
    c = Candidate(platform="pinterest", id="555", url="https://www.pinterest.com/pin/555/", kind="image",
                  author="someone", image_url=f"{base}/pin.jpg")
    archive = tmp_path / "arch.txt"
    path = Downloader().download_image(c, tmp_path, archive)
    assert path.name == "pinterest_someone_555.jpg" and path.read_bytes()[:2] == b"\xff\xd8"
    assert "pinterest 555" in read_archive(archive)


@needs_ffmpeg
def test_to_jpeg_shrinks_and_converts(tmp_path):
    png = tmp_path / "big.png"
    ff("-f", "lavfi", "-i", "color=red:size=1080x1920", "-frames:v", "1", str(png))
    out = Downloader().to_jpeg(png.read_bytes())
    assert out[:2] == b"\xff\xd8"
    probe = tmp_path / "out.jpg"
    probe.write_bytes(out)
    info = subprocess.run([FFMPEG, "-i", str(probe)], capture_output=True, text=True).stderr
    assert "252x448" in info  # long side capped at 448 px: plenty for the AI, and fast
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
