"""End-to-end: real Chromium agents scrolling a stand-in TikTok/Instagram, then real yt-dlp downloads."""

import asyncio
import csv
import os
from pathlib import Path

import pytest

from fakesite import FakeSite
from reelfinder.ai import KeywordBrain
from reelfinder.browser import BrowserManager
from reelfinder.config import HuntSettings
from reelfinder.downloader import LOG_NAME, Downloader, find_ffmpeg
from reelfinder.hunt import Hunt
from reelfinder.scouts import Instagram, Pinterest, Scout, TikTok

if not os.environ.get("REELFINDER_BROWSER_PATH") and Path("/opt/pw-browsers/chromium").exists():
    os.environ["REELFINDER_BROWSER_PATH"] = "/opt/pw-browsers/chromium"

pytestmark = pytest.mark.skipif(not find_ffmpeg(), reason="needs ffmpeg for the fake site's media")


@pytest.fixture(scope="module")
def site():
    fake = FakeSite().start()
    yield fake
    fake.stop()


def run_scout(tmp_path, site_obj, query, **opts):
    found, states = {}, []

    async def go():
        browser = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "cookies.txt")
        try:
            page = await browser.new_page(headless=True)
        except RuntimeError as exc:
            pytest.skip(f"no browser available: {exc}")
        queue = asyncio.Queue()
        queue.put_nowait(query)

        async def on_found(c):
            if c.key in found:
                found[c.key].merge(c)
            else:
                found[c.key] = c

        scout = Scout(1, site_obj, page, queue, on_found, lambda s: states.append(s["state"]), asyncio.Event(),
                      pace=(0.15, 0.3), patience=3, max_scrolls=12, **opts)
        await asyncio.wait_for(scout.run(), 90)
        await browser.close()

    asyncio.run(go())
    return found, states


def test_tiktok_agent_scrolls_and_reads_json_and_links(tmp_path, site):
    found, states = run_scout(tmp_path, TikTok(site.url), "night drift")
    assert len(found) == 24  # 4 pages × 6, loaded by scrolling
    assert all(c.views and c.thumbnail_url and c.duration for c in found.values())  # details from the JSON
    assert all(c.url.startswith(site.url + "/@driver") for c in found.values())
    assert "scrolling" in states and states[-1] == "done"


def test_agent_waits_out_a_captcha(tmp_path, site):
    found, states = run_scout(tmp_path, TikTok(site.url), "captcha")
    assert "captcha" in states
    assert states.index("scrolling", states.index("captcha")) > states.index("captcha")
    assert found


def test_instagram_agent_reports_login_wall(tmp_path, site):
    found, states = run_scout(tmp_path, Instagram(site.url), "needlogin")
    assert states[-1] == "login" and not found


def test_instagram_agent_finds_reels(tmp_path, site):
    found, _ = run_scout(tmp_path, Instagram(site.url), "#nightdrift")
    videos = [c for c in found.values() if not c.maybe_not_video]
    assert len(videos) >= 15 and all(c.url.startswith(site.url + "/reel/") for c in videos)


def test_full_hunt_downloads_matching_videos(tmp_path, site):
    settings = HuntSettings(description="night car drift", platforms=["tiktok", "instagram"], agents=2,
                            target_count=4, show_browser=False, output_dir=str(tmp_path / "out"), time_limit_min=3)
    events = []

    async def keyword_brain(model):
        return KeywordBrain(), "Ollama isn't running, so videos are matched by keywords only."

    async def go():
        browser = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "cookies.txt")
        hunt = Hunt(settings, lambda k, d: events.append((k, d)), browser=browser, downloader=Downloader(),
                    brain_factory=keyword_brain, thumbs_dir=tmp_path / "thumbs",
                    site_urls={"tiktok": site.url, "instagram": site.url},
                    scout_options={"pace": (0.2, 0.4), "patience": 3})
        await asyncio.wait_for(hunt.run(), 180)
        await browser.close()
        return hunt

    hunt = asyncio.run(go())
    logs = [d for k, d in events if k == "log"]
    assert hunt.finished_reason.startswith("Saved the best 4 of"), logs
    files = list(hunt.folder.glob("*.mp4"))
    assert len(files) == 4 and all(f.stat().st_size > 1000 for f in files)
    dl = Downloader()
    for f in files:  # every file really is a video QuickTime can play: no music-only, no HEVC
        info = dl.inspect(f)
        assert info.video_codec == "h264" and info.is_mp4 and info.audio_codecs == ["aac"], (f, info.summary())
    rows = list(csv.DictReader((hunt.folder / LOG_NAME).open()))
    assert len(rows) == 4 and all("drift" in r["caption"].lower() for r in rows)
    assert [r["rank"] for r in rows] == ["1", "2", "3", "4"]
    cands = list(hunt.candidates.values())
    assert not [c for c in cands if c.status in ("queued", "checking", "unchecked")]  # every video was checked
    assert hunt.counts["scored"] >= 30  # it looked at a pool of videos, not just the first 4
    saved = [c for c in cands if c.status == "downloaded"]
    assert len(saved) == 4 and not [c for c in saved if "pasta" in c.caption.lower()]
    best_unsaved = max((c.score for c in cands if c.status == "notpicked"), default=0)
    assert min(c.score for c in saved) >= best_unsaved  # the best ones were saved
    failed = [c for c in cands if c.status == "failed"]
    assert all("audio only" in c.reason for c in failed), [c.reason for c in failed]
    assert list((tmp_path / "thumbs").glob("*.jpg"))
    platforms = {a["platform"] for a in hunt.agents.values()}
    assert platforms == {"tiktok", "instagram"}


