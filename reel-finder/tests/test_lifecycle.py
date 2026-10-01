"""Reel Finder must quit promptly (even with the page open) and recover from a crashed run."""

import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import websockets

from reelfinder.browser import BrowserManager

ROOT = Path(__file__).resolve().parent.parent
if not os.environ.get("REELFINDER_BROWSER_PATH") and Path("/opt/pw-browsers/chromium").exists():
    os.environ["REELFINDER_BROWSER_PATH"] = "/opt/pw-browsers/chromium"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
def test_quits_with_page_open(tmp_path, sig):
    port = free_port()
    env = dict(os.environ, REELFINDER_DATA=str(tmp_path))
    proc = subprocess.Popen([sys.executable, "-m", "reelfinder", "--no-browser", "--port", str(port)],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.2)

        async def hold_page_open_then_quit():
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws", origin=f"http://127.0.0.1:{port}") as ws:
                assert '"snapshot"' in await ws.recv()
                proc.send_signal(sig)
                await asyncio.sleep(0.2)

        asyncio.run(hold_page_open_then_quit())
        assert proc.wait(timeout=10) is not None
    finally:
        if proc.poll() is None:
            proc.kill()
            pytest.fail("Reel Finder didn't quit")


def test_recovers_profile_from_a_crashed_run(tmp_path):
    async def go():
        crashed = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "c.txt")
        try:
            await crashed.get_context(headless=True)
        except RuntimeError as exc:
            pytest.skip(f"no browser available: {exc}")
        # A second launch on the same profile would normally fail with "profile already in use".
        fresh = BrowserManager(profile_dir=tmp_path / "profile", cookies_file=tmp_path / "c.txt")
        ctx = await fresh.get_context(headless=True)
        page = await ctx.new_page()
        await page.goto("about:blank")
        await fresh.close()
        try:
            await crashed.close()
        except Exception:
            pass

    asyncio.run(go())
