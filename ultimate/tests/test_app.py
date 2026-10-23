"""End to end against a fake posting engine: models, their folders and library, accounts per model,
posting (with real ffmpeg), history, analytics and AI Studio's guard rails."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fakeengine import KEY, FakeEngine
from hub import postiz, settings
from hub.main import app
from hub.mediainfo import find_ffmpeg

H = {"X-Ultimate": "1"}
ENGINE = "https://postiz.example.duckdns.org"


@pytest.fixture(scope="module")
def engine():
    fake = FakeEngine()
    postiz.set_transport(fake.transport())
    yield fake
    postiz.set_transport(None)


@pytest.fixture(scope="module")
def client(engine):
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def make_video(path: Path, seconds: int = 2, size: str = "320x568") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([find_ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def wait_job(client, job_id: str, timeout: float = 60) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/api/media/{job_id}").json()
        if job["status"] != "processing":
            return job
        time.sleep(0.3)
    raise AssertionError("media job timed out")


state: dict = {}


def test_only_answers_on_localhost_and_needs_the_header(engine):
    with TestClient(app, base_url="http://evil.example.com") as other:
        assert other.get("/api/status").status_code == 403
    with TestClient(app, base_url="http://127.0.0.1") as c:
        assert c.post("/api/models", json={"name": "x"}).status_code == 403  # no X-Ultimate header


def test_models_with_their_own_folders(client):
    assert client.get("/api/models").json() == []
    mia = client.post("/api/models", json={"name": "  Mia  "}, headers=H)
    assert mia.status_code == 201, mia.text
    mia = mia.json()
    assert mia["name"] == "Mia"
    assert mia["folders"]["found"].endswith("Mia/Found videos")
    assert mia["folders"]["generated"].endswith("Mia/AI Studio")
    assert mia["folders"]["references"] == ""  # yours to connect
    assert client.post("/api/models", json={"name": "mia"}, headers=H).status_code == 400  # same name
    mike = client.post("/api/models", json={"name": "Mike"}, headers=H).json()
    assert mike["color"] != mia["color"]
    assert client.get("/api/status").json()["activeModel"] == mia["id"]
    state["mia"], state["mike"] = mia["id"], mike["id"]


def test_connect_folders_and_see_the_library(client, tmp_path):
    refs = tmp_path / "Mia references"
    make_video(refs / "dance.mp4")
    (refs / "notes.txt").write_text("not media")
    photos = tmp_path / "Mia photos"
    photos.mkdir()
    subprocess.run([find_ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=pink:s=64x64", "-frames:v", "1",
                    str(photos / "face.jpg")], check=True)
    res = client.put(f"/api/models/{state['mia']}", json={"folders": {"references": str(refs), "photos": str(photos)}},
                     headers=H)
    assert res.status_code == 200, res.text
    lib = client.get(f"/api/m/{state['mia']}/library").json()
    assert [i["name"] for i in lib["references"]["items"]] == ["dance.mp4"]
    assert [i["name"] for i in lib["photos"]["items"]] == ["face.jpg"]
    assert lib["found"]["connected"] is True
    thumb = client.get(f"/api/m/{state['mia']}/library/thumb", params={"path": str(refs / "dance.mp4")})
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    # Files outside the model's folders aren't served, and Mike can't read Mia's.
    outside = make_video(tmp_path / "elsewhere" / "x.mp4", 1)
    assert client.get(f"/api/m/{state['mia']}/library/file", params={"path": str(outside)}).status_code == 404
    assert client.get(f"/api/m/{state['mike']}/library/file", params={"path": str(refs / "dance.mp4")}).status_code == 404
    # Disconnecting "found" puts it back to the default folder.
    res = client.put(f"/api/models/{state['mia']}", json={"folders": {"found": ""}}, headers=H).json()
    assert res["folders"]["found"].endswith("Mia/Found videos")
    state["refs"] = refs


def test_connect_the_posting_engine(client, engine):
    status = client.get("/api/status").json()
    assert status["engine"]["state"] == "not-connected"
    bad = client.put("/api/settings/engine", json={"url": ENGINE, "apiKey": "wrong"}, headers=H)
    assert bad.status_code == 400
    # With the Postiz login instead of the key: the key is read for you.
    ok = client.put("/api/settings/engine", json={"url": f"{ENGINE}/", "email": "a@b.co", "password": "postiz-password"},
                    headers=H)
    assert ok.status_code == 200, ok.text
    assert ok.json()["engineUrl"] == ENGINE
    assert KEY not in ok.text  # never sent back to the page
    assert settings.get()["engineApiKey"] == KEY
    assert client.get("/api/status").json()["engine"]["state"] == "ok"


def test_accounts_belong_to_one_model(client, engine):
    mia, mike = state["mia"], state["mike"]
    # Accounts from the engine start unassigned (they may be your team's in Fifofarm).
    everything = client.get("/api/accounts").json()
    assert {a["id"]: a["modelId"] for a in everything} == {"ig1": None, "tt1": None, "x1": None}
    assert client.get(f"/api/m/{mia}/accounts").json() == []
    for acc in ("ig1", "tt1"):
        assert client.put(f"/api/accounts/{acc}/model", json={"modelId": mia}, headers=H).status_code == 200
    assert [a["id"] for a in client.get(f"/api/m/{mia}/accounts").json()] == ["ig1", "tt1"]
    assert client.get(f"/api/m/{mike}/accounts").json() == []
    # Connecting a network for Mike: the new account becomes Mike's.
    link = client.post(f"/api/m/{mike}/accounts/connect", json={"provider": "tiktok", "another": True}, headers=H).json()
    assert "disable_auto_auth=1" in link["url"]
    engine.integrations.append({"id": "tt2", "name": "Mike TikTok", "identifier": "tiktok", "picture": None,
                                "profile": "mike", "disabled": False})
    assert [a["id"] for a in client.get(f"/api/m/{mike}/accounts").json()] == ["tt2"]
    # A network your engine has no keys for says so.
    yt = client.post(f"/api/m/{mike}/accounts/connect", json={"provider": "youtube"}, headers=H)
    assert yt.status_code == 400 and "isn't set up" in yt.json()["error"]


def test_post_a_library_video_to_the_models_accounts(client, engine):
    mia, mike = state["mia"], state["mike"]
    video = state["refs"] / "dance.mp4"
    job = client.post(f"/api/m/{mia}/media/local", json={"path": str(video)}, headers=H)
    assert job.status_code == 202, job.text
    done = wait_job(client, job.json()["id"])
    assert done["status"] == "ready", done
    assert done["result"]["kind"] == "video" and done["result"]["durationSeconds"] > 1
    assert video.exists()  # your file is never deleted
    # Mike can't post Mia's file, and Mia can't post to Mike's account.
    assert client.post(f"/api/m/{mike}/media/local", json={"path": str(video)}, headers=H).status_code == 404
    bad = client.post(f"/api/m/{mia}/posts", json={"accountIds": ["tt2"], "caption": "hi", "mediaId": done["id"]}, headers=H)
    assert bad.status_code == 400
    preview = client.post(f"/api/m/{mia}/preview", json={"caption": "Dance #mia", "mediaId": done["id"]}, headers=H).json()
    assert set(preview) == {"ig1", "tt1"} and preview["ig1"]["problems"] == []
    posted = client.post(f"/api/m/{mia}/posts", json={"accountIds": ["ig1", "tt1"], "caption": "Dance & fun #mia",
                                                        "mediaId": done["id"]}, headers=H)
    assert posted.status_code == 201, posted.text
    batch = posted.json()
    assert batch["modelId"] == mia and all(i["postId"] for i in batch["items"])
    sent = engine.created[-1]["posts"][0]
    assert sent["value"][0]["content"] == "<p>Dance &amp; fun #mia</p>"
    tiktok = next(b for b in engine.created if b["posts"][0]["integration"]["id"] == "tt1")
    assert tiktok["posts"][0]["settings"]["privacy_level"] == "PUBLIC_TO_EVERYONE"
    history = client.get(f"/api/m/{mia}/batches").json()
    assert history[0]["id"] == batch["id"] and history[0]["counts"] == {"published": 2}
    assert client.get(f"/api/m/{mike}/batches").json() == []
    assert client.get(f"/api/m/{mike}/batches/{batch['id']}").status_code == 404
    state["batch"] = batch["id"]


def test_upload_from_the_page_and_a_rejected_post(client, engine, tmp_path):
    mia = state["mia"]
    video = make_video(tmp_path / "phone.mov", 1, size="1080x1920")
    job = client.post("/api/media", params={"name": "phone.mov"}, content=video.read_bytes(), headers=H)
    assert job.status_code == 202
    done = wait_job(client, job.json()["id"])
    assert done["status"] == "ready", done
    engine.reject_next = True
    posted = client.post(f"/api/m/{mia}/posts", json={"accountIds": ["ig1"], "caption": "x", "mediaId": done["id"]},
                         headers=H).json()
    assert posted["items"][0]["state"] == "failed"
    assert "too long" in posted["items"][0]["error"]
    retried = client.post(f"/api/m/{mia}/batches/{posted['id']}/retry", headers=H).json()
    assert retried["items"][0]["state"] == "published"


def test_analytics_per_model(client):
    mia, mike = state["mia"], state["mike"]
    res = client.post(f"/api/m/{mia}/analytics/refresh", params={"days": 30}, headers=H)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["totals"]["videos"] == 3 and data["totals"]["views"] == 360
    ig = next(a for a in data["accounts"] if a["id"] == "ig1")
    assert ig["network"][0]["value"] == 1500
    video = data["videos"][0]
    detail = client.get(f"/api/m/{mia}/analytics/videos/{video['postId']}").json()
    assert detail["history"][0]["views"] == 120
    assert client.get(f"/api/m/{mike}/analytics").json()["totals"]["videos"] == 0
    assert client.get(f"/api/m/{mike}/analytics/videos/{video['postId']}").status_code == 404


def test_reel_finder_space_per_model(client):
    mia, mike = state["mia"], state["mike"]
    s = client.get(f"/api/m/{mia}/reels/settings").json()
    assert s["output_dir"].endswith("Mia/Found videos")
    s["description"] = "slow dance in a neon room"
    saved = client.put(f"/api/m/{mia}/reels/settings", json=s, headers=H).json()
    assert saved["description"] == "slow dance in a neon room"
    assert client.get(f"/api/m/{mike}/reels/settings").json()["description"] == ""
    # A file from Mia's reference folder becomes a reference for Mia only.
    ref = client.post(f"/api/m/{mia}/reels/references/local", json={"path": str(state["refs"] / "dance.mp4")}, headers=H)
    assert ref.status_code == 200, ref.text
    assert len(client.get(f"/api/m/{mia}/reels/references").json()) == 1
    assert client.get(f"/api/m/{mike}/reels/references").json() == []
    status = client.get("/api/reels/status").json()
    assert status["hunting"] is False and "logins" in status
    assert client.get(f"/api/m/{mia}/reels/snapshot").json() == {"hunt": None, "selftests": []}


class FinishedHunt:
    running = False

    def snapshot(self) -> dict:
        return {"progress": {"downloaded": 3, "running": False}, "agents": [], "candidates": [], "logs": []}


def test_each_model_keeps_its_last_hunt(client):
    from hub import reels_api

    mia, mike = state["mia"], state["mike"]
    reels_api.state.last_hunts[mia] = FinishedHunt()
    try:
        # Mia's results stay on her page (e.g. while Mike hunts); Mike sees only his own.
        assert client.get(f"/api/m/{mia}/reels/snapshot").json()["hunt"]["progress"]["downloaded"] == 3
        assert client.get(f"/api/m/{mike}/reels/snapshot").json()["hunt"] is None
        thumbs = reels_api.thumbs_dir(mia)
        thumbs.mkdir(parents=True, exist_ok=True)
        (thumbs / "tiktok_1.jpg").write_bytes(b"\xff\xd8 a jpeg")
        assert client.get(f"/api/m/{mia}/reels/thumbs/tiktok_1.jpg").status_code == 200
        assert client.get(f"/api/m/{mike}/reels/thumbs/tiktok_1.jpg").status_code == 404
        assert client.get(f"/api/m/{mia}/reels/thumbs/..%2F..%2Fsettings.json").status_code == 404
        assert client.get("/api/m/nope/reels/snapshot").status_code == 404
    finally:
        reels_api.state.last_hunts.pop(mia, None)


def test_busy_and_the_ai_models_to_download(client):
    from hub import cli
    from hub.reels.config import DEFAULT_MODEL

    assert client.get("/api/busy").json() == {"busy": False, "reasons": []}
    assert cli.ai_models() == [DEFAULT_MODEL]  # Mia's saved settings use the default
    s = client.get(f"/api/m/{state['mike']}/reels/settings").json()
    client.put(f"/api/m/{state['mike']}/reels/settings", json={**s, "model": "qwen2.5vl:7b"}, headers=H)
    models = cli.ai_models()
    assert sorted(models) == sorted([DEFAULT_MODEL, "qwen2.5vl:7b"])  # each one once, for start.command to pull


def test_ai_studio_waits_for_its_key(client):
    mia = state["mia"]
    opts = client.get("/api/studio/options").json()
    assert opts["connected"] is False and "wan3.0-video" in [m["id"] for m in opts["models"]]
    res = client.post(f"/api/m/{mia}/studio/jobs", json={"mode": "text", "prompt": "Mia waving"}, headers=H)
    assert res.status_code == 424
    assert client.get(f"/api/m/{mia}/studio/jobs").json() == []


def wait_for(fetch, done, timeout: float = 90):
    end = time.time() + timeout
    while time.time() < end:
        value = fetch()
        if done(value):
            return value
        time.sleep(0.3)
    raise AssertionError(f"timed out: {value}")


def test_ai_studio_makes_a_video_with_wan(client, tmp_path):
    from fakewan import GOOD_KEY, FakeWan
    from hub import mediainfo, studio

    fake = FakeWan()
    studio.set_transport(fake.transport())
    mia = state["mia"]
    jobs = lambda: client.get(f"/api/m/{mia}/studio/jobs").json()  # noqa: E731
    try:
        # Each model uses its own key (there's no shared fallback, so billing stays per-model). Give
        # Mia her own Wan key. Wan 3.0 is served only on your workspace's own address, so the key is
        # checked against that address (region + workspace) before it's kept — and a key with no
        # workspace isn't live yet.
        K = f"/api/m/{mia}/studio/key"
        bad = client.put(K, json={"provider": "wan", "apiKey": "sk-wrong", "region": "intl", "workspace": "ws-test-123"},
                         headers=H)
        assert bad.status_code == 400 and "didn't accept" in bad.json()["error"]
        half = client.put(K, json={"provider": "wan", "apiKey": GOOD_KEY, "region": "intl"}, headers=H)
        assert half.status_code == 200 and GOOD_KEY not in half.text  # key saved, but…
        wan = client.get(K).json()["keys"]["wan"]
        assert wan["hasKey"] is True and wan["connected"] is False and wan["usingDefault"] is False  # needs workspace
        assert client.put(K, json={"provider": "wan", "region": "intl", "workspace": "x.evil.com/"}, headers=H).status_code == 400
        ok = client.put(K, json={"provider": "wan", "apiKey": GOOD_KEY, "region": "intl", "workspace": "ws-test-123"},
                        headers=H)
        assert ok.status_code == 200, ok.text
        assert fake.hosts[-1] == "ws-test-123.ap-southeast-1.maas.aliyuncs.com"  # checked on Wan's own address
        assert client.get(f"/api/m/{mia}/studio/options").json()["connected"] is True
        fake.policies.clear()  # forget the getPolicy from the key check

        # "Make this video with Mia": a 20 s find + a photo of her.
        folders = client.get("/api/models").json()[0]["folders"]
        find = make_video(Path(folders["found"]) / "long find.mp4", seconds=20)
        face = Path(folders["photos"]) / "face.jpg"
        res = client.post(f"/api/m/{mia}/studio/jobs", headers=H, json={
            "mode": "reference", "videos": [str(find)], "photos": [str(face)], "prompt": "golden hour light",
            "duration": 20, "ratio": "9:16", "resolution": "720P"})
        assert res.status_code == 201, res.text
        job = wait_for(lambda: jobs()[0], lambda j: j["status"] != "starting")
        assert job["status"] == "PENDING", job
        task = fake.tasks["task-1"]
        body = task["body"]
        assert body["model"] == "wan3.0-video" and fake.policies == ["wan3.0-video", "wan3.0-video"]
        assert [m["type"] for m in body["input"]["media"]] == ["reference_image", "reference_video"]
        assert all(m["url"].startswith("oss://dashscope-instant/") for m in body["input"]["media"])
        assert task["headers"]["x-dashscope-ossresourceresolve"] == "enable"
        assert body["parameters"] == {"resolution": "720P", "ratio": "9:16", "duration": 15, "audio": True,
                                      "prompt_extend": True, "watermark": False}  # 15 s in + 15 s out ≤ 30
        prompt = body["input"]["prompt"]
        assert "Image 1" in prompt and "Video 1" in prompt and prompt.endswith("golden hour light")
        assert all(fields[-1] == "file" for fields in fake.upload_fields)  # OSS wants the file last
        # The find was cut to 15 s; the tiny photo became a JPEG of at least 240 px.
        uploaded = {Path(k).suffix: v for k, v in fake.uploads.items()}
        (tmp_path / "clip.mp4").write_bytes(uploaded[".mp4"])
        (tmp_path / "photo.jpg").write_bytes(uploaded[".jpg"])
        clip, photo = mediainfo.probe(tmp_path / "clip.mp4"), mediainfo.probe(tmp_path / "photo.jpg")
        assert 14 <= clip.duration <= 15 and clip.video_codec == "h264"
        assert min(photo.width, photo.height) >= 240

        # Wan works on it, then the video lands in Mia's AI Studio folder and library.
        client.portal.call(studio.poll_once)
        assert jobs()[0]["status"] == "RUNNING"
        client.portal.call(studio.poll_once)
        job = jobs()[0]
        assert job["status"] == "saved", job
        assert Path(job["file"]).read_bytes() == fake.result
        assert Path(job["file"]).parent == Path(folders["generated"])
        lib = client.get(f"/api/m/{mia}/library").json()
        assert Path(job["file"]).name in [i["name"] for i in lib["generated"]["items"]]

        # A task Wan refuses says why.
        res = client.post(f"/api/m/{mia}/studio/jobs", json={"mode": "text", "prompt": "Mia waving"}, headers=H)
        assert res.status_code == 201
        wait_for(lambda: jobs()[0], lambda j: j["status"] != "starting")
        assert "prompt" in fake.tasks["task-2"]["body"]["input"] and "media" not in fake.tasks["task-2"]["body"]["input"]
        fake.fail_next_task = "task-2"
        client.portal.call(studio.poll_once)
        failed = jobs()[0]
        assert failed["status"] == "failed" and "inappropriate content" in failed["error"]
        # Mike doesn't see Mia's videos.
        assert client.get(f"/api/m/{state['mike']}/studio/jobs").json() == []
    finally:
        studio.set_transport(None)
        settings.save({"alibabaApiKey": "", "alibabaRegion": "intl", "alibabaWorkspace": "", "studioKeys": {}})


def test_removing_a_model_keeps_your_files(client):
    from hub import reels_api

    mike = state["mike"]
    reels_api.state.last_hunts[mike] = FinishedHunt()
    assert client.delete(f"/api/models/{mike}", headers=H).status_code == 200
    assert mike not in reels_api.state.last_hunts
    everything = {a["id"]: a["modelId"] for a in client.get("/api/accounts").json()}
    assert everything["tt2"] is None  # back to unassigned, still connected
    assert state["refs"].joinpath("dance.mp4").exists()
    assert [m["name"] for m in client.get("/api/models").json()] == ["Mia"]
