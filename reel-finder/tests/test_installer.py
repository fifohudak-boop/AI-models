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
# REELFINDER_TEST_BASH=/path/to/bash-3.2 runs these with the bash macOS ships.
BASH = os.environ.get("REELFINDER_TEST_BASH", "bash")
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
    return subprocess.run([BASH, str(script)], env={**os.environ, **env}, capture_output=True, text=True, errors="replace",
                          timeout=120, **kw)


def _mac_like_locale(tmp: Path) -> dict | None:
    """A Latin-1 locale: like macOS's bash 3.2, it treats the bytes of “…” as letters in names."""
    if not shutil.which("localedef") or not Path("/usr/share/i18n/locales/en_US").exists():
        return None
    out = tmp / "locale"
    out.mkdir(exist_ok=True)
    made = subprocess.run(["localedef", "-i", "en_US", "-f", "ISO-8859-1", str(out / "en_US.ISO-8859-1")],
                          capture_output=True)
    if not (out / "en_US.ISO-8859-1").exists() and made.returncode != 0:
        return None
    return {"LOCPATH": str(out), "LC_ALL": "en_US.ISO-8859-1"}


@pytest.fixture(params=["default", "mac-like"])
def setup(tmp_path, request):
    home = tmp_path / "home"
    (home / "Desktop").mkdir(parents=True)
    install_dir = home / "Applications" / "Reel Finder"  # a space in the path, like the real one
    env = {"HOME": str(home), "REELFINDER_HOME": str(install_dir), "REELFINDER_NO_LAUNCH": "1"}
    if request.param == "mac-like":
        locale_env = _mac_like_locale(tmp_path)
        if locale_env is None:
            pytest.skip("can't build a Latin-1 locale here")
        env.update(locale_env)
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


def test_no_variable_runs_into_non_ascii_text():
    # "$name…" breaks macOS's bash 3.2 ("name…: unbound variable"); write "${name}…" instead.
    import re

    pattern = re.compile(rb"\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]")
    offenders = []
    for script in ("install.sh", "update.sh", "start.command"):
        for n, line in enumerate((ROOT / script).read_bytes().splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{script}:{n}")
    assert offenders == []
