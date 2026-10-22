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
    keys = client.get(f"/api/m/{mid}/studio/key").json()["keys"]
    assert keys["seedance"]["hasKey"] is True and keys["seedance"]["connected"] is True

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
    assert opts["kind"] == "image" and opts["modes"] == [
        {"id": "text", "name": "From a prompt"},
        {"id": "image", "name": "From a photo"},
        {"id": "reference", "name": "Recreate a picture, with your model"},
    ]
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


def test_wavespeed_makes_a_video(client, tmp_path):
    from fakewave import GOOD_KEY as WS_KEY, FakeWaveSpeed  # noqa: PLC0415

    ws = FakeWaveSpeed()
    studio.set_transport(ws.transport())
    try:
        mid = _model_with_photo(client, "WaveMia", tmp_path)
        r = client.put(f"/api/m/{mid}/studio/key", headers=H,
                       json={"provider": "wavespeed", "apiKey": WS_KEY, "region": "global"})
        assert r.status_code == 200, r.text
        assert ws.hosts[-1] == "api.wavespeed.ai"  # key checked on WaveSpeed

        opts = client.get(f"/api/m/{mid}/studio/options").json()
        assert opts["provider"] == "wavespeed" and opts["kind"] == "video"
        assert opts["durations"] == {"min": 4, "max": 30, "auto": False, "default": 5}

        jobs = lambda: client.get(f"/api/m/{mid}/studio/jobs").json()  # noqa: E731
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "text", "prompt": "Mia dancing", "model": "seedance-2.5", "resolution": "720p", "duration": 5})
        assert res.status_code == 201, res.text
        wait_for(lambda: jobs()[0], lambda j: j["status"] != "starting")
        task = ws.tasks[list(ws.tasks)[-1]]
        assert task["model_path"] == "bytedance/seedance-2.5/text-to-video"
        assert task["body"]["resolution"] == "720p" and task["body"]["duration"] == 5

        client.portal.call(studio.poll_once)  # processing
        client.portal.call(studio.poll_once)  # completed → downloaded
        job = jobs()[0]
        assert job["status"] == "saved", job
        assert Path(job["file"]).suffix == ".mp4" and Path(job["file"]).read_bytes() == ws.video_bytes
        assert job["cost"] == 1.8 and job["provider"] == "wavespeed"  # 720p × 5s on WaveSpeed Seedance
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_wavespeed_image_mode_uses_the_i2v_path(client, tmp_path):
    from fakewave import GOOD_KEY as WS_KEY, FakeWaveSpeed  # noqa: PLC0415

    ws = FakeWaveSpeed()
    studio.set_transport(ws.transport())
    try:
        mid = _model_with_photo(client, "WaveImg", tmp_path)
        client.put(f"/api/m/{mid}/studio/key", headers=H,
                   json={"provider": "wavespeed", "apiKey": WS_KEY, "region": "global"})
        folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
        face = str(Path(folders["references"]) / "face.jpg")
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "image", "photos": [face], "model": "seedance-2.5-turbo", "resolution": "480p", "duration": 6})
        assert res.status_code == 201, res.text
        wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0], lambda j: j["status"] != "starting")
        task = ws.tasks[list(ws.tasks)[-1]]
        assert task["model_path"] == "bytedance/seedance-2.5/image-to-video-turbo"
        assert task["body"]["image"].startswith("data:image/jpeg;base64,")
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_argolink_makes_an_image(client, tmp_path):
    from fakeargo import GOOD_KEY as ARGO_KEY, PNG_BYTES, FakeArgoLink  # noqa: PLC0415

    argo = FakeArgoLink()
    studio.set_transport(argo.transport())
    try:
        mid = _model_with_photo(client, "ArgoMia", tmp_path)
        r = client.put(f"/api/m/{mid}/studio/key", headers=H,
                       json={"provider": "argolink", "apiKey": ARGO_KEY, "region": "global"})
        assert r.status_code == 200, r.text
        assert argo.hosts[-1] == "argolink.io"  # key checked on ArgoLink

        opts = client.get(f"/api/m/{mid}/studio/options").json()
        assert opts["provider"] == "argolink" and opts["kind"] == "image"
        assert opts["resolutions"] == ["1K", "2K"]

        jobs = lambda: client.get(f"/api/m/{mid}/studio/jobs").json()  # noqa: E731
        # text → /images/generations (URL response, downloaded)
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "text", "prompt": "portrait of Mia", "model": "seedream-5.0-pro", "resolution": "2K", "ratio": "9:16"})
        assert res.status_code == 201, res.text
        job = wait_for(lambda: jobs()[0], lambda j: j["status"] in ("saved", "failed"))
        assert job["status"] == "saved", job
        assert Path(job["file"]).suffix == ".png" and Path(job["file"]).read_bytes() == PNG_BYTES
        assert job["cost"] == 0.03 and job["provider"] == "argolink"
        gen = argo.generations[-1]
        assert gen["model"] == "seedream-5.0-pro" and gen["resolution"] == "2k" and gen["aspect_ratio"] == "9:16"

        # photo → /images/edits with the reference image inline (base64 response, decoded)
        folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
        face = str(Path(folders["references"]) / "face.jpg")
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "image", "photos": [face], "model": "seedream-5.0-pro", "resolution": "1K", "ratio": "1:1"})
        assert res.status_code == 201, res.text
        job = wait_for(lambda: jobs()[0], lambda j: j["status"] in ("saved", "failed"))
        assert job["status"] == "saved", job
        assert Path(job["file"]).read_bytes() == PNG_BYTES  # decoded from b64_json
        edit = argo.edits[-1]
        assert edit["resolution"] == "1k" and edit["images"][0]["image_url"].startswith("data:image/jpeg;base64,")
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_argolink_recreates_a_picture_with_the_model(client, tmp_path):
    """Image 'reference' mode: one picture to recreate + the model's photos, kept separate (reference
    first, then the person's photos) and the prompt spelling out the roles."""
    from fakeargo import GOOD_KEY as ARGO_KEY, FakeArgoLink  # noqa: PLC0415

    argo = FakeArgoLink()
    studio.set_transport(argo.transport())
    try:
        mid = _model_with_photo(client, "ArgoRef", tmp_path)
        client.put(f"/api/m/{mid}/studio/key", headers=H,
                   json={"provider": "argolink", "apiKey": ARGO_KEY, "region": "global"})

        # The mode is offered with an image-specific label.
        opts = client.get(f"/api/m/{mid}/studio/options").json()
        assert {"id": "reference", "name": "Recreate a picture, with your model"} in opts["modes"]

        folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
        refs = Path(folders["references"])
        Image.new("RGB", (640, 800), (200, 90, 90)).save(refs / "scene.jpg")  # the picture to recreate
        scene, face = str(refs / "scene.jpg"), str(refs / "face.jpg")

        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "reference", "videos": [scene], "photos": [face],
            "model": "seedream-5.0-pro", "resolution": "2K", "ratio": "9:16", "prompt": "golden hour light"})
        assert res.status_code == 201, res.text
        job = wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0], lambda j: j["status"] in ("saved", "failed"))
        assert job["status"] == "saved", job

        edit = argo.edits[-1]  # reference mode goes through /images/edits with the images in order
        assert len(edit["images"]) == 2  # [picture to recreate, model photo]
        assert all(img["image_url"].startswith("data:image/jpeg;base64,") for img in edit["images"])
        # The prompt keeps the two apart: recreate Image 1 with the person in Image 2.
        assert "Image 1" in job["sentPrompt"] and "Image 2" in job["sentPrompt"]
        assert "golden hour light" in job["sentPrompt"]
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_videorouter_makes_a_video(client, tmp_path):
    from fakevideorouter import GOOD_KEY as VR_KEY, FakeVideoRouter  # noqa: PLC0415

    vr = FakeVideoRouter()
    studio.set_transport(vr.transport())
    try:
        mid = _model_with_photo(client, "RouterMia", tmp_path)
        r = client.put(f"/api/m/{mid}/studio/key", headers=H,
                       json={"provider": "videorouter", "apiKey": VR_KEY, "region": "global"})
        assert r.status_code == 200, r.text
        assert vr.hosts[-1] == "videorouter.sh"  # key checked on VideoRouter

        opts = client.get(f"/api/m/{mid}/studio/options").json()
        assert opts["provider"] == "videorouter" and opts["kind"] == "video"
        assert opts["durations"] == {"min": 3, "max": 12, "auto": False, "default": 5}
        assert opts["models"][0]["id"] == "bytedance/seedance-2.5/fal"

        jobs = lambda: client.get(f"/api/m/{mid}/studio/jobs").json()  # noqa: E731
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "text", "prompt": "Mia dancing", "model": "bytedance/seedance-2.5/fal",
            "resolution": "720p", "duration": 5})
        assert res.status_code == 201, res.text
        wait_for(lambda: jobs()[0], lambda j: j["status"] != "starting")
        task = vr.jobs[list(vr.jobs)[-1]]
        assert task["body"]["model"] == "bytedance/seedance-2.5/fal"
        assert task["body"]["duration_secs"] == 5 and task["body"]["resolution"] == "720p"
        assert task["body"]["aspect_ratio"] == "9:16"

        client.portal.call(studio.poll_once)  # in_progress
        client.portal.call(studio.poll_once)  # completed → downloaded
        job = jobs()[0]
        assert job["status"] == "saved", job
        assert Path(job["file"]).suffix == ".mp4" and Path(job["file"]).read_bytes() == vr.video_bytes
        assert job["cost"] == 0.4 and job["provider"] == "videorouter"  # 0.08/s × 5s
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_videorouter_image_mode_sends_a_first_frame(client, tmp_path):
    from fakevideorouter import GOOD_KEY as VR_KEY, FakeVideoRouter  # noqa: PLC0415

    vr = FakeVideoRouter()
    studio.set_transport(vr.transport())
    try:
        mid = _model_with_photo(client, "RouterImg", tmp_path)
        client.put(f"/api/m/{mid}/studio/key", headers=H,
                   json={"provider": "videorouter", "apiKey": VR_KEY, "region": "global"})
        folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
        face = str(Path(folders["references"]) / "face.jpg")
        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "image", "photos": [face], "model": "bytedance/seedance-2.0/fal",
            "resolution": "480p", "duration": 4})
        assert res.status_code == 201, res.text
        wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0], lambda j: j["status"] != "starting")
        task = vr.jobs[list(vr.jobs)[-1]]
        assert task["body"]["model"] == "bytedance/seedance-2.0/fal"
        assert task["body"]["start_image_url"].startswith("data:image/jpeg;base64,")
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_a_models_provider_is_isolated(client, fake, tmp_path):
    a = _model_with_photo(client, "ProvA", tmp_path)
    b = _model_with_photo(client, "ProvB", tmp_path)
    _connect(client, a, "seedance")
    _connect(client, b, "seedream")
    assert studio.connected_providers(a) == ["seedance"] and studio.connected_providers(b) == ["seedream"]
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


