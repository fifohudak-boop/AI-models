"""The self-test, run for real: Chromium agent + yt-dlp download + AI, against the stand-in site."""

import asyncio
import os
from pathlib import Path

import pytest

from fakesite import FakeSite
from reelfinder.ai import KeywordBrain, Verdict
from reelfinder.browser import BrowserManager
from reelfinder.config import HuntSettings
from reelfinder.downloader import Downloader, find_ffmpeg
from reelfinder.selftest import SelfTest, pick_test_query

if not os.environ.get("REELFINDER_BROWSER_PATH") and Path("/opt/pw-browsers/chromium").exists():
    os.environ["REELFINDER_BROWSER_PATH"] = "/opt/pw-browsers/chromium"

pytestmark = pytest.mark.skipif(not find_ffmpeg(), reason="needs ffmpeg for the fake site's media")


@pytest.fixture(scope="module")
def site():
    fake = FakeSite().start()
    yield fake
    fake.stop()


class SeeingBrain:
    name = "stub-vision"
    can_see = True
    thinks = False

    async def judge(self, description, keywords, c, image):
        assert image and image[:2] == b"\xff\xd8"  # the cover arrived as a JPEG
        return Verdict(81, "Night drift with smoke")


def run_test(tmp_path, site, platform, brain, **settings):
    s = HuntSettings(show_browser=False, output_dir=str(tmp_path / "out"), **settings)
    events = []

    async def brain_factory(model):
        return brain, None if not isinstance(brain, KeywordBrain) else "Ollama isn't running."

    async def go():
        browser = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "cookies.txt")
        test = SelfTest(platform, s, lambda k, d: events.append(d), browser=browser, downloader=Downloader(),
                        brain_factory=brain_factory, site_url=site.url, scout_options={"pace": (0.15, 0.3)})
        try:
            await asyncio.wait_for(test.run(), 120)
        finally:
            await browser.close()
        return test

    test = asyncio.run(go())
    return test, {st["name"]: st for st in test.steps}, events


def test_tiktok_all_steps_pass(tmp_path, site):
    test, steps, events = run_test(tmp_path, site, "tiktok", SeeingBrain(), description="night car drift")
    assert steps["Logged in"]["status"] == "warn"  # TikTok works without logging in
    for name in ("Search page", "Videos found", "Video details", "Download", "AI judge"):
        assert steps[name]["status"] == "ok", (name, steps[name])
    assert "with full details" in steps["Videos found"]["detail"]
    assert "B in" in steps["Download"]["detail"] and "deleted" in steps["Download"]["detail"]
    assert not steps["Download"]["detail"].startswith("0.0")
    assert steps["AI judge"]["detail"].startswith("Score 81")
    assert events[-1]["running"] is False and test.finished_at
    assert not (tmp_path / "out" / ".reelfinder-archive.txt").exists()  # your real archive is untouched
    assert "✓ Download" in test.summary()


def test_instagram_login_wall_fails_clearly(tmp_path, site):
    _, steps, _ = run_test(tmp_path, site, "instagram", SeeingBrain(), keywords="needlogin")
    assert steps["Logged in"]["status"] == "fail"
    assert steps["Search page"]["status"] == "fail" and "login page" in steps["Search page"]["detail"]
    assert all(steps[n]["status"] == "skip" for n in ("Videos found", "Video details", "Download", "AI judge"))


def test_without_ai_the_last_step_warns(tmp_path, site):
    _, steps, _ = run_test(tmp_path, site, "instagram", KeywordBrain(), keywords="#nightdrift")
    assert steps["Videos found"]["status"] == "ok"
    assert steps["Download"]["status"] == "ok"
    assert steps["AI judge"]["status"] == "warn" and "Ollama" in steps["AI judge"]["detail"]


def test_query_choice():
    assert pick_test_query(HuntSettings(keywords="#cardrift, jdm", description="x y z")) == "#cardrift"
    assert pick_test_query(HuntSettings(description="Cinematic night drifts, with smoke!")) == "Cinematic night drifts"
    assert pick_test_query(HuntSettings()) == "#cars"
