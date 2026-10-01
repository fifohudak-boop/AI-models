"""Run with: python -m reelfinder  (start.command does this for you)."""

from __future__ import annotations

import argparse
import logging
import socket
import threading
import webbrowser

import uvicorn

from .config import HOST, PORT


def _port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        return sock.connect_ex((HOST, port)) == 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Reel Finder")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true", help="don't open the page automatically")
    args = parser.parse_args()

    url = f"http://{HOST}:{args.port}"
    if _port_in_use(args.port):
        print(f"Reel Finder is already running — opening {url}")
        webbrowser.open(url)
        return

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    print(f"\n  🎬  Reel Finder is running at {url}\n      Keep this window open while you use it. Press Ctrl+C to quit.\n")
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    uvicorn.run("reelfinder.main:app", host=HOST, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
