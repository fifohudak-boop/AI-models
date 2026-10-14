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


# ---------------------------------------------------------------- AI Studio: cost & spending

def test_cost_maths_and_rates(client):
    rate = studio.price_per_second("wan3.0-video", "720P")
    assert rate and abs(studio.estimate_cost("wan3.0-video", "720P", 10) - rate * 10) < 1e-6
    assert studio.estimate_cost("wan3.0-video", "720P", 0) is None  # no length, no estimate

    opts = client.get("/api/studio/options").json()
    assert opts["currency"] == "USD" and opts["rates"]["wan3.0-video"]["1080P"] > 0
    assert opts["rates"]["wan3.0-video-prime"]["1080P"] > opts["rates"]["wan3.0-video"]["1080P"]

    before = settings.get()["studioRates"]
    try:
        saved = client.put("/api/studio/rates", json={"currency": "EUR", "rates": {
            "wan3.0-video": {"480P": 0.05, "720P": 0.1, "1080P": 0.2}}}, headers=H)
        assert saved.status_code == 200
        assert studio.currency() == "EUR" and studio.price_per_second("wan3.0-video", "1080P") == 0.2
        assert client.put("/api/studio/rates", json={"currency": "USD", "rates": {
            "wan3.0-video": {"1080P": "free"}}}, headers=H).status_code == 400  # not a number
    finally:
        settings.save({"studioCurrency": "USD", "studioRates": before})


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
