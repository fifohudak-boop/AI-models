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
        bad = dict(s, min_score=500)
        assert c.put("/api/settings", json=bad, headers=H).status_code == 422


def test_old_settings_are_migrated(tmp_path, monkeypatch):
    import json

    from reelfinder import config

    old = {"description": "drift", "strictness": 70, "max_duration": 90, "target_count": 20,
           "platforms": ["tiktok"], "model": "qwen3-vl:8b-instruct"}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(old))
    monkeypatch.setattr(config, "SETTINGS_FILE", path)
    s = config.load_settings()
    assert s.settings_version == 2 and s.min_score == 0  # no more rejecting everything under 70
    assert s.max_duration == 180 and s.description == "drift" and s.model == "qwen3-vl:8b-instruct"
    assert "strictness" not in s.model_dump()
    assert config.pool_size_for(s) == 80 and config.pool_size_for(s.model_copy(update={"pool_size": 160})) == 160


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
        assert st["logins"] == {"tiktok": False, "instagram": False, "pinterest": False}
        assert st["hunting"] is False


def test_start_rejects_bad_settings(tmp_path):
    with client() as c:
        s = c.get("/api/settings").json()
        s.update(description="", keywords="", output_dir=str(tmp_path))
        r = c.post("/api/hunt/start", json={"settings": s}, headers=H)
        assert r.status_code == 400 and "reference video" in r.json()["detail"]


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
        {"name": "_auth", "value": "1", "domain": ".pinterest.com", "path": "/", "expires": far},
    ]
    path = tmp_path / "cookies.txt"
    assert write_netscape_cookies(cookies, path) == 3  # other sites never leave the browser
    jar = YoutubeDLCookieJar(str(path))
    jar.load()
    names = {(c.domain, c.name) for c in jar}
    assert names == {(".instagram.com", "sessionid"), ("www.tiktok.com", "tt_csrf"), (".pinterest.com", "_auth")}
    assert logins_from_cookies(cookies) == {"tiktok": False, "instagram": True, "pinterest": True}
    logged_out = [dict(cookies[-1], value="0")]
    assert logins_from_cookies(logged_out)["pinterest"] is False


def test_login_state_from_chrome_profile(tmp_path):
    db = tmp_path / "Default" / "Network" / "Cookies"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER, encrypted_value BLOB)")
    future = int((time.time() + 11644473600 + 86400) * 1_000_000)
    past = int((time.time() + 11644473600 - 86400) * 1_000_000)
    con.execute("INSERT INTO cookies VALUES ('.tiktok.com', 'sessionid', ?, x'00')", (future,))
    con.execute("INSERT INTO cookies VALUES ('.instagram.com', 'sessionid', ?, x'00')", (past,))
    con.execute("INSERT INTO cookies VALUES ('.pinterest.com', '_auth', ?, x'00')", (future,))
    con.execute("INSERT INTO cookies VALUES ('.pinterest.com', 'sessionid', ?, x'00')", (future,))
    con.commit()
    con.close()
    assert logins_from_profile(tmp_path) == {"tiktok": True, "instagram": False, "pinterest": True}
    assert logins_from_profile(tmp_path / "missing") == {"tiktok": False, "instagram": False, "pinterest": False}


def test_save_a_link(tmp_path):
    import functools
    import http.server
    import subprocess
    import threading

    from reelfinder import main
    from reelfinder.downloader import find_ffmpeg

    ffmpeg = find_ffmpeg()
    subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=25:duration=2",
                    "-c:v", "libx265", "-tag:v", "hev1", str(tmp_path / "mine.mp4")], check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path))
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    out = tmp_path / "videos"
    try:
        with client() as c, c.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:8765"}) as ws:
            main.state.settings = main.state.settings.model_copy(update={"output_dir": str(out)})
            assert c.post("/api/save-link", json={"url": "not a link"}, headers=H).status_code == 400
            url = f"http://127.0.0.1:{server.server_address[1]}/mine.mp4"
            assert c.post("/api/save-link", json={"url": url}, headers=H).status_code == 200
            done = None
            for _ in range(50):
                e = ws.receive_json()
                if e["type"] == "link" and e["data"]["status"] != "working":
                    done = e["data"]
                    break
    finally:
        server.shutdown()
    assert done["status"] == "done", done
    assert "H264" in done["summary"]  # an HEVC file came in, a playable H.264 MP4 went out
    saved = list((out / "Saved links").glob("*.mp4"))
    assert len(saved) == 1


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


def test_reference_upload_analyse_and_remove(tmp_path):
    import subprocess

    from reelfinder import main
    from reelfinder.downloader import find_ffmpeg
    from reelfinder.references import MAX_REFERENCES

    clip = tmp_path / "ref.mp4"
    subprocess.run([find_ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=25:duration=3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True)
    with client() as c:
        for ref in c.get("/api/references").json():  # start clean
            c.delete(f"/api/references/{ref['id']}", headers=H)
        r = c.post("/api/references/upload?name=my%20clip.mp4", content=clip.read_bytes(),
                   headers={**H, "Content-Type": "video/mp4"})
        assert r.status_code == 200 and r.json()["status"] == "analyzing" and r.json()["name"] == "my clip.mp4"
        ref_id = r.json()["id"]
        for _ in range(240):
            ref = next(x for x in c.get("/api/references").json() if x["id"] == ref_id)
            if ref["status"] != "analyzing":
                break
            time.sleep(0.25)
        assert ref["status"] == "ready", ref
        assert ref["frames"] == 8 and c.get(f"/references/{ref_id}/frame/1.jpg").content[:2] == b"\xff\xd8"
        assert c.get(f"/references/{ref_id}/frame/9.jpg").status_code == 404
        assert c.get("/references/not-an-id/frame/1.jpg").status_code == 404
        assert c.post("/api/references/upload", content=b"", headers=H).status_code == 400
        assert c.post("/api/references/link", json={"url": "nope"}, headers=H).status_code == 400
        assert "Similarity model" in c.get("/api/report").text and "my clip.mp4" in c.get("/api/report").text

        for i in range(MAX_REFERENCES - 1):
            main.state.references.create("link", f"x{i}", url="https://example.com/x")
        r = c.post("/api/references/link", json={"url": "https://www.tiktok.com/@a/video/1"}, headers=H)
        assert r.status_code == 409 and "up to" in r.json()["detail"]

        for ref in c.get("/api/references").json():
            assert c.delete(f"/api/references/{ref['id']}", headers=H).json() == {"ok": True}
        assert c.get("/api/references").json() == []
        assert c.delete(f"/api/references/{ref_id}", headers=H).status_code == 404