def test_pinterest_agent_finds_video_pins(tmp_path, site):
    found, states = run_scout(tmp_path, Pinterest(site.url), "night drift")
    assert len(found) >= 12, states
    pins = list(found.values())
    assert all(c.url.startswith("https://www.pinterest.com/pin/") or c.url.startswith(site.url + "/pin/")
               for c in pins)
    assert all(c.kind == "video" and c.duration and c.thumbnail_url for c in pins if c.rich)
    assert not [c for c in pins if c.kind == "image"]  # pictures are left out unless asked for
    assert "scrolling" in states and states[-1] == "done"


def test_pinterest_agent_can_include_pictures(tmp_path, site):
    found, _ = run_scout(tmp_path, Pinterest(site.url, include_images=True), "night drift")
    kinds = {c.kind for c in found.values()}
    assert kinds == {"video", "image"}
    assert all(c.image_url for c in found.values() if c.kind == "image")


def test_pinterest_agent_reports_login_wall(tmp_path, site):
    found, states = run_scout(tmp_path, Pinterest(site.url), "needlogin")
    assert states[-1] == "login" and not found


def test_reference_hunt_saves_videos_that_look_like_it(tmp_path, site):
    """No description at all: just a reference video. The captions say "pasta", but the pictures match."""
    import shutil

    from reelfinder.references import Analyzer, ReferenceStore
    from reelfinder.similarity import Vision, vision

    if not Vision.installed() or not vision.load():
        pytest.skip("similarity model unavailable")
    store = ReferenceStore(tmp_path / "refs")
    ref = store.create("file", "kitten card.mp4")
    source = store.folder(ref.id) / "source.mp4"
    shutil.copyfile(site.dir / "look_3.mp4", source)  # what cover 3 ("KITTEN") looks like

    async def keyword_brain(model):
        return KeywordBrain(), "Ollama isn't running, so videos are matched by keywords only."

    asyncio.run(Analyzer(store, Downloader(), vision, keyword_brain, lambda: "x", lambda k, d: None).run(ref, source))
    assert store.get(ref.id).status == "ready"

    settings = HuntSettings(description="", platforms=["tiktok", "pinterest"], agents=2, target_count=4,
                            show_browser=False, output_dir=str(tmp_path / "out"), time_limit_min=3)
    events = []

    async def go():
        browser = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "cookies.txt")
        hunt = Hunt(settings, lambda k, d: events.append((k, d)), browser=browser, downloader=Downloader(),
                    brain_factory=keyword_brain, thumbs_dir=tmp_path / "thumbs",
                    site_urls={"tiktok": site.url, "pinterest": site.url},
                    scout_options={"pace": (0.2, 0.4), "patience": 3},
                    references=store.info(), vision=vision)
        await asyncio.wait_for(hunt.run(), 180)
        await browser.close()
        return hunt

    hunt = asyncio.run(go())
    logs = [d["text"] for k, d in events if k == "log"]
    assert hunt.finished_reason.startswith("Saved the best 4 of"), logs
    saved = [c for c in hunt.candidates.values() if c.status == "downloaded"]
    assert len(saved) == 4
    assert all(c.thumbnail_url.endswith("/cover/3.jpg") for c in saved), [c.thumbnail_url for c in saved]
    assert all(c.look >= 90 and c.frames_look >= 90 for c in saved)
    assert {c.platform for c in saved} <= {"tiktok", "pinterest"}
    others = [c for c in hunt.candidates.values() if c.look is not None and not c.thumbnail_url.endswith("/3.jpg")]
    assert others and max(c.look for c in others) < min(c.look for c in saved)
    assert any("Matching 1 reference video" in t for t in logs)


def test_pinterest_login_popup_keeps_the_first_results(tmp_path, site):
    found, states = run_scout(tmp_path, Pinterest(site.url), "loginwall")
    assert "limited" in states and "captcha" not in states  # its hidden reCAPTCHA isn't a captcha to solve
    assert len(found) >= 6  # the first page of results still counts
