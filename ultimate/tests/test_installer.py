"""The one-line installer, the auto-updater and start.command, run for real against local tarballs."""

import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SHA_A, SHA_B = "a" * 40, "b" * 40
# ULTIMATE_TEST_BASH=/path/to/bash-3.2 runs these with the bash macOS ships.
BASH = os.environ.get("ULTIMATE_TEST_BASH", "bash")
SKIP = {".venv", "data", "__pycache__", ".pytest_cache", "node_modules"}


def make_tarball(tmp: Path, name: str, extra: str) -> Path:
    """A GitHub-style archive: <repo>-<ref>/ultimate/… (next to the other apps) with one marker file."""
    top = tmp / f"build-{name}" / f"AI-models-{name}"
    shutil.copytree(ROOT, top / "ultimate", ignore=lambda d, names: [n for n in names if n in SKIP], symlinks=True)
    (top / "ultimate" / extra).write_text(name)
    (top / "reel-finder").mkdir()
    (top / "reel-finder" / "start.command").write_text("# not this one\n")
    out = tmp / f"{name}.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        tar.add(top, arcname=top.name)
    return out


def run(script: Path, env: dict, **kw) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, str(script)], env={**os.environ, **env}, capture_output=True, text=True, errors="replace",
                          timeout=120, **kw)


@pytest.fixture
def setup(tmp_path):
    home = tmp_path / "home"
    (home / "Desktop").mkdir(parents=True)
    install_dir = home / "Applications" / "Fifofarm Ultimate"  # a space in the path, like the real one
    env = {"HOME": str(home), "ULTIMATE_HOME": str(install_dir), "ULTIMATE_NO_LAUNCH": "1"}
    return tmp_path, home, install_dir, env


def test_install_then_update_keeps_your_data(setup):
    tmp, home, install_dir, env = setup
    tar_a = make_tarball(tmp, "a", "only_in_a.txt")
    tar_b = make_tarball(tmp, "b", "only_in_b.txt")

    first = run(ROOT / "install.sh", {**env, "ULTIMATE_TARBALL": str(tar_a), "ULTIMATE_SHA": SHA_A})
    assert first.returncode == 0, first.stderr
    assert (install_dir / "only_in_a.txt").exists()
    assert os.access(install_dir / "start.command", os.X_OK)
    assert (install_dir / "hub" / "main.py").exists() and (install_dir / "hub" / "reels" / "hunt.py").exists()
    assert (install_dir / "web" / "index.html").exists()
    assert not (install_dir / "web-src").exists() and not (install_dir / "tests").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_A
    assert (install_dir / ".installed_ref").read_text().strip() == "main"

    app = home / "Applications" / "Fifofarm Ultimate.app"
    launcher = app / "Contents" / "MacOS" / "fifofarm-ultimate"
    assert os.access(launcher, os.X_OK)
    plist = (app / "Contents" / "Info.plist").read_text()
    assert "<string>fifofarm-ultimate</string>" in plist and "<string>Fifofarm Ultimate</string>" in plist
    assert "open -a Terminal" in launcher.read_text()
    assert subprocess.run(["bash", "-n", str(launcher)]).returncode == 0
    assert (home / "Desktop" / "Fifofarm Ultimate.app").resolve() == app.resolve()
    assert (app / "Contents" / "Resources" / "AppIcon.icns").read_bytes()[:4] == b"icns"
    # The other apps are never installed or touched by this installer.
    assert not (home / "Applications" / "Reel Finder").exists()
    assert not (home / "Applications" / "Reel Finder.app").exists()

    # Your models, settings, logins and Python setup must survive an update.
    (install_dir / "data").mkdir()
    (install_dir / "data" / "ultimate.db").write_text("keep me")
    (install_dir / ".venv").mkdir()
    (install_dir / ".venv" / "marker").write_text("venv")

    second = run(ROOT / "install.sh", {**env, "ULTIMATE_TARBALL": str(tar_b), "ULTIMATE_SHA": SHA_B})
    assert second.returncode == 0, second.stderr
    assert (install_dir / "data" / "ultimate.db").read_text() == "keep me"
    assert (install_dir / ".venv" / "marker").read_text() == "venv"
    assert (install_dir / "only_in_b.txt").exists() and not (install_dir / "only_in_a.txt").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_B
    leftovers = [p.name for p in install_dir.parent.iterdir() if ".new." in p.name or ".old." in p.name]
    assert leftovers == []


def test_bad_download_fails_cleanly(setup):
    tmp, _home, install_dir, env = setup
    junk = tmp / "junk.tar.gz"
    junk.write_bytes(b"not a tarball")
    result = run(ROOT / "install.sh", {**env, "ULTIMATE_TARBALL": str(junk), "ULTIMATE_SHA": SHA_A})
    assert result.returncode != 0 and "damaged" in result.stderr
    assert not install_dir.exists()