def test_a_whole_folder_is_recreated_as_a_batch(client, tmp_path):
    """Drop a folder of pictures to recreate: each is rebuilt with the same model photos and prompt,
    tracked on one job, with one total price (0.03 each → e.g. 5 = 0.15)."""
    from fakeargo import GOOD_KEY as ARGO_KEY, PNG_BYTES, FakeArgoLink  # noqa: PLC0415

    argo = FakeArgoLink()
    studio.set_transport(argo.transport())
    try:
        mid = _model_with_photo(client, "BatchRef", tmp_path)
        client.put(f"/api/m/{mid}/studio/key", headers=H,
                   json={"provider": "argolink", "apiKey": ARGO_KEY, "region": "global"})
        folders = next(m["folders"] for m in client.get("/api/models").json() if m["id"] == mid)
        refs = Path(folders["references"])
        scenes = []
        for i in range(5):
            Image.new("RGB", (640, 800), (40 * i, 90, 120)).save(refs / f"scene{i}.jpg")
            scenes.append(str(refs / f"scene{i}.jpg"))
        face = str(refs / "face.jpg")

        res = client.post(f"/api/m/{mid}/studio/jobs", headers=H, json={
            "mode": "reference", "videos": scenes, "photos": [face],
            "model": "seedream-5.0-pro", "resolution": "2K", "ratio": "9:16", "prompt": "golden hour"})
        assert res.status_code == 201, res.text
        job = wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0],
                       lambda j: j["status"] in ("saved", "failed"))
        assert job["status"] == "saved", job
        assert job["batch"] is True and job["total"] == 5 and job["done"] == 5 and job.get("failedCount") == 0
        # one output per reference, all distinct files, each a real image
        assert len(job["files"]) == 5 and len(set(job["files"])) == 5
        assert all(Path(f).suffix == ".png" and Path(f).read_bytes() == PNG_BYTES for f in job["files"])
        assert job["file"] in job["files"]
        # billed per picture, one total
        assert job["cost"] == 0.15 and job["provider"] == "argolink"
        # the provider was called once per reference, each with [scene, face] kept in order
        assert len(argo.edits) == 5
        assert all(len(e["images"]) == 2 for e in argo.edits)
        # the prompt is the same for every picture in the batch
        assert "Image 1" in job["sentPrompt"] and "golden hour" in job["sentPrompt"]
    finally:
        studio.set_transport(None)
        settings.save({"studioKeys": {}})


