"""Reference videos: adding a file or a link, analysing it, and what a hunt gets from it."""

import asyncio
import shutil
import subprocess

import numpy as np
import pytest

from reelfinder.downloader import Downloader, find_ffmpeg
from reelfinder.references import Analyzer, ReferenceStore, hashtags_in, platform_of, valid_id
from reelfinder.similarity import Vision, vision

FFMPEG = find_ffmpeg()
pytestmark = pytest.mark.skipif(not FFMPEG, reason="needs ffmpeg")


def ff(*args):
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True)


class DescribingBrain:
    def __init__(self):
        self.seen = []

    async def describe_reference(self, frames, caption=""):
        self.seen.append((len(frames), caption))
        return {"description": "A red car drifting at night with tire smoke, filmed low.",
                "queries": ["night drift", "car drift smoke"], "hashtags": ["cardrift", "drift"]}


class FakeVision:
    error = ""

    def __init__(self, ok=True):
        self.ok = ok
        self.ready = ok

    @staticmethod
    def installed():
        return True

    def load(self):
        return self.ok

    def embed_images(self, images):
        return np.stack([np.eye(4, dtype=np.float32)[i % 4] for i in range(len(images))])

    def tags(self, pictures):
        return ["car drift"]


def analyse(tmp_path, source, *, file=None, url="", brain=None, vision_=None, downloader=None):
    store = ReferenceStore(tmp_path / "refs")
    events = []

    async def brain_factory(model):
        return brain, None

    analyzer = Analyzer(store, downloader or Downloader(), vision_ or FakeVision(), brain_factory,
                        lambda: "qwen3-vl:8b-instruct", lambda k, d: events.append((k, d)))
    ref = store.create(source, file.name if file else url, url=url)
    if file is not None:
        target = store.folder(ref.id) / f"source{file.suffix}"
        shutil.copyfile(file, target)
        file = target
    asyncio.run(analyzer.run(ref, file))
    return store, store.get(ref.id), events


@pytest.fixture
def clip(tmp_path):
    path = tmp_path / "my drift.mov"
    ff("-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=4", "-f", "lavfi", "-i",
       "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path))
    return path


def test_a_video_file_becomes_a_ready_reference(tmp_path, clip):
    brain = DescribingBrain()
    store, ref, events = analyse(tmp_path, "file", file=clip, brain=brain)
    assert ref.status == "ready" and ref.kind == "video" and ref.frames == 8 and ref.looks
    assert ref.tags == ["car drift"] and ref.description.startswith("A red car")
    assert ref.queries == ["night drift", "car drift smoke"] and ref.hashtags == ["cardrift", "drift"]
    assert brain.seen == [(4, "")]  # four frames are enough for the AI to describe it
    folder = store.folder(ref.id)
    assert sorted(p.name for p in folder.iterdir()) == sorted(
        [f"frame_{i}.jpg" for i in range(1, 9)] + ["looks.npy", "reference.json"])  # the video itself is gone
    assert [d["status"] for k, d in events if k == "reference"][-1] == "ready"
    info = store.info()
    assert info.count == 1 and len(info.looks.frames) == 1 and info.looks.frames[0].shape == (8, 4)
    assert "red car" in info.description and info.hashtags == ["cardrift", "drift"]


def test_without_ollama_it_still_works_with_a_note(tmp_path, clip):
    _, ref, _ = analyse(tmp_path, "file", file=clip, brain=object())  # a brain that can't describe
    assert ref.status == "ready" and ref.looks and not ref.description
    assert "Ollama" in ref.note


def test_with_nothing_to_go_on_it_fails_clearly(tmp_path, clip):
    _, ref, _ = analyse(tmp_path, "file", file=clip, brain=object(), vision_=FakeVision(ok=False))
    assert ref.status == "failed" and "Couldn't analyse it" in ref.error


def test_sound_only_files_are_refused(tmp_path):
    song = tmp_path / "song.m4a"
    ff("-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:a", "aac", str(song))
    _, ref, _ = analyse(tmp_path, "file", file=song, brain=DescribingBrain())
    assert ref.status == "failed" and "sound only" in ref.error


def test_a_picture_works_as_a_reference(tmp_path):
    pic = tmp_path / "moodboard.png"
    ff("-f", "lavfi", "-i", "color=c=0x223344:size=400x600", "-frames:v", "1", str(pic))
    _, ref, _ = analyse(tmp_path, "file", file=pic, brain=DescribingBrain())
    assert ref.status == "ready" and ref.kind == "image" and ref.frames == 1


def test_a_link_is_downloaded_and_its_hashtags_kept(tmp_path, clip):
    class LinkDownloader(Downloader):
        def download(self, c, folder, archive, *args, **kwargs):
            c.caption, c.author = "Sunday session #NightDrift #jdm", "driftking"
            target = folder / "tiktok_driftking_123.mp4"
            shutil.copyfile(clip, target)
            return target

    brain = DescribingBrain()
    store, ref, _ = analyse(tmp_path, "link", url="https://www.tiktok.com/@driftking/video/123", brain=brain,
                            downloader=LinkDownloader())
    assert ref.status == "ready" and ref.platform == "tiktok" and ref.author == "driftking"
    assert ref.hashtags[:2] == ["NightDrift", "jdm"] and "cardrift" in ref.hashtags  # caption tags first
    assert brain.seen[0][1].startswith("Sunday session")
    assert not list(store.folder(ref.id).glob("*.mp4"))
    assert store.info().urls == ["https://www.tiktok.com/@driftking/video/123"]


def test_store_basics(tmp_path):
    store = ReferenceStore(tmp_path / "refs")
    ref = store.create("link", "x", url="https://pin.it/abc")
    assert valid_id(ref.id) and not valid_id("../etc") and ref.platform == "pinterest"
    assert [r.id for r in store.all()] == [ref.id] and store.ready() == []
    assert store.delete(ref.id) and store.all() == [] and not store.delete(ref.id)
    with pytest.raises(ValueError):
        store.folder("../../x")
    assert platform_of("https://www.youtube.com/shorts/x") == "youtube" and platform_of("https://x.com/a") == "link"
    assert hashtags_in("so good #cardrift #CarDrift #jdm, wow") == ["cardrift", "jdm"]


@pytest.mark.skipif(not Vision.installed(), reason="fastembed not installed")
def test_real_analysis_with_the_similarity_model(tmp_path, clip):
    if not vision.load():
        pytest.skip(f"similarity model unavailable: {vision.error}")
    _, ref, _ = analyse(tmp_path, "file", file=clip, brain=object(), vision_=vision)
    assert ref.status == "ready" and ref.looks and ref.tags
