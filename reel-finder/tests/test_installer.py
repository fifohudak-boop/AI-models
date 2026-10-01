"""The one-line installer and the auto-updater, run for real against local tarballs."""

import http.server
import json
import os
import shutil
import subprocess
import tarfile
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SHA_A, SHA_B = "a" * 40, "b" * 40
SKIP = {".venv", "data", "__pycache__", ".pytest_cache"}


def make_tarball(tmp: Path, name: str, extra: str) -> Path:
    """A GitHub-style archive: <repo>-<ref>/reel-finder/… with one marker file."""
    top = tmp / f"build-{name}" / f"AI-models-{name}"
    shutil.copytree(ROOT, top / "reel-finder", ignore=lambda d, names: [n for n in names if n in SKIP])
    (top / "reel-finder" / extra).write_text(name)
    out = tmp / f"{name}.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        tar.add(top, arcname=top.name)
    return out


def run(script: Path, env: dict, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(script)], env={**os.environ, **env}, capture_output=True, text=True,
                          timeout=120, **kw)


@pytest.fixture()
def setup(tmp_path):
    home = tmp_path / "home"
    (home / "Desktop").mkdir(parents=True)
    install_dir = home / "Applications" / "Reel Finder"  # a space in the path, like the real one
    env = {"HOME": str(home), "REELFINDER_HOME": str(install_dir), "REELFINDER_NO_LAUNCH": "1"}
    return tmp_path, home, install_dir, env


def test_install_then_update_keeps_your_data(setup):
    tmp, home, install_dir, env = setup
    tar_a = make_tarball(tmp, "a", "only_in_a.txt")
    tar_b = make_tarball(tmp, "b", "only_in_b.txt")

    first = run(ROOT / "install.sh", {**env, "REELFINDER_TARBALL": str(tar_a), "REELFINDER_SHA": SHA_A})
    assert first.returncode == 0, first.stderr
    assert (install_dir / "only_in_a.txt").exists()
    assert os.access(install_dir / "start.command", os.X_OK)
    assert (install_dir / "reelfinder" / "hunt.py").exists() and (install_dir / "web" / "index.html").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_A
    assert (install_dir / ".installed_ref").read_text().strip() == "main"

    app = home / "Applications" / "Reel Finder.app"
    launcher = app / "Contents" / "MacOS" / "reel-finder"
    assert os.access(launcher, os.X_OK)
    assert "<string>reel-finder</string>" in (app / "Contents" / "Info.plist").read_text()
    assert "open -a Terminal" in launcher.read_text()
    assert subprocess.run(["bash", "-n", str(launcher)]).returncode == 0
    assert (home / "Desktop" / "Reel Finder.app").resolve() == app.resolve()

    # Your settings, logins and Python setup must survive an update.
    (install_dir / "data").mkdir()
    (install_dir / "data" / "settings.json").write_text('{"description": "keep me"}')
    (install_dir / ".venv").mkdir()
    (install_dir / ".venv" / "marker").write_text("venv")

    second = run(ROOT / "install.sh", {**env, "REELFINDER_TARBALL": str(tar_b), "REELFINDER_SHA": SHA_B})
    assert second.returncode == 0, second.stderr
    assert (install_dir / "data" / "settings.json").read_text() == '{"description": "keep me"}'
    assert (install_dir / ".venv" / "marker").read_text() == "venv"
    assert (install_dir / "only_in_b.txt").exists() and not (install_dir / "only_in_a.txt").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_B
    leftovers = [p.name for p in install_dir.parent.iterdir() if ".new." in p.name or ".old." in p.name]
    assert leftovers == []


def test_bad_download_fails_cleanly(setup):
    tmp, _home, install_dir, env = setup
    junk = tmp / "junk.tar.gz"
    junk.write_bytes(b"not a tarball")
    result = run(ROOT / "install.sh", {**env, "REELFINDER_TARBALL": str(junk), "REELFINDER_SHA": SHA_A})
    assert result.returncode != 0 and "damaged" in result.stderr
    assert not install_dir.exists()


@pytest.fixture()
def api(tmp_path):
    """A stand-in for GitHub's 'latest commit' API."""
    state = {"sha": SHA_A}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802
            body = json.dumps({"sha": state["sha"], "commit": {"tree": {"sha": "c" * 40}}}, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield state, f"http://127.0.0.1:{server.server_address[1]}/commits/main"
    server.shutdown()


def test_auto_update(setup, api):
    tmp, _home, install_dir, env = setup
    state, url = api
    tar_a = make_tarball(tmp, "a", "only_in_a.txt")
    tar_b = make_tarball(tmp, "b", "only_in_b.txt")
    assert run(ROOT / "install.sh", {**env, "REELFINDER_TARBALL": str(tar_a), "REELFINDER_SHA": SHA_A}).returncode == 0
    (install_dir / "data").mkdir()
    (install_dir / "data" / "settings.json").write_text("{}")
    updater = install_dir / "update.sh"

    same = run(updater, {**env, "REELFINDER_API": url})
    assert same.returncode == 0 and (install_dir / "only_in_a.txt").exists()

    state["sha"] = SHA_B
    newer = run(updater, {**env, "REELFINDER_API": url, "REELFINDER_TARBALL": str(tar_b)})
    assert newer.returncode == 10, newer.stdout + newer.stderr  # "updated — restart me"
    assert (install_dir / "only_in_b.txt").exists() and (install_dir / "data" / "settings.json").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_B

    offline = run(install_dir / "update.sh", {**env, "REELFINDER_API": "http://127.0.0.1:9/nothing"})
    assert offline.returncode == 0  # offline or GitHub busy: just start the current version


def test_developer_checkout_never_self_updates():
    # The repo copy has no .installed_commit, so update.sh must do nothing.
    assert not (ROOT / ".installed_commit").exists()
    result = run(ROOT / "update.sh", {"REELFINDER_API": "http://127.0.0.1:9/nothing"})
    assert result.returncode == 0 and result.stdout == ""
