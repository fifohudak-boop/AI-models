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
from reelfinder.scouts import Instagram, Scout, TikTok

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
    assert hunt.finished_reason == "Target reached", [d for k, d in events if k == "log"]
    files = list(hunt.folder.glob("*.mp4"))
    assert len(files) == 4 and all(f.stat().st_size > 1000 for f in files)
    rows = list(csv.DictReader((hunt.folder / LOG_NAME).open()))
    assert len(rows) == 4 and all("drift" in r["caption"].lower() for r in rows)
    rejected = [c for c in hunt.candidates.values() if c.status == "rejected"]
    assert rejected and all("pasta" in c.caption.lower() for c in rejected if c.caption)
    assert list((tmp_path / "thumbs").glob("*.jpg"))
    platforms = {a["platform"] for a in hunt.agents.values()}
    assert platforms == {"tiktok", "instagram"}
