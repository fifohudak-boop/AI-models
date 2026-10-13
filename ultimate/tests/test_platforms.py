"""The network rules copied from Fifofarm behave like Fifofarm's (its tests, in Python)."""

from __future__ import annotations

from hub.mediainfo import parse
from hub.platforms import (
    build_post_request, build_settings, count_length, fit_caption, platform_catalog, preflight, to_postiz_html,
    youtube_title,
)

VIDEO = {
    "kind": "video",
    "name": "clip.mov",
    "video": {"id": "v1", "path": "https://p.example/uploads/v1.mp4"},
    "cover": {"id": "c1", "path": "https://p.example/uploads/c1.jpg"},
    "durationSeconds": 30,
    "sizeBytes": 5_000_000,
}


def account(identifier: str, **extra) -> dict:
    return {"id": f"acc-{identifier}", "identifier": identifier, "name": "Me", "disabled": False, **extra}


def test_captions_become_one_paragraph_per_line_with_html_escaped():
    assert to_postiz_html("Tom & Jerry <3\n\nbye") == "<p>Tom &amp; Jerry &lt;3</p><p></p><p>bye</p>"
    assert to_postiz_html("a\r\nb") == "<p>a</p><p>b</p>"
    assert to_postiz_html("it's \"x\"") == "<p>it&#39;s &quot;x&quot;</p>"


def test_lengths_count_like_each_network():
    assert count_length("x", "hi https://example.com/a/very/long/path/that/keeps/going") == 3 + 23
    assert count_length("threads", "é") == 2
    assert count_length("youtube", "é") == 1
    assert count_length("youtube", "🎉") == 2  # JavaScript counts emoji as two
    assert count_length("x", "日本") == 4


def test_fit_caption_shortens_at_a_word_boundary():
    long = " ".join(["word"] * 100)
    text, shortened = fit_caption("x", long, 280)
    assert shortened and count_length("x", text) <= 280 and text.endswith("…")
    assert "wor…" not in text
    assert fit_caption("x", "short", 280) == ("short", False)
    emoji, _ = fit_caption("x", "🎉" * 400, 280)
    assert count_length("x", emoji) <= 280


def test_youtube_title_rules():
    assert youtube_title("", "\nMy trip\nmore", "clip.mov") == "My trip"
    assert youtube_title("  Set   title ", "x", "") == "Set title"
    assert youtube_title("", "", "clip") == "clip"
    assert youtube_title("", "", "") == "New video"
    assert youtube_title("A", "", "") == "A video"
    assert len(youtube_title("x" * 150, "", "")) <= 100


def test_each_network_gets_the_settings_the_engine_requires():
    prefs = {"youtubeVisibility": "unlisted", "tiktokPrivacy": "SELF_ONLY", "pinterestBoards": {"acc-pinterest": "123"}}
    kw = {"title": "", "caption": "Hello", "media_name": "clip.mov", "prefs": prefs}
    assert build_settings(account("youtube"), **kw) == {
        "__type": "youtube", "title": "Hello", "type": "unlisted", "selfDeclaredMadeForKids": "no", "tags": []}
    tiktok = build_settings(account("tiktok"), **kw)
    assert tiktok["privacy_level"] == "SELF_ONLY" and tiktok["content_posting_method"] == "DIRECT_POST"
    for key in ("duet", "stitch", "comment", "brand_content_toggle", "brand_organic_toggle"):
        assert isinstance(tiktok[key], bool)
    assert build_settings(account("instagram-standalone"), **kw)["post_type"] == "post"
    assert build_settings(account("x"), **kw)["who_can_reply_post"] == "everyone"
    assert build_settings(account("pinterest"), **kw)["board"] == "123"
    assert build_settings(account("bluesky"), **kw) == {"__type": "bluesky"}


def test_pinterest_gets_the_cover_next_to_the_video():
    def images(ident):
        body, _ = build_post_request(account(ident), {"caption": "c", "media": VIDEO}, {}, 500)
        return [m["id"] for m in body["posts"][0]["value"][0]["image"]]

    assert images("pinterest") == ["v1", "c1"]
    assert images("youtube") == ["v1"]


def test_now_vs_schedule_per_account_caption_and_auto_shorten():
    body, shortened = build_post_request(account("x"), {"caption": "a " * 200, "media": VIDEO}, {"autoShorten": True}, 280)
    assert body["type"] == "now" and shortened and body["posts"][0]["integration"]["id"] == "acc-x"
    later, _ = build_post_request(account("bluesky"), {"caption": "main", "captions": {"acc-bluesky": "special"},
                                                       "media": None, "scheduleAt": "2030-01-01T10:00:00.000Z"}, {}, 300)
    assert later["type"] == "schedule" and later["date"] == "2030-01-01T10:00:00.000Z"
    assert later["posts"][0]["value"][0] == {"content": "<p>special</p>", "image": []}
    _, not_shortened = build_post_request(account("x"), {"caption": "a " * 200}, {"autoShorten": False}, 280)
    assert not_shortened is False


def test_preflight_blocks_what_would_fail():
    assert preflight(account("youtube"), None, {})[0] == ["YouTube needs a video."]
    assert preflight(account("tiktok"), None, {})[0] == ["TikTok needs a photo or video."]
    assert preflight(account("x"), None, {})[0] == []
    assert len(preflight(account("pinterest"), VIDEO, {"pinterestBoards": {}})[0]) == 1
    assert len(preflight(account("reddit"), VIDEO, {})[0]) == 1
    assert len(preflight(account("x", disabled=True), VIDEO, {})[0]) == 1
    long_video = {**VIDEO, "durationSeconds": 200}
    assert len(preflight(account("x"), long_video, {})[1]) == 1
    assert len(preflight(account("youtube"), long_video, {})[1]) == 0


def test_catalog_lists_connectable_networks():
    ids = [p["identifier"] for p in platform_catalog()]
    assert "instagram-standalone" in ids and "telegram" not in ids


def test_reads_what_ffmpeg_says_about_a_file():
    iphone = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_1.MOV':
  Metadata:
    major_brand     : qt
  Duration: 00:00:12.50, start: 0.000000, bitrate: 15234 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 15000 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 160 kb/s (default)
"""
    info = parse(iphone)
    assert info.format_name.startswith("mov,mp4")
    assert info.major_brand == "qt"
    assert info.duration == 12.5 and info.bit_rate == 15_234_000
    assert info.video_codec == "hevc" and info.pix_fmt == "yuv420p10le" and info.hdr
    assert (info.width, info.height) == (1080, 1920)  # turned upright
    assert info.fps == 29.97 and info.audio_codec == "aac"
    photo = parse("""Input #0, png_pipe, from 'a.png':
  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: png, rgba(pc), 800x600, 25 fps, 25 tbr, 25 tbn
""")
    assert photo.is_still_image and (photo.width, photo.height) == (800, 600)
    cover = parse("""Input #0, mp3, from 'song.mp3':
  Duration: 00:03:00.00, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
""")
    assert not cover.has_video and cover.audio_codec == "mp3"
