"""A log file you can share when something breaks, and the version info that goes with it."""

from __future__ import annotations

import logging
import platform
import sys
from collections import deque
from importlib.metadata import PackageNotFoundError, version
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import __version__
from .config import LOG_FILE

FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def setup_logging(log_file: Path = LOG_FILE, console: bool = True) -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter(FORMAT, datefmt="%Y-%m-%d %H:%M:%S"))
    root.addHandler(file_handler)
    if console:
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))
        root.addHandler(stream)
    for noisy in ("httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    logging.getLogger("reelfinder").info(
        "Reel Finder started — %s", ", ".join(f"{k}: {v}" for k, v in diagnostics().items())
    )


def tail(lines: int = 300, log_file: Path = LOG_FILE) -> str:
    try:
        with log_file.open(encoding="utf-8", errors="replace") as fh:
            return "".join(deque(fh, maxlen=lines))
    except OSError:
        return "(no log file yet)\n"


def _version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "not installed"


def _os_name() -> str:
    if sys.platform == "darwin":
        mac = platform.mac_ver()[0]
        return f"macOS {mac} ({platform.machine()})" if mac else f"macOS ({platform.machine()})"
    return f"{platform.system()} {platform.release()} ({platform.machine()})"


def diagnostics(browser_name: str | None = None) -> dict[str, str]:
    from .downloader import find_ffmpeg  # avoid a circular import at module load

    info = {
        "Reel Finder": __version__,
        "System": _os_name(),
        "Python": platform.python_version(),
        "yt-dlp": _version("yt-dlp"),
        "curl-cffi": _version("curl_cffi"),
        "Playwright": _version("playwright"),
        "ffmpeg": find_ffmpeg() or "not found",
    }
    if browser_name:
        info["Agents' browser"] = browser_name
    return info


class _YtDlpLogger:
    """yt-dlp's warnings and errors go into our log (they explain most download problems)."""

    def __init__(self) -> None:
        self.log = logging.getLogger("reelfinder.ytdlp")

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        self.log.warning(msg)

    def error(self, msg: str) -> None:
        self.log.error(msg)


def ytdlp_logger() -> _YtDlpLogger:
    return _YtDlpLogger()
