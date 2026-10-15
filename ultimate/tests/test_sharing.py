"""Sharing: logging in from outside the Mac, and each person seeing and using only their own models.

On localhost you're always the owner (no login). From the share address people must log in, and a
guest sees only the models you gave them — but on those models they can do everything.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.main import app

H = {"X-Ultimate": "1"}
SHARE = "ultimate.example.com"


@pytest.fixture(scope="module")
def owner():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture(scope="module")
def world(owner):
    mia = owner.post("/api/models", json={"name": "ShareMia"}, headers=H).json()
    mike = owner.post("/api/models", json={"name": "ShareMike"}, headers=H).json()
    turned_on = owner.put("/api/sharing", json={"enabled": True, "host": SHARE}, headers=H)
    assert turned_on.status_code == 200, turned_on.text
    created = owner.post("/api/auth/users", headers=H, json={
        "username": "Ben", "password": "s3cret!", "name": "Ben", "models": [mia["id"]]})
    assert created.status_code == 201, created.text
    return {"mia": mia["id"], "mike": mike["id"], "guest": created.json()}


def guest(username: str = "ben", password: str = "s3cret!") -> TestClient:
    c = TestClient(app, base_url=f"https://{SHARE}")
    assert c.post("/api/auth/login", headers=H, json={"username": username, "password": password}).status_code == 200
    return c


def test_localhost_is_the_owner_without_logging_in(owner):
    me = owner.get("/api/auth/me").json()
    assert me["canManage"] is True
    assert me["local"] is True
    assert me["models"] is None  # the owner sees every model


def test_the_share_address_requires_a_login(world):
    with TestClient(app, base_url=f"https://{SHARE}") as c:
        assert c.get("/api/auth/me").status_code == 401
        assert c.get("/api/models").status_code == 401
        assert c.get(f"/api/m/{world['mia']}/studio/jobs").status_code == 401
        assert c.post("/api/models", json={"name": "x"}, headers=H).status_code == 401


def test_other_web_addresses_are_still_blocked(world):
    with TestClient(app, base_url="https://evil.example.com") as c:
        assert c.get("/api/status").status_code == 403


def test_username_and_password_must_match(world):
    with TestClient(app, base_url=f"https://{SHARE}") as c:
        assert c.post("/api/auth/login", headers=H,
                      json={"username": "ben", "password": "nope"}).status_code == 401
        assert c.post("/api/auth/login", headers=H,
                      json={"username": "nobody", "password": "s3cret!"}).status_code == 401


def test_a_guest_sees_only_their_model(world):
    with guest() as c:
        me = c.get("/api/auth/me").json()
        assert me["canManage"] is False
        assert me["models"] == [world["mia"]]
        assert [m["id"] for m in c.get("/api/models").json()] == [world["mia"]]


def test_a_guest_can_do_everything_on_their_model(world):
    with guest() as c:
        # reads and actions on their own model are allowed (studio not connected here, so the
        # create is refused for that reason — a 424/400, never a 403)
        assert c.get(f"/api/m/{world['mia']}/studio/jobs").status_code == 200
        assert c.get(f"/api/m/{world['mia']}/library").status_code == 200
        made = c.post(f"/api/m/{world['mia']}/studio/jobs", headers=H, json={"mode": "text", "prompt": "hi"})
        assert made.status_code != 403


def test_a_guest_cannot_touch_another_model_or_owner_things(world):
    with guest() as c:
        assert c.get(f"/api/m/{world['mike']}/studio/jobs").status_code == 403
        assert c.get(f"/api/m/{world['mike']}/library").status_code == 403
        assert c.post("/api/models", json={"name": "nope"}, headers=H).status_code == 403
        assert c.get("/api/settings").status_code == 403
        assert c.put("/api/sharing", json={"enabled": False, "host": SHARE}, headers=H).status_code == 403
        assert c.post("/api/auth/users", headers=H,
                      json={"username": "mallory", "password": "x123456"}).status_code == 403


def test_logging_out_ends_access(world):
    c = guest()
    assert c.post("/api/auth/logout", headers=H).status_code == 200
    assert c.get("/api/auth/me").status_code == 401
    assert c.get(f"/api/m/{world['mia']}/studio/jobs").status_code == 401
    c.close()


def test_owner_can_change_access_and_reset_passwords(world, owner):
    uid = world["guest"]["id"]
    owner.put(f"/api/auth/users/{uid}/models", headers=H, json={"models": []})
    with guest() as c:
        assert c.get("/api/models").json() == []
        assert c.get(f"/api/m/{world['mia']}/studio/jobs").status_code == 403
    # give it back, then reset the password (which forces a fresh login)
    owner.put(f"/api/auth/users/{uid}/models", headers=H, json={"models": [world["mia"]]})
    owner.put(f"/api/auth/users/{uid}/password", headers=H, json={"password": "brandnew1"})
    with TestClient(app, base_url=f"https://{SHARE}") as c:
        assert c.post("/api/auth/login", headers=H,
                      json={"username": "ben", "password": "s3cret!"}).status_code == 401
        assert c.post("/api/auth/login", headers=H,
                      json={"username": "ben", "password": "brandnew1"}).status_code == 200


def test_sharing_rejects_a_nonsense_address(owner):
    assert owner.put("/api/sharing", json={"enabled": True, "host": "not a host"}, headers=H).status_code == 400
    assert owner.put("/api/sharing", json={"enabled": True, "host": ""}, headers=H).status_code == 400
    # a pasted full URL is tolerated and reduced to the host
    ok = owner.put("/api/sharing", json={"enabled": True, "host": "https://ultimate.example.com/"}, headers=H)
    assert ok.status_code == 200 and ok.json()["host"] == "ultimate.example.com"
