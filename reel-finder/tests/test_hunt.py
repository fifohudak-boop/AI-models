import asyncio
import csv
from pathlib import Path

import pytest

import reelfinder.hunt as hunt_mod
from reelfinder.ai import Verdict
from reelfinder.config import HuntSettings
from reelfinder.downloader import LOG_NAME
from reelfinder.hunt import Hunt, allocate_agents, validate
from reelfinder.models import Candidate


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(hunt_mod, "JUDGE_DELAY", 0)


class StubBrain:
    name = "stub-ai"
    can_see = True

    def __init__(self, frames_score=100, explode=False):
        self.frames_score = frames_score
        self.explode = explode
        self.judged = []

    async def plan_queries(self, description, keywords, platforms, per_platform):
        return {p: [f"{p} query {i}" for i in range(3)] for p in platforms}

    async def judge(self, description, keywords, c, image):
        if self.explode:
            raise RuntimeError("model crashed")
        self.judged.append(c.key)
        return Verdict(90, "Clearly a drift") if "drift" in c.caption else Verdict(10, "Off topic")

    async def verify_frames(self, description, frames):
        return Verdict(self.frames_score, "frames checked")


class StubDownloader:
    def __init__(self):
        self.downloaded = []

    def probe(self, url):
        return {"description": "probed drift", "duration": 10, "view_count": 50}

    def download(self, c, folder, archive, cancelled=lambda: False):
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{c.platform}_{c.id}.mp4"
        path.write_bytes(b"video")
        with archive.open("a") as fh:
            fh.write(c.archive_id + "\n")
        self.downloaded.append(c.key)
        return path

    def extract_frames(self, path, duration):
        return [b"frame"]

    def to_jpeg(self, image):
        return image


def make_cands(n_match=6, n_other=4, views=1000):
    out = []
    for i in range(n_match):
        out.append(Candidate(platform="tiktok", id=f"m{i}", url=f"https://t/m{i}", caption=f"night drift #{i}",
                             thumbnail_url="http://127.0.0.1:9/none.jpg", views=views, duration=12, author="a"))
    for i in range(n_other):
        out.append(Candidate(platform="tiktok", id=f"o{i}", url=f"https://t/o{i}", caption=f"cooking pasta {i}",
                             thumbnail_url="http://127.0.0.1:9/none.jpg", views=views, duration=12, author="b"))
    return out


class StubScout:
    def __init__(self, hunt, cands, delay=0.0, forever=False):
        self.hunt, self.cands, self.delay, self.forever = hunt, cands, delay, forever

    async def run(self):
        i = 0
        while not self.hunt.stop_event.is_set():
            if i >= len(self.cands):
                if not self.forever:
                    return
                await asyncio.sleep(0.05)
                continue
            await self.hunt.on_found(self.cands[i].model_copy())
            i += 1
            await asyncio.sleep(self.delay)


def run_hunt(tmp_path, cands, brain=None, downloader=None, stop_after=None, forever=False, **settings):
    s = HuntSettings(description="night car drift", platforms=["tiktok"], agents=1,
                     output_dir=str(tmp_path), time_limit_min=1, **settings)
    events = []
    brain = brain or StubBrain()

    async def brain_factory(model):
        return brain, None

    hunt = Hunt(s, lambda kind, data: events.append((kind, data)), downloader=downloader or StubDownloader(),
                brain_factory=brain_factory, thumbs_dir=tmp_path / "thumbs")

    async def scout_factory(agent_id, platform, queries):
        return StubScout(hunt, cands, delay=0.01, forever=forever)

    hunt.scout_factory = scout_factory

    async def go():
        task = asyncio.create_task(hunt.run())
        if stop_after:
            await asyncio.sleep(stop_after)
            hunt.stop("Stopped by you")
        await asyncio.wait_for(task, 20)

    asyncio.run(go())
    return hunt, events


def test_stops_exactly_at_target(tmp_path):
    hunt, events = run_hunt(tmp_path, make_cands(), target_count=3)
    assert hunt.finished_reason == "Target reached"
    assert hunt.counts["downloaded"] == 3
    files = sorted(p.name for p in hunt.folder.glob("*.mp4"))
    assert len(files) == 3
    rows = list(csv.DictReader((hunt.folder / LOG_NAME).open()))
    assert len(rows) == 3 and all(r["ai_score"] == "90" for r in rows)
    kinds = [k for k, _ in events]
    assert kinds[-1] == "finished" and "plan" in kinds and "candidate" in kinds
    assert hunt.plan == {"tiktok": ["tiktok query 0", "tiktok query 1", "tiktok query 2"]}


