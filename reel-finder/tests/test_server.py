import sqlite3
import time

from fastapi.testclient import TestClient
from yt_dlp.cookies import YoutubeDLCookieJar

from reelfinder.browser import logins_from_cookies, logins_from_profile, write_netscape_cookies
from reelfinder.main import app

H = {"X-Reel-Finder": "1"}


def client():
    return TestClient(app, base_url="http://127.0.0.1:8765")


def test_page_and_settings_roundtrip(tmp_path):
    with client() as c:
        assert "Reel Finder" in c.get("/").text
        assert c.get("/app.js").status_code == 200
        s = c.get("/api/settings").json()
        assert s["platforms"] == ["tiktok", "instagram"] and s["target_count"] == 20
        s.update(description="night drift", target_count=7, output_dir=str(tmp_path))
        assert c.put("/api/settings", json=s, headers=H).json()["target_count"] == 7
        assert c.get("/api/settings").json()["description"] == "night drift"
        bad = dict(s, strictness=500)
        assert c.put("/api/settings", json=bad, headers=H).status_code == 422


def test_local_only_guards():
    with client() as c:
        assert c.put("/api/settings", json={}).status_code == 403  # no X-Reel-Finder header
        assert c.post("/api/hunt/stop").status_code == 403
        evil = TestClient(app, base_url="http://evil.example")
        assert evil.get("/api/settings").status_code == 403  # DNS-rebinding guard


def test_status_without_ollama():
    with client() as c:
        st = c.get("/api/status").json()
        assert set(st) >= {"ollama", "ffmpeg", "logins", "hunting"}
        assert st["logins"] == {"tiktok": False, "instagram": False}
        assert st["hunting"] is False


def test_start_rejects_bad_settings(tmp_path):
    with client() as c:
        s = c.get("/api/settings").json()
        s.update(description="", keywords="", output_dir=str(tmp_path))
        r = c.post("/api/hunt/start", json={"settings": s}, headers=H)
        assert r.status_code == 400 and "Describe" in r.json()["detail"]


def test_websocket_sends_snapshot():
    with client() as c, c.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:8765"}) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_cookie_export_is_readable_by_yt_dlp(tmp_path):
    far = time.time() + 86400
    cookies = [
        {"name": "sessionid", "value": "abc", "domain": ".instagram.com", "path": "/", "expires": far,
         "httpOnly": True, "secure": True},
        {"name": "tt_csrf", "value": "x", "domain": "www.tiktok.com", "path": "/", "expires": -1,
         "httpOnly": False, "secure": True},
        {"name": "private", "value": "nope", "domain": ".mybank.com", "path": "/", "expires": far},
    ]
    path = tmp_path / "cookies.txt"
    assert write_netscape_cookies(cookies, path) == 2  # other sites never leave the browser
    jar = YoutubeDLCookieJar(str(path))
    jar.load()
    names = {(c.domain, c.name) for c in jar}
    assert names == {(".instagram.com", "sessionid"), ("www.tiktok.com", "tt_csrf")}
    assert logins_from_cookies(cookies) == {"tiktok": False, "instagram": True}


def test_login_state_from_chrome_profile(tmp_path):
    db = tmp_path / "Default" / "Network" / "Cookies"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER, encrypted_value BLOB)")
    future = int((time.time() + 11644473600 + 86400) * 1_000_000)
    past = int((time.time() + 11644473600 - 86400) * 1_000_000)
    con.execute("INSERT INTO cookies VALUES ('.tiktok.com', 'sessionid', ?, x'00')", (future,))
    con.execute("INSERT INTO cookies VALUES ('.instagram.com', 'sessionid', ?, x'00')", (past,))
    con.commit()
    con.close()
    assert logins_from_profile(tmp_path) == {"tiktok": True, "instagram": False}
    assert logins_from_profile(tmp_path / "missing") == {"tiktok": False, "instagram": False}


def test_report_has_diagnostics_and_no_secrets(tmp_path):
    import logging

    from reelfinder.config import LOG_FILE
    from reelfinder.logs import setup_logging

    setup_logging(LOG_FILE, console=False)
    logging.getLogger("reelfinder").warning("marker line for the report test")
    with client() as c:
        text = c.get("/api/report").text
    assert "Reel Finder report" in text and "yt-dlp:" in text and "Playwright:" in text
    assert "TikTok self-test: not run yet" in text
    assert "marker line for the report test" in text
    assert "sessionid" not in text


def test_selftest_endpoint_guards():
    from reelfinder import main

    with client() as c:
        assert c.post("/api/selftest/youtube", headers=H).status_code == 404

        class Busy:
            running = True

        main.state.hunt = Busy()
        try:
            r = c.post("/api/selftest/tiktok", headers=H)
            assert r.status_code == 409 and "hunt" in r.json()["detail"]
        finally:
            main.state.hunt = None
