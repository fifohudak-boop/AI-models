"""The hunt pipeline with stand-in agents, AI and downloader: look at a pool, score all, save the best N."""

import asyncio
import csv
import re

import pytest

import reelfinder.hunt as hunt_mod
from reelfinder.ai import Verdict
from reelfinder.config import HuntSettings
from reelfinder.downloader import LOG_NAME, NotAVideo
from reelfinder.hunt import Hunt, allocate_agents, validate
from reelfinder.models import Candidate


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(hunt_mod, "JUDGE_DELAY", 0)


class StubBrain:
    """Scores each video by the number hidden in its caption ("… s73" → 73)."""

    name = "stub-ai"
    can_see = True
    thinks = False

    def __init__(self, frames_score=100, explode=False, slow=0.0, queries=3, bad_frames=()):
        self.frames_score, self.explode, self.slow, self.queries = frames_score, explode, slow, queries
        self.bad_frames = set(bad_frames)
        self.judged: list[str] = []
        self.plan_calls: list[tuple] = []

    async def plan_queries(self, description, keywords, platforms, per_platform, avoid=()):
        round_no = len(self.plan_calls)
        self.plan_calls.append(tuple(avoid))
        return {p: [f"{p} query {round_no}.{i}" for i in range(self.queries)] for p in platforms}

    async def judge(self, description, keywords, c, image):
        if self.explode:
            raise RuntimeError("model crashed")
        if self.slow:
            await asyncio.sleep(self.slow)
        self.judged.append(c.key)
        m = re.search(r"s(\d+)$", c.caption)
        return Verdict(int(m.group(1)) if m else 0, "stub verdict")

    async def verify_frames(self, description, frames):
        return Verdict(self.frames_score, "frames checked")


class StubDownloader:
    def __init__(self, broken=()):
        self.broken = set(broken)
        self.downloaded: list[str] = []

    def probe(self, url):
        return {"description": "probed night drift s50", "duration": 10, "view_count": 50}

    def download(self, c, folder, archive, cancelled=lambda: False, min_duration=0, max_duration=0):
        if c.id in self.broken:
            raise NotAVideo("Not a real video (no picture (audio only: aac))")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{c.platform}_{c.id}.mp4"
        path.write_bytes(b"video")
        if archive is not None:
            with archive.open("a") as fh:
                fh.write(c.archive_id + "\n")
        self.downloaded.append(c.id)
        return path

    def download_image(self, c, folder, archive):
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{c.platform}_{c.id}.jpg"
        path.write_bytes(b"\xff\xd8image")
        self.downloaded.append(c.id)
        return path

    def extract_frames(self, path, duration):
        return [b"frame"]

    def to_jpeg(self, image):
        return image


def feed(n, scores=None, views=1000, prefix="v", platform="tiktok"):
    """n videos; video i scores scores[i] (default: a shuffled 0-99 spread)."""
    scores = scores or [(i * 37) % 100 for i in range(n)]
    for i in range(n):
        yield Candidate(platform=platform, id=f"{prefix}{i}", url=f"https://t/{prefix}{i}",
                        caption=f"night drift #{i} s{scores[i]}", thumbnail_url="http://127.0.0.1:9/x.jpg",
                        views=views, duration=12, author="a", rich=True)


class StubScout:
    """Takes queries from its queue like a real agent; each query yields the next `per_query` videos."""

    def __init__(self, hunt, queue, source, per_query=10, delay=0.0):
        self.hunt, self.queue, self.source, self.per_query, self.delay = hunt, queue, source, per_query, delay

    async def run(self):
        while not self.hunt.scan_stop.is_set():
            try:
                query = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            for _ in range(self.per_query):
                if self.hunt.scan_stop.is_set():
                    return
                c = next(self.source, None)
                if c is None:
                    break
                c = c.model_copy()
                c.query = query
                await self.hunt.on_found(c)
                await asyncio.sleep(self.delay)


def run_hunt(tmp_path, source, *, brain=None, downloader=None, per_query=10, delay=0.0, finish_after=None,
             stop_after=None, time_limit_s=None, **settings):
    s = HuntSettings(description="night car drift", platforms=settings.pop("platforms", ["tiktok"]), agents=1,
                     output_dir=str(tmp_path), **settings)
    events = []
    brain = brain or StubBrain()
    downloader = downloader or StubDownloader()

    async def brain_factory(model):
        return brain, None

    hunt = Hunt(s, lambda kind, data: events.append((kind, data)), downloader=downloader,
                brain_factory=brain_factory, thumbs_dir=tmp_path / "thumbs", time_limit_s=time_limit_s)

    async def scout_factory(agent_id, platform, queue):
        return StubScout(hunt, queue, source, per_query=per_query, delay=delay)

    hunt.scout_factory = scout_factory

    async def go():
        task = asyncio.create_task(hunt.run())
        if finish_after is not None:
            await asyncio.sleep(finish_after)
            hunt.finish()
        if stop_after is not None:
            await asyncio.sleep(stop_after)
            hunt.stop("Stopped by you")
        await asyncio.wait_for(task, 30)

    asyncio.run(go())
    return hunt, events, brain, downloader