def test_runs_until_searches_are_exhausted(tmp_path):
    hunt, _ = run_hunt(tmp_path, make_cands(), target_count=50)
    assert hunt.finished_reason == "Searched everything planned"
    assert hunt.counts["downloaded"] == 6
    assert hunt.counts["rejected"] == 4
    statuses = {c.id: c.status for c in hunt.candidates.values()}
    assert statuses["o0"] == "rejected" and statuses["m0"] == "downloaded"
    assert hunt.candidates["tiktok:o0"].reason == "Off topic"


def test_never_downloads_the_same_video_twice(tmp_path):
    first, _ = run_hunt(tmp_path, make_cands(), target_count=50)
    assert first.counts["downloaded"] == 6
    second, _ = run_hunt(tmp_path, make_cands(), target_count=50)
    assert second.counts["downloaded"] == 0
    assert second.counts["already_have"] == 6
    assert (Path(tmp_path) / ".reelfinder-archive.txt").read_text().count("\n") == 6


def test_quick_filters_skip_the_ai(tmp_path):
    brain = StubBrain()
    hunt, _ = run_hunt(tmp_path, make_cands(views=100), brain=brain, target_count=5, min_views=1000)
    assert hunt.counts["downloaded"] == 0
    assert hunt.counts["rejected"] == 10
    assert brain.judged == []
    assert hunt.candidates["tiktok:m0"].reason == "Only 100 views"


def test_repeat_sightings_merge_details(tmp_path, monkeypatch):
    monkeypatch.setattr(hunt_mod, "JUDGE_DELAY", 0.5)  # the details arrive just after the link
    link_only = Candidate(platform="tiktok", id="m0", url="https://t/m0")
    full = make_cands(1, 0)[0]
    hunt, _ = run_hunt(tmp_path, [link_only, full], target_count=5)
    c = hunt.candidates["tiktok:m0"]
    assert c.caption == "night drift #0" and c.views == 1000
    assert hunt.counts["found"] == 1 and hunt.counts["downloaded"] == 1


def test_stop_button(tmp_path):
    hunt, events = run_hunt(tmp_path, make_cands(0, 3), forever=True, stop_after=0.4, target_count=5)
    assert hunt.finished_reason == "Stopped by you"
    assert events[-1][0] == "finished"
    assert not hunt.running


def test_watch_check_deletes_misses(tmp_path):
    hunt, _ = run_hunt(tmp_path, make_cands(2, 0), brain=StubBrain(frames_score=20), target_count=5, watch_check=True)
    assert hunt.counts["downloaded"] == 0
    assert list(hunt.folder.glob("*.mp4")) == []
    assert hunt.candidates["tiktok:m0"].reason.startswith("Watch-check")


def test_ai_crash_falls_back_to_keywords(tmp_path):
    hunt, events = run_hunt(tmp_path, make_cands(2, 2), brain=StubBrain(explode=True), target_count=10)
    assert hunt.counts["downloaded"] == 2  # "night drift" captions still match by keywords
    assert any(k == "log" and "didn't answer" in d["text"] for k, d in events)


def test_validate_and_allocate(tmp_path):
    ok = HuntSettings(description="x", output_dir=str(tmp_path))
    assert validate(ok) is None
    assert "Describe" in validate(HuntSettings(output_dir=str(tmp_path)))
    assert "platform" in validate(HuntSettings(description="x", platforms=[], output_dir=str(tmp_path)))
    assert "longer" in validate(HuntSettings(description="x", min_duration=60, max_duration=30, output_dir=str(tmp_path)))
    blocker = tmp_path / "file"
    blocker.write_text("")
    assert "Can't use" in validate(HuntSettings(description="x", output_dir=str(blocker / "sub")))
    assert allocate_agents(["tiktok", "instagram"], 4) == {"tiktok": 2, "instagram": 2}
    assert allocate_agents(["tiktok", "instagram"], 6) == {"tiktok": 3, "instagram": 3}
    assert allocate_agents(["instagram"], 6) == {"instagram": 3}
    assert allocate_agents(["tiktok"], 5) == {"tiktok": 5}


def test_crashed_agent_is_reported(tmp_path):
    class Boom:
        async def run(self):
            raise RuntimeError("page exploded")

    s = HuntSettings(description="night car drift", platforms=["tiktok"], agents=1, output_dir=str(tmp_path))
    events = []

    async def brain_factory(model):
        return StubBrain(), None

    async def scout_factory(agent_id, platform, queries):
        return Boom()

    hunt = Hunt(s, lambda k, d: events.append((k, d)), downloader=StubDownloader(), brain_factory=brain_factory,
                scout_factory=scout_factory)
    asyncio.run(asyncio.wait_for(hunt.run(), 10))
    assert any(k == "log" and "page exploded" in d["text"] for k, d in events)
