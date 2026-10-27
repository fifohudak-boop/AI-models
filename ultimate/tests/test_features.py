"""The systems added after the first release: AI Studio cost/spending, the Editor, and the metadata
cleaner. Editor and cleaner run real ffmpeg; the cost maths is checked without calling Wan."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hub import db, editor, metadata, personas, settings, studio
from hub.main import app
from hub.mediainfo import find_ffmpeg, probe

H = {"X-Ultimate": "1"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture(scope="module")
def model(client, tmp_path_factory):
    folder = tmp_path_factory.mktemp("mei-refs")
    make_video(folder / "clip.mp4", seconds=2)
    mid = client.post("/api/models", json={"name": "Mei Feature"}, headers=H).json()["id"]
    client.put(f"/api/models/{mid}", json={"folders": {"references": str(folder)}}, headers=H)
    return mid


def make_video(path: Path, seconds: int = 2, size: str = "320x568", extra: list | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([find_ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", *(extra or []), str(path)], check=True)
    return path


def make_audio(path: Path, seconds: int = 5) -> Path:
    subprocess.run([find_ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}",
                    str(path)], check=True)
    return path


def wait_job(fetch, timeout: float = 120) -> dict:
    end = time.time() + timeout
    job = None
    while time.time() < end:
        jobs = fetch()
        job = jobs[0] if jobs else None
        if job and job["status"] in ("saved", "failed"):
            return job
        time.sleep(0.4)
    raise AssertionError(f"edit job timed out: {job}")


# ---------------------------------------------------------------- AI Studio: automatic price & spending

def test_automatic_pricing_matches_published_rates():
    from hub import providers  # noqa: PLC0415
    # Wan: region-dependent, resolution-tiered (official per-second numbers).
    assert providers.price("wan", "wan3.0-video", "intl", "720P", 5) == 0.5
    assert abs(providers.price("wan", "wan3.0-video", "eu", "720P", 5) - 0.4126) < 0.001
    assert providers.price("wan", "wan3.0-video-prime", "intl", "1080P", 5) == 2.0  # Prime is the higher rail
    # Seedance: token formula reproduces BytePlus's per-clip prices.
    assert abs(providers.price("seedance", "seedance-1.0-pro", "intl", "480p", 5) - 0.1215) < 0.001
    assert abs(providers.price("seedance", "seedance-1.0-pro", "intl", "1080p", 5) - 0.612) < 0.001
    assert providers.price("seedance", "seedance-1.0-lite", "intl", "720p", 10) < \
        providers.price("seedance", "seedance-1.0-pro", "intl", "720p", 10)
    # Seedream: flat per image.
    assert providers.price("seedream", "seedream-4.0", "intl", "2K", images=3) == 0.09


def test_price_endpoint_uses_the_models_provider_and_region(client, model):
    # default model has no own key → Wan, intl
    out = client.get(f"/api/m/{model}/studio/price",
                     params={"model": "wan3.0-video", "resolution": "1080P", "seconds": 5}).json()
    assert out["price"] == 1.0 and out["currency"] == "USD"
    opts = client.get(f"/api/m/{model}/studio/options").json()
    assert opts["provider"] == "wan" and opts["kind"] == "video"
    assert any(p["id"] == "seedance" for p in opts["providers"])


def test_spending_only_counts_this_models_finished_videos(client, model):
    other = client.post("/api/models", json={"name": "Spender Two"}, headers=H).json()["id"]
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    saved = {"id": "j-saved", "modelId": model, "createdAt": now, "status": "saved", "mode": "text", "prompt": "a",
             "model": "wan3.0-video", "resolution": "720P", "ratio": "9:16", "duration": 10, "photos": [], "videos": [],
             "seconds": 10, "cost": 0.588, "costCurrency": "USD", "file": "/x.mp4"}
    failed = {**saved, "id": "j-failed", "status": "failed", "cost": None}
    other_job = {**saved, "id": "j-other", "modelId": other}
    for job in (saved, failed, other_job):
        db.run("INSERT INTO studio_jobs (id, persona_id, created_at, data) VALUES (?,?,?,?)",
               (job["id"], job["modelId"], job["createdAt"], json.dumps(job)))

    spend = client.get(f"/api/m/{model}/studio/spending").json()
    assert spend["videos"] == 1 and abs(spend["total"] - 0.59) < 0.01  # the failed one isn't billed
    assert spend["perResolution"]["720P"]["videos"] == 1
    assert client.get(f"/api/m/{other}/studio/spending").json()["total"] == 0.59
    client.delete(f"/api/models/{other}", headers=H)


# ---------------------------------------------------------------- Editor

def test_editor_makes_a_ready_reel(client, model):
    music = Path(personas.data_dir(model)) / "src-music.mp3"
    make_audio(music, 5)
    added = client.post(f"/api/m/{model}/edit/music?name=track.mp3", content=music.read_bytes(),
                        headers={**H, "Content-Type": "audio/mpeg"})
    assert added.status_code == 200, added.text
    assert client.get(f"/api/m/{model}/edit/music").json()[0]["name"] == "track.mp3"

    clips = client.get(f"/api/m/{model}/edit/clips").json()
    assert clips and clips[0]["name"] == "clip.mp4"
    res = client.post(f"/api/m/{model}/edit/jobs", headers=H, json={
        "source": clips[0]["path"], "trimStart": 0.2, "trimEnd": 1.6, "aspect": "9:16",
        "captions": [{"text": "Hello Mei", "position": "bottom", "size": "L"}],
        "music": "track.mp3", "musicVolume": 0.5, "keepOriginalAudio": True, "fade": True})
    assert res.status_code == 201, res.text

    job = wait_job(lambda: client.get(f"/api/m/{model}/edit/jobs").json())
    assert job["status"] == "saved", job
    out = Path(job["file"])
    info = probe(out)
    assert info.video_codec == "h264" and (info.width, info.height) == (1080, 1920)
    assert 1.2 <= info.duration <= 1.7 and info.audio_codec is not None  # trimmed, with sound
    # It lands in the model's Edited folder and shows in the library.
    folders = client.get("/api/models").json()
    edited = next(m for m in folders if m["id"] == model)["folders"]["edited"]
    assert str(out.parent) == edited
    lib = client.get(f"/api/m/{model}/library").json()
    assert out.name in [i["name"] for i in lib["edited"]["items"]]


def test_editor_refuses_a_file_outside_the_model(client, model):
    res = client.post(f"/api/m/{model}/edit/jobs", json={"source": "/etc/hosts", "aspect": "9:16"}, headers=H)
    assert res.status_code == 400 and "folders" in res.json()["error"]


def test_editor_filmstrip(client, model):
    clip = client.get(f"/api/m/{model}/edit/clips").json()[0]["path"]
    strip = client.get(f"/api/m/{model}/edit/filmstrip", params={"path": clip})
    assert strip.status_code == 200 and strip.headers["content-type"] == "image/jpeg"
    assert len(strip.content) > 500  # a real strip image
    # cached: a second request returns the same bytes
    assert client.get(f"/api/m/{model}/edit/filmstrip", params={"path": clip}).content == strip.content
    # a file outside the model's folders is refused
    assert client.get(f"/api/m/{model}/edit/filmstrip", params={"path": "/etc/hosts"}).status_code == 404


def test_editor_rich_options(client, model):
    opts = client.get("/api/edit/options").json()
    assert "outline" in opts["captionStyles"] and opts["fillModes"] == ["crop", "blur"]
    assert any(c["id"] == "yellow" for c in opts["captionColors"]) and 2.0 in opts["speeds"]

    clip = next(c["path"] for c in client.get(f"/api/m/{model}/edit/clips").json() if c["name"] == "clip.mp4")
    res = client.post(f"/api/m/{model}/edit/jobs", headers=H, json={
        "source": clip, "trimStart": 0.0, "trimEnd": 2.0, "aspect": "1:1",
        "fill": "blur", "mirror": True, "speed": 2.0,
        "captions": [{"text": "Big bold caption", "position": "top", "size": "XL",
                      "style": "outline", "color": "yellow"}],
        "keepOriginalAudio": True, "fade": True})
    assert res.status_code == 201, res.text
    created = res.json()["id"]
    job = wait_job(lambda: [j for j in client.get(f"/api/m/{model}/edit/jobs").json() if j["id"] == created])
    assert job["status"] == "saved", job
    info = probe(Path(job["file"]))
    assert (info.width, info.height) == (1080, 1080)  # square, blurred fit
    assert 0.8 <= info.duration <= 1.2  # 2 s of source at 2× ≈ 1 s, with sound retimed
    assert info.audio_codec is not None


# ---------------------------------------------------------------- Metadata cleaner

def test_metadata_scan_and_clean_strips_a_video(client, model, tmp_path):
    tagged = Path(personas.folder(personas.require(model), "references")) / "tagged.mp4"
    make_video(tagged, 1, extra=["-metadata", "title=Secret", "-metadata", "make=Apple",
                                  "-metadata", "location=+40.0-70.0/"])
    scan = metadata.scan(tagged)
    assert not scan["clean"] and ("device" in scan["tags"] or "location" in scan["tags"])

    files = client.get(f"/api/m/{model}/metadata/files").json()
    row = next(f for f in files if f["name"] == "tagged.mp4")
    assert row["clean"] is False and row["tags"]

    res = client.post(f"/api/m/{model}/metadata/clean", json={"paths": [str(tagged)]}, headers=H)
    assert res.status_code == 200 and len(res.json()["cleaned"]) == 1
    assert metadata.scan(tagged)["clean"] is True  # metadata gone, file still plays
    assert probe(tagged).has_video


def test_metadata_clean_leaves_an_xmp_image_clean(client, model):
    from PIL import Image, PngImagePlugin  # noqa: PLC0415

    img_path = Path(personas.folder(personas.require(model), "references")) / "shot.png"
    meta = PngImagePlugin.PngInfo()
    meta.add_text("XML:com.adobe.xmp", '<x:xmpmeta xmlns:x="adobe:ns:meta/">c2pa claim</x:xmpmeta>')
    Image.new("RGB", (400, 400), (90, 120, 200)).save(img_path, pnginfo=meta)
    assert metadata.scan(img_path)["tags"] == ["AI/edit tag"]

    res = client.post(f"/api/m/{model}/metadata/clean", json={"paths": [str(img_path)]}, headers=H)
    assert res.status_code == 200 and not res.json()["failed"]
    assert metadata.scan(img_path)["clean"] is True


def test_editor_adds_the_edited_folder_to_every_model(client):
    mid = client.post("/api/models", json={"name": "Folders Check"}, headers=H).json()
    assert mid["folders"]["edited"].endswith("Edited reels")
    client.delete(f"/api/models/{mid['id']}", headers=H)


# ---------------------------------------------------------------- Prompt Making (reference video → prompt)

def test_prompt_maker_turns_a_video_into_a_generation_prompt(client, model, monkeypatch):
    """Reads real frames from the clip, then the (stubbed) local vision model returns the prompt JSON."""
    from hub.reels.ai import GENERATION_FIELDS  # noqa: PLC0415

    clip = Path(personas.folder(personas.require(model), "references")) / "clip.mp4"

    class StubBrain:
        name = "qwen3-vl:8b"

        async def generation_prompt(self, frames, caption="", seconds=None):
            assert frames and all(isinstance(f, (bytes, bytearray)) for f in frames)  # real frames were read
            return {**{f: "x" for f in GENERATION_FIELDS},
                    "prompt": "A young woman in a sunlit kitchen pours coffee, handheld slow push-in.",
                    "camera": "handheld medium shot, slow push-in"}

    async def fake_pick(name):
        return StubBrain(), None

    monkeypatch.setattr("hub.reels_api.pick_brain", fake_pick)
    res = client.post(f"/api/m/{model}/prompt-maker", json={"path": str(clip)}, headers=H)
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["prompt"]) == set(GENERATION_FIELDS)
    assert body["prompt"]["prompt"].startswith("A young woman")
    assert body["prompt"]["camera"] == "handheld medium shot, slow push-in"
    assert body["model"] == "qwen3-vl:8b" and body["seconds"] == 2


def test_prompt_maker_needs_a_local_vision_model(client, model, monkeypatch):
    from hub.reels.ai import KeywordBrain  # noqa: PLC0415

    clip = Path(personas.folder(personas.require(model), "references")) / "clip.mp4"

    async def no_vision(name):
        return KeywordBrain(), "Ollama isn't running"

    monkeypatch.setattr("hub.reels_api.pick_brain", no_vision)
    res = client.post(f"/api/m/{model}/prompt-maker", json={"path": str(clip)}, headers=H)
    assert res.status_code == 503 and "vision model" in res.json()["detail"]


def test_prompt_maker_rejects_a_file_outside_the_model(client, model):
    res = client.post(f"/api/m/{model}/prompt-maker", json={"path": "/etc/hosts"}, headers=H)
    assert res.status_code == 404