def statuses(hunt):
    out = {}
    for c in hunt.candidates.values():
        out.setdefault(c.status, []).append(c.id)
    return out


def test_saves_exactly_the_best_n_of_the_pool(tmp_path):
    source = feed(60)
    hunt, events, brain, dl = run_hunt(tmp_path, source, target_count=5, pool_size=20)
    assert hunt.counts["downloaded"] == 5
    assert hunt.counts["found"] == 20  # the agents stopped once the pool was full
    pool = [c for c in hunt.candidates.values()]
    best5 = sorted(pool, key=lambda c: -c.score)[:5]
    assert sorted(dl.downloaded) == sorted(c.id for c in best5)
    rows = list(csv.DictReader((hunt.folder / LOG_NAME).open()))
    assert [int(r["ai_score"]) for r in rows] == sorted((c.score for c in best5), reverse=True)
    assert [r["rank"] for r in rows] == ["1", "2", "3", "4", "5"]
    assert hunt.finished_reason == "Saved the best 5 of 20 checked"
    assert events[-1][0] == "finished"


def test_every_found_video_gets_checked(tmp_path):
    hunt, _, brain, _ = run_hunt(tmp_path, feed(60), target_count=5, pool_size=30)
    st = statuses(hunt)
    assert set(st) <= {"downloaded", "notpicked"}, st  # nothing left unchecked or waiting
    assert len(brain.judged) == hunt.counts["found"] == hunt.counts["scored"] == 30


def test_failed_downloads_are_replaced_by_the_next_best(tmp_path):
    scores = list(range(99, 59, -1))  # v0 is best, v1 second…
    dl = StubDownloader(broken={"v0", "v1"})  # e.g. only music, or a slideshow
    hunt, _, _, _ = run_hunt(tmp_path, feed(40, scores), downloader=dl, target_count=4, pool_size=20)
    assert hunt.counts["downloaded"] == 4 and hunt.counts["failed"] == 2
    assert dl.downloaded == ["v2", "v3", "v4", "v5"] or sorted(dl.downloaded) == ["v2", "v3", "v4", "v5"]
    failed = hunt.candidates["tiktok:v0"]
    assert failed.status == "failed" and "next best" in failed.reason


def test_looks_further_when_the_pool_runs_out(tmp_path):
    scores = [90] * 6 + [50] * 30
    dl = StubDownloader(broken={f"v{i}" for i in range(6)})  # the whole first pool turns out unusable
    hunt, _, _, _ = run_hunt(tmp_path, feed(36, scores), downloader=dl, target_count=5, pool_size=6, per_query=6)
    assert hunt.counts["downloaded"] == 5
    assert hunt.counts["found"] > 6  # it went back and looked at more videos


def test_plans_new_searches_when_they_run_dry(tmp_path):
    brain = StubBrain(queries=1)
    hunt, _, brain, _ = run_hunt(tmp_path, feed(60), brain=brain, target_count=5, pool_size=25, per_query=5)
    assert len(brain.plan_calls) >= 2
    assert any("tiktok query 0.0" in avoided for avoided in brain.plan_calls[1])  # no repeats
    assert hunt.counts["downloaded"] == 5 and hunt.counts["found"] >= 25


def test_minimum_score_is_respected(tmp_path):
    scores = [80, 75, 30, 20, 10, 5, 3, 2]
    hunt, _, _, dl = run_hunt(tmp_path, feed(8, scores), target_count=5, pool_size=8, min_score=50)
    assert sorted(dl.downloaded) == ["v0", "v1"]
    assert hunt.finished_reason.startswith("Saved 2 of 5")


def test_never_downloads_the_same_video_twice(tmp_path):
    first, *_ = run_hunt(tmp_path, feed(20), target_count=5, pool_size=20)
    assert first.counts["downloaded"] == 5
    second, *_ = run_hunt(tmp_path, feed(20), target_count=5, pool_size=15)
    assert second.counts["already_have"] == 5
    assert second.counts["downloaded"] == 5
    assert (tmp_path / ".reelfinder-archive.txt").read_text().count("\n") == 10


def test_your_filters_skip_videos_without_asking_the_ai(tmp_path):
    hunt, _, brain, _ = run_hunt(tmp_path, feed(10, views=100), target_count=3, pool_size=10, min_views=1000)
    assert hunt.counts["downloaded"] == 0 and hunt.counts["skipped"] == 10
    assert brain.judged == []
    assert hunt.candidates["tiktok:v0"].reason == "Only 100 views"
    assert hunt.finished_reason.startswith("All 10 videos found broke your filters")


