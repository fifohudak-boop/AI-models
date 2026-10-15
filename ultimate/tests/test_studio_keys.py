"""Per-model AI Studio keys: each model can carry its own Alibaba key + region + workspace, so
different models can be on different accounts. A model without its own key uses the shared default."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from fakewan import GOOD_KEY, FakeWan
from hub import settings, studio
from hub.main import app

H = {"X-Ultimate": "1"}
SHARE = "ultimate.example.com"


@pytest.fixture()
def owner():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture()
def fake():
    f = FakeWan()
    studio.set_transport(f.transport())
    yield f
    studio.set_transport(None)
    settings.save({"alibabaApiKey": "", "alibabaWorkspace": "", "studioKeys": {}})


def test_each_model_uses_its_own_key(owner, fake):
    a = owner.post("/api/models", json={"name": "KeyA"}, headers=H).json()
    b = owner.post("/api/models", json={"name": "KeyB"}, headers=H).json()

    # A gets its own Singapore workspace — the key is checked against A's own address.
    r = owner.put(f"/api/m/{a['id']}/studio/key", headers=H,
                  json={"apiKey": GOOD_KEY, "region": "intl", "workspace": "ws-aaa-111"})
    assert r.status_code == 200, r.text
    assert fake.hosts[-1] == "ws-aaa-111.ap-southeast-1.maas.aliyuncs.com"
    key = r.json()
    assert key["hasOwnKey"] is True and key["usingDefault"] is False
    assert key["region"] == "intl" and key["workspace"] == "ws-aaa-111"
    assert "…" in key["keyMasked"]  # masked, never the real key

    # B gets a different workspace in a different region.
    r2 = owner.put(f"/api/m/{b['id']}/studio/key", headers=H,
                   json={"apiKey": GOOD_KEY, "region": "eu", "workspace": "ws-bbb-222"})
    assert r2.status_code == 200, r2.text
    assert fake.hosts[-1] == "ws-bbb-222.eu-central-1.maas.aliyuncs.com"

    # Each model is connected and resolves to its own address, independently.
    assert owner.get(f"/api/m/{a['id']}/studio/options").json()["connected"] is True
    assert owner.get(f"/api/m/{b['id']}/studio/options").json()["connected"] is True
    assert studio.creds(a["id"])["workspace"] == "ws-aaa-111"
    assert studio.base_url(b["id"]) == "https://ws-bbb-222.eu-central-1.maas.aliyuncs.com"


def test_the_default_key_is_the_fallback(owner, fake):
    c = owner.post("/api/models", json={"name": "KeyC"}, headers=H).json()

    # No own key and no default yet → not connected.
    k = owner.get(f"/api/m/{c['id']}/studio/key").json()
    assert k["usingDefault"] is True and k["hasOwnKey"] is False
    assert owner.get(f"/api/m/{c['id']}/studio/options").json()["connected"] is False

    # The shared default makes it connected (via the fallback).
    owner.put("/api/settings/studio", headers=H,
              json={"apiKey": GOOD_KEY, "region": "intl", "workspace": "ws-def-999"})
    assert owner.get(f"/api/m/{c['id']}/studio/options").json()["connected"] is True
    assert studio.base_url(c["id"]) == "https://ws-def-999.ap-southeast-1.maas.aliyuncs.com"

    # Its own key overrides the default…
    owner.put(f"/api/m/{c['id']}/studio/key", headers=H,
              json={"apiKey": GOOD_KEY, "region": "intl", "workspace": "ws-own-333"})
    assert studio.base_url(c["id"]) == "https://ws-own-333.ap-southeast-1.maas.aliyuncs.com"
    # …and removing it falls back to the default again.
    owner.put(f"/api/m/{c['id']}/studio/key", headers=H, json={"apiKey": ""})
    assert studio.base_url(c["id"]) == "https://ws-def-999.ap-southeast-1.maas.aliyuncs.com"


def test_a_bad_workspace_is_rejected(owner, fake):
    m = owner.post("/api/models", json={"name": "KeyBad"}, headers=H).json()
    bad = owner.put(f"/api/m/{m['id']}/studio/key", headers=H,
                    json={"apiKey": GOOD_KEY, "region": "intl", "workspace": "not a workspace"})
    assert bad.status_code == 400


def test_guests_cannot_see_or_set_a_models_key(owner, fake):
    m = owner.post("/api/models", json={"name": "KeyGuest"}, headers=H).json()
    owner.put("/api/sharing", json={"enabled": True, "host": SHARE}, headers=H)
    owner.post("/api/auth/users", headers=H,
               json={"username": "keyben", "password": "s3cret12", "name": "Ben", "models": [m["id"]]})
    with TestClient(app, base_url=f"https://{SHARE}") as g:
        assert g.post("/api/auth/login", headers=H,
                      json={"username": "keyben", "password": "s3cret12"}).status_code == 200
        # A guest can use the page (options) but never see or change the key.
        assert g.get(f"/api/m/{m['id']}/studio/options").status_code == 200
        assert g.get(f"/api/m/{m['id']}/studio/key").status_code == 403
        assert g.put(f"/api/m/{m['id']}/studio/key", headers=H,
                     json={"apiKey": GOOD_KEY, "region": "intl", "workspace": "ws-xxx-444"}).status_code == 403
