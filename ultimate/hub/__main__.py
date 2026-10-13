"""Run with: python -m hub  (start.command does this for you)."""

from __future__ import annotations

import argparse
import logging
import socket
import threading
import webbrowser
from logging.handlers import RotatingFileHandler

import uvicorn

from .config import HOST, LOG_DIR, LOG_FILE, PORT
from .reels.logs import setup_logging as setup_reels_logging


def _port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        return sock.connect_ex((HOST, port)) == 0


def setup_logging() -> None:
    setup_reels_logging()  # Reel Finder's own log (hunts, agents, downloads)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger = logging.getLogger("ultimate")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fifofarm Ultimate")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--no-browser", action="store_true", help="don't open the page automatically")
    args = parser.parse_args()

    url = f"http://{HOST}:{args.port}"
    if _port_in_use(args.port):
        print(f"Fifofarm Ultimate is already running — opening {url}")
        webbrowser.open(url)
        return

    setup_logging()
    print(f"\n  🌱  Fifofarm Ultimate is running at {url}\n"
          "      Keep this window open while you use it. Press Ctrl+C to quit.\n")
    if not args.no_browser:
        threading.Timer(1.5, webbrowser.open, args=(url,)).start()
    uvicorn.run("hub.main:app", host=HOST, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