@pytest.fixture()
def api(tmp_path):
    """A stand-in for GitHub's "commits that changed ultimate/" API (a list, newest first)."""
    state = {"sha": SHA_A, "asked": ""}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802
            state["asked"] = self.path
            body = json.dumps([{"sha": state["sha"], "commit": {"tree": {"sha": "c" * 40}}}], indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield state, f"http://127.0.0.1:{server.server_address[1]}/repos/x/commits?sha=main&path=ultimate&per_page=1"
    server.shutdown()


def test_auto_update(setup, api):
    tmp, _home, install_dir, env = setup
    state, url = api
    tar_a = make_tarball(tmp, "a", "only_in_a.txt")
    tar_b = make_tarball(tmp, "b", "only_in_b.txt")
    assert run(ROOT / "install.sh", {**env, "ULTIMATE_TARBALL": str(tar_a), "ULTIMATE_SHA": SHA_A}).returncode == 0
    (install_dir / "data").mkdir()
    (install_dir / "data" / "settings.json").write_text("{}")
    updater = install_dir / "update.sh"

    same = run(updater, {**env, "ULTIMATE_API": url})
    assert same.returncode == 0 and (install_dir / "only_in_a.txt").exists()
    assert "path=ultimate" in state["asked"]

    state["sha"] = SHA_B
    newer = run(updater, {**env, "ULTIMATE_API": url, "ULTIMATE_TARBALL": str(tar_b)})
    assert newer.returncode == 10, newer.stdout + newer.stderr  # "updated — restart me"
    assert (install_dir / "only_in_b.txt").exists() and (install_dir / "data" / "settings.json").exists()
    assert (install_dir / ".installed_commit").read_text().strip() == SHA_B

    offline = run(install_dir / "update.sh", {**env, "ULTIMATE_API": "http://127.0.0.1:9/nothing"})
    assert offline.returncode == 0  # offline or GitHub busy: just start the current version


def test_developer_checkout_never_self_updates():
    # The repo copy has no .installed_commit, so update.sh must do nothing.
    assert not (ROOT / ".installed_commit").exists()
    result = run(ROOT / "update.sh", {"ULTIMATE_API": "http://127.0.0.1:9/nothing"})
    assert result.returncode == 0 and result.stdout == ""


def test_no_variable_runs_into_non_ascii_text():
    # "$name…" breaks macOS's bash 3.2 ("name…: unbound variable"); write "${name}…" instead.
    pattern = re.compile(rb"\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]")
    offenders = []
    for script in ("install.sh", "update.sh", "start.command"):
        for n, line in enumerate((ROOT / script).read_bytes().splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{script}:{n}")
    assert offenders == []


# ---------------------------------------------------------------- start.command with the app already open

FAKE_SERVER = """
import http.server, json, sys
busy = sys.argv[2] == "1"
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        data = {"busy": busy, "reasons": ["a Reel Finder hunt is running"] if busy else []} if self.path == "/api/busy" else {"ok": True}
        body = json.dumps(data).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def open_copy(tmp_path):
    """An installed copy that's already running (a separate process on its own port)."""
    if not shutil.which("lsof"):
        pytest.skip("needs lsof")
    app = tmp_path / "Fifofarm Ultimate"
    app.mkdir()
    shutil.copy(ROOT / "start.command", app / "start.command")
    (app / ".installed_commit").write_text(SHA_A)
    home = tmp_path / "home"
    stubs = home / ".local" / "bin"  # first on start.command's PATH
    stubs.mkdir(parents=True)

    def stub(path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    real_curl = shutil.which("curl")
    stub(stubs / "curl", f'case "$*" in *127.0.0.1*) exec {real_curl} "$@";; *) exit 1;; esac')  # no internet
    stub(stubs / "uv", "exit 0")
    stub(stubs / "open", 'echo "OPENED $*"')
    stub(stubs / "ollama", "exit 0")
    stub(app / ".venv" / "bin" / "python", 'echo "PYTHON $*"')
    procs = []

    def start(busy=False, update_exit=10):
        stub(app / "update.sh", f"echo UPDATE-CHECKED; exit {update_exit}")
        port = _free_port()
        server = subprocess.Popen([sys.executable, "-c", FAKE_SERVER, str(port), "1" if busy else "0"])
        procs.append(server)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        result = subprocess.run([BASH, str(app / "start.command")], capture_output=True, text=True, timeout=60,
                                stdin=subprocess.DEVNULL,
                                env={**os.environ, "HOME": str(home), "ULTIMATE_PORT": str(port)})
        return result, server

    yield start
    for p in procs:
        p.kill()


def test_reopening_the_app_installs_an_update_and_restarts(open_copy):
    result, server = open_copy()
    out = result.stdout
    assert "UPDATE-CHECKED" in out and "Restarting Fifofarm Ultimate with the new version" in out, out + result.stderr
    assert server.wait(timeout=10) is not None  # the old copy was closed…
    assert "PYTHON -m hub" in out.splitlines()[-1]  # …and the new one started


def test_reopening_while_busy_never_interrupts_it(open_copy):
    result, server = open_copy(busy=True)
    assert "UPDATE-CHECKED" not in result.stdout and "OPENED http://127.0.0.1" in result.stdout
    assert server.poll() is None  # still running


def test_reopening_without_an_update_just_shows_the_page(open_copy):
    result, server = open_copy(update_exit=0)
    assert "UPDATE-CHECKED" in result.stdout and "OPENED http://127.0.0.1" in result.stdout
    assert "Restarting" not in result.stdout and server.poll() is None


def test_updates_give_an_existing_app_its_icon_but_never_add_shortcuts(setup):
    tmp, home, install_dir, env = setup
    tar_a = make_tarball(tmp, "a", "only_in_a.txt")
    quiet = {**env, "ULTIMATE_TARBALL": str(tar_a), "ULTIMATE_SHA": SHA_A, "ULTIMATE_NO_SHORTCUTS": "1"}
    app = home / "Applications" / "Fifofarm Ultimate.app"

    assert run(ROOT / "install.sh", quiet).returncode == 0
    assert not app.exists()  # an update never creates an app you didn't have

    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "Info.plist").write_text("<plist>old</plist>")
    assert run(ROOT / "install.sh", quiet).returncode == 0
    assert (app / "Contents" / "Resources" / "AppIcon.icns").read_bytes()[:4] == b"icns"
    assert "CFBundleIconFile" in (app / "Contents" / "Info.plist").read_text()
    assert not (home / "Desktop" / "Fifofarm Ultimate.app").exists()  # you removed it? it stays removed