def test_nothing_found_says_so(tmp_path):
    hunt, *_ = run_hunt(tmp_path, feed(0), target_count=3)
    assert hunt.finished_reason.startswith("No videos found")


def test_running_out_of_time_says_so(tmp_path):
    hunt, *_ = run_hunt(tmp_path, feed(40), target_count=5, pool_size=40, delay=0.15, time_limit_s=0.6)
    assert 0 < hunt.counts["downloaded"] < 5
    assert "time limit ran out" in hunt.finished_reason, hunt.finished_reason


def test_repeat_sightings_merge_details(tmp_path, monkeypatch):
    monkeypatch.setattr(hunt_mod, "JUDGE_DELAY", 0.5)  # the details arrive just after the link
    link_only = Candidate(platform="tiktok", id="v0", url="https://t/v0", caption="Photo by someone")
    full, other = feed(2, [88, 10])
    hunt, *_ = run_hunt(tmp_path, iter([link_only, full, other]), target_count=1, pool_size=2)
    c = hunt.candidates["tiktok:v0"]
    assert c.caption.endswith("s88") and c.views == 1000 and c.score == 88  # the site's data won
    assert hunt.counts["found"] == 2 and hunt.counts["downloaded"] == 1


def test_finish_now_saves_the_best_found_so_far(tmp_path):
    hunt, *_ = run_hunt(tmp_path, feed(500), target_count=4, pool_size=400, per_query=500, delay=0.01,
                        finish_after=0.5)
    assert hunt.counts["downloaded"] == 4
    assert 0 < hunt.counts["found"] < 400
    assert "unchecked" not in statuses(hunt)  # every found video was still checked
    assert hunt.finished_reason.startswith("Saved the best 4")


def test_stop_now_stops_everything(tmp_path):
    hunt, events, *_ = run_hunt(tmp_path, feed(500), target_count=4, pool_size=400, per_query=500, delay=0.01,
                                stop_after=0.3)
    assert hunt.finished_reason == "Stopped by you"
    assert events[-1][0] == "finished" and not hunt.running


def test_out_of_time_still_checks_everything_from_captions(tmp_path):
    brain = StubBrain(slow=0.25)
    hunt, events, *_ = run_hunt(tmp_path, feed(30), brain=brain, target_count=3, pool_size=30, time_limit_s=1.2)
    quick = [c for c in hunt.candidates.values() if c.quick]
    assert quick, "the leftovers should have been scored from their captions"
    assert "unchecked" not in statuses(hunt) and hunt.counts["scored"] == hunt.counts["found"]
    assert hunt.counts["downloaded"] == 3
    assert any(k == "log" and "Out of time" in d["text"] for k, d in events)


def test_watch_check_replaces_misses(tmp_path):
    scores = [99, 98, 97, 96, 95]
    brain = StubBrain(frames_score=10)
    hunt, *_ = run_hunt(tmp_path, feed(5, scores), brain=brain, target_count=2, pool_size=5, watch_check=True)
    assert hunt.counts["downloaded"] == 0 and hunt.counts["failed"] == 5
    assert list(hunt.folder.glob("*.mp4")) == []
    assert hunt.candidates["tiktok:v0"].reason.startswith("Watch-check")


def test_ai_crash_falls_back_to_keywords(tmp_path):
    hunt, events, *_ = run_hunt(tmp_path, feed(10), brain=StubBrain(explode=True), target_count=3, pool_size=10)
    assert hunt.counts["downloaded"] == 3  # "night drift" captions still rank by keywords
    assert any(k == "log" and "didn't answer" in d["text"] for k, d in events)


def test_pinterest_images_are_saved_when_wanted(tmp_path):
    pins = [Candidate(platform="pinterest", id=f"p{i}", url=f"https://p/{i}", kind="image", rich=True,
                      caption=f"night drift moodboard s{90 - i}", image_url="http://127.0.0.1:9/i.jpg")
            for i in range(6)]
    hunt, _, _, dl = run_hunt(tmp_path, iter(pins), target_count=2, pool_size=6, platforms=["pinterest"],
                              include_images=True)
    assert sorted(dl.downloaded) == ["p0", "p1"]
    assert sorted(p.suffix for p in hunt.folder.iterdir() if p.name != LOG_NAME) == [".jpg", ".jpg"]


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
    assert allocate_agents(["tiktok", "instagram", "pinterest"], 4) == {"tiktok": 2, "instagram": 1, "pinterest": 1}
    assert allocate_agents(["instagram"], 6) == {"instagram": 3}
    assert allocate_agents(["pinterest"], 6) == {"pinterest": 3}
    assert allocate_agents(["tiktok"], 5) == {"tiktok": 5}