def test_a_dropped_picture_is_saved_and_usable(client, fake, tmp_path):
    """A picture dragged straight onto the page is stored in the model's drop area and can be used in
    a generation (and served) exactly like a library file — no folder needs connecting."""
    import io  # noqa: PLC0415

    mid = _model_with_photo(client, "DropMei", tmp_path)
    _connect(client, mid, "seedream")
    buf = io.BytesIO()
    Image.new("RGB", (512, 640), (120, 60, 160)).save(buf, format="PNG")
    up = client.post(f"/api/m/{mid}/studio/upload?name=dropped.png", headers=H, content=buf.getvalue())
    assert up.status_code == 201, up.text
    drop = up.json()
    assert drop["kind"] == "image" and drop["path"].endswith(".png") and "/uploads/" in drop["path"].replace("\\", "/")
    # it's served like any library file (inside_folders accepts the drop area)
    assert client.get(f"/api/m/{mid}/library/file?path={drop['path']}").status_code == 200
    # and a generation can start from it
    res = client.post(f"/api/m/{mid}/studio/jobs", headers=H,
                      json={"mode": "image", "photos": [drop["path"]], "resolution": "2K", "ratio": "1:1"})
    assert res.status_code == 201, res.text
    job = wait_for(lambda: client.get(f"/api/m/{mid}/studio/jobs").json()[0], lambda j: j["status"] in ("saved", "failed"))
    assert job["status"] == "saved", job


def test_a_non_media_upload_is_refused(client, fake, tmp_path):
    mid = _model_with_photo(client, "DropBad", tmp_path)
    bad = client.post(f"/api/m/{mid}/studio/upload?name=notes.txt", headers=H, content=b"hello")
    assert bad.status_code == 415
