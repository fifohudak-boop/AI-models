"""ByteDance providers: Seedance (video, async task) and Seedream (image, synchronous), each driven
through a fake ModelArk transport. Also the provider-aware key saving."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from fakebyte import GOOD_KEY, FakeByteDance
from hub import settings, studio
from hub.main import app

H = {"X-Ultimate": "1"}


@pytest.fixture()
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture()
def fake():
    f = FakeByteDance()
    studio.set_transport(f.transport())
    yield f
    studio.set_transport(None)
    settings.save({"studioKeys": {}})


def wait_for(fetch, done, timeout: float = 30):
    end = time.time() + timeout
    job = None
    while time.time() < end:
        job = fetch()
        if job and done(job):
            return job
        time.sleep(0.2)
    raise AssertionError(f"timed out: {job}")


def _model_with_photo(client, name: str, tmp_path: Path) -> str:
    refs = tmp_path / name
    refs.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (640, 1138), (90, 120, 200)).save(refs / "face.jpg")
    mid = client.post("/api/models", json={"name": name}, headers=H).json()["id"]
    client.put(f"/api/models/{mid}", json={"folders": {"references": str(refs)}}, headers=H)
    return mid


def _connect(client, mid: str, provider: str) -> None:
    res = client.put(f"/api/m/{mid}/studio/key", headers=H,
                     json={"provider": provider, "apiKey": GOOD_KEY, "region": "intl"})
    assert res.status_code == 200, res.text


def test_seedance_makes_a_video(client, fake, tmp_path):
    mid = _model_with_photo(client, "SeedanceModel", tmp_path)
    _connect(client, mid, "seedance")
    assert fake.hosts[-1] == "ark.ap-southeast.bytepluses.com"  # key checked on the ByteDance host

    opts = client.get(f"/api/m/{mid}/studio/options").json()
    assert opts["provider"] == "seedance" and opts["kind"] == "video"
    assert opts["connected"] is True and opts["durations"]["min"] == 4
    key = client.get(f"/api/m/{mid}/studio/key").json()
    assert key["provider"] == "seedance" and key["needsWorkspace"] is False

    jobs = lambda: client.get(f"/api/m/{mid}/studio/jobs").json()  # noqa: E731
    res = client.post(f"/api/m/{mid}/studio/jobs", headers=H,
                      json={"mode": "text", "prompt": "Mei dancing in neon", "resolution": "720p", "duration": 6})
    assert res.status_code == 201, res.text
    job = wait_for(lambda: jobs()[0], lambda j: j["status"] != "starting")
    assert job["status"] == "PENDING"
    body = fake.video_tasks["vtask-1"]["body"]
    assert body["model"] == "seedance-1.0-pro" and body["resolution"] == "720p" and body["duration"] == 6
    assert body["content"][0]["text"].startswith("Mei dancing")

    client.portal.call(studio.poll_once)  # running
    client.portal.call(studio.poll_once)  # succeeded → downloaded
    job = jobs()[0]
    assert job["status"] == "saved", job
    assert Path(job["file"]).suffix == ".mp4" and Path(job["file"]).read_bytes() == fake.video_bytes
    # 720p 6s on Seedance Pro, priced automatically from the token formula.
    assert abs(job["cost"] - 0.324) < 0.01 and job["provider"] == "seedance"


def test_seedance_image_mode_sends_a_first_frame(client, fake, tmp_path):
    mid = _model_with_photo(client, "SeedanceImg", tmp_path)
    _connect(client, mid, "seedance")
    face = str(Path(client.get("/api/models").json()[0]["folders"]["references"]) / "face.jpg")
    # the model list may hold several; find this model's folder
    folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
    face = str(Path(folders["references"]) / "face.jpg")
    res = client.post(f"/api/m/{mid}/studio/jobs", headers=H,
                      json={"mode": "image", "photos": [face], "prompt": "make her walk", "resolution": "480p"})
    assert res.status_code == 201, res.text
    wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0], lambda j: j["status"] != "starting")
    body = fake.video_tasks[list(fake.video_tasks)[-1]]["body"]
    roles = [c.get("role") for c in body["content"] if c["type"] == "image_url"]
    assert roles == ["first_frame"]
    assert body["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_seedream_makes_an_image(client, fake, tmp_path):
    mid = _model_with_photo(client, "SeedreamModel", tmp_path)
    _connect(client, mid, "seedream")
    opts = client.get(f"/api/m/{mid}/studio/options").json()
    assert opts["kind"] == "image" and opts["modes"] == [{"id": "text", "name": "From a prompt"},
                                                          {"id": "image", "name": "From a photo (first frame)"}]
    jobs = lambda: client.get(f"/api/m/{mid}/studio/jobs").json()  # noqa: E731
    res = client.post(f"/api/m/{mid}/studio/jobs", headers=H,
                      json={"mode": "text", "prompt": "portrait of Mei, studio light", "resolution": "2K", "ratio": "9:16"})
    assert res.status_code == 201, res.text
    # Seedream is synchronous — it saves without any polling.
    job = wait_for(lambda: jobs()[0], lambda j: j["status"] in ("saved", "failed"))
    assert job["status"] == "saved", job
    assert Path(job["file"]).suffix == ".png" and Path(job["file"]).read_bytes() == fake.image_bytes
    assert job["cost"] == 0.03 and job["provider"] == "seedream"
    call = fake.image_calls[-1]
    assert call["model"] == "seedream-4.0" and "x" in call["size"] and call["response_format"] == "url"


def test_a_models_provider_is_isolated(client, fake, tmp_path):
    a = _model_with_photo(client, "ProvA", tmp_path)
    b = _model_with_photo(client, "ProvB", tmp_path)
    _connect(client, a, "seedance")
    _connect(client, b, "seedream")
    assert studio.provider_of(a) == "seedance" and studio.provider_of(b) == "seedream"
    assert client.get(f"/api/m/{a}/studio/options").json()["kind"] == "video"
    assert client.get(f"/api/m/{b}/studio/options").json()["kind"] == "image"


def test_bad_provider_or_region_is_rejected(client, fake, tmp_path):
    mid = _model_with_photo(client, "BadCfg", tmp_path)
    assert client.put(f"/api/m/{mid}/studio/key", headers=H,
                      json={"provider": "nope", "apiKey": GOOD_KEY, "region": "intl"}).status_code == 400
    # Wan regions aren't ByteDance regions.
    assert client.put(f"/api/m/{mid}/studio/key", headers=H,
                      json={"provider": "seedance", "apiKey": GOOD_KEY, "region": "eu"}).status_code == 400
    # a wrong key is caught on the ByteDance host
    assert client.put(f"/api/m/{mid}/studio/key", headers=H,
                      json={"provider": "seedance", "apiKey": "byte-wrong", "region": "intl"}).status_code == 400
