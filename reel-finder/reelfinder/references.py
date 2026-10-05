"""Reference videos: "find me more videos like this one".

Each reference is analysed once, when you add it:
- frames are taken from across the video (or the picture itself, for an image),
- the frames are embedded, so every video a hunt finds can be scored on how much it looks like them,
- the AI (when Ollama is running) describes what it sees and suggests searches,
- hashtags from its caption (for links) become search terms too.

Everything lives in data/references/<id>/ and survives restarts; the video itself is deleted once
the frames are taken.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field

from .config import DATA_DIR
from .downloader import NotAVideo
from .models import Candidate
from .similarity import ReferenceSet, Vision

log = logging.getLogger("reelfinder")

REF_DIR = DATA_DIR / "references"
MAX_REFERENCES = 5
FRAME_COUNT = 8
MAX_UPLOAD_BYTES = 2_000_000_000
_ID = re.compile(r"^[0-9a-f]{12}$")
_KEEP = re.compile(r"^(reference\.json|looks\.npy|frame_\d+\.jpg)$")
_HASHTAG = re.compile(r"#([^\s#.,!?;:]{2,40})")
_HOSTS = {"tiktok": "tiktok", "instagram": "instagram", "pinterest": "pinterest", "pin.it": "pinterest",
          "youtube": "youtube", "youtu.be": "youtube"}


class Reference(BaseModel):
    id: str
    source: Literal["file", "link"]
    name: str  # the file name, or the link
    url: str = ""
    kind: Literal["video", "image"] = "video"
    status: Literal["analyzing", "ready", "failed"] = "analyzing"
    step: str = ""  # what the analysis is doing right now
    error: str = ""
    note: str = ""  # a limitation worth knowing (e.g. no AI description)
    caption: str = ""
    author: str = ""
    platform: str = ""
    duration: float | None = None
    description: str = ""  # what the AI sees in it
    queries: list[str] = Field(default_factory=list)
    hashtags: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)  # themes recognised by the similarity model
    frames: int = 0
    looks: bool = False  # its frames are embedded, so found videos can be compared with it
    created: float = Field(default_factory=time.time)


@dataclass
class ReferenceInfo:
    """What a hunt needs from your reference videos."""

    looks: ReferenceSet = field(default_factory=ReferenceSet)
    descriptions: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    hashtags: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)  # links the references came from (never "found" again)
    count: int = 0

    def __bool__(self) -> bool:
        return self.count > 0

    @property
    def description(self) -> str:
        return " / ".join(d for d in self.descriptions if d)


def valid_id(ref_id: str) -> bool:
    return bool(_ID.match(ref_id or ""))


def platform_of(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for key, name in _HOSTS.items():
        if key in host:
            return name
    return "link"


def hashtags_in(caption: str) -> list[str]:
    seen: dict[str, str] = {}
    for tag in _HASHTAG.findall(caption or ""):
        seen.setdefault(tag.lower(), tag)
    return list(seen.values())


class ReferenceStore:
    def __init__(self, root: Path = REF_DIR):
        self.root = root
        self.lock = asyncio.Lock()  # one analysis at a time: they share the AI and the similarity model

    def folder(self, ref_id: str) -> Path:
        if not valid_id(ref_id):
            raise ValueError("bad reference id")
        return self.root / ref_id

    def frame_file(self, ref_id: str, n: int) -> Path:
        return self.folder(ref_id) / f"frame_{n}.jpg"

    def all(self) -> list[Reference]:
        refs = []
        if self.root.exists():
            for meta in self.root.glob("*/reference.json"):
                try:
                    refs.append(Reference.model_validate_json(meta.read_text()))
                except (OSError, ValueError):
                    continue
        return sorted(refs, key=lambda r: r.created)

    def get(self, ref_id: str) -> Reference | None:
        try:
            return Reference.model_validate_json((self.folder(ref_id) / "reference.json").read_text())
        except (OSError, ValueError):
            return None

    def create(self, source: str, name: str, url: str = "") -> Reference:
        ref = Reference(id=uuid.uuid4().hex[:12], source=source, name=name[:200], url=url,
                        platform=platform_of(url) if url else "")
        self.folder(ref.id).mkdir(parents=True, exist_ok=True)
        self.save(ref)
        return ref

    def save(self, ref: Reference) -> None:
        folder = self.folder(ref.id)
        if folder.exists():
            tmp = folder / "reference.json.tmp"
            tmp.write_text(ref.model_dump_json(indent=2))
            tmp.replace(folder / "reference.json")

    def delete(self, ref_id: str) -> bool:
        folder = self.folder(ref_id)
        if not folder.exists():
            return False
        shutil.rmtree(folder, ignore_errors=True)
        return True

    def ready(self) -> list[Reference]:
        return [r for r in self.all() if r.status == "ready"]

    def info(self) -> ReferenceInfo:
        """Everything the hunt uses from the references that are ready."""
        refs = self.ready()
        out = ReferenceInfo(count=len(refs))
        for ref in refs:
            if ref.looks:
                try:
                    import numpy as np

                    out.looks.frames.append(np.load(self.folder(ref.id) / "looks.npy"))
                except (OSError, ValueError, ImportError):
                    pass
            out.descriptions.append(ref.description or ref.caption[:200])
            out.queries += ref.queries + ref.tags
            out.hashtags += ref.hashtags
            if ref.url:
                out.urls.append(ref.url)
        out.queries = list(dict.fromkeys(q for q in out.queries if q))
        out.hashtags = list(dict.fromkeys(h for h in out.hashtags if h))
        return out


class Analyzer:
    """Turns a video file or link into a ready Reference."""

    def __init__(self, store: ReferenceStore, downloader: Any, vision: Vision,
                 brain_factory: Callable, model: Callable[[], str], emit: Callable[[str, dict], None]):
        self.store = store
        self.downloader = downloader
        self.vision = vision
        self.brain_factory = brain_factory
        self.model = model
        self.emit = emit

    def _update(self, ref: Reference, **changes: Any) -> None:
        for key, value in changes.items():
            setattr(ref, key, value)
        if self.store.folder(ref.id).exists():  # not removed while it was being analysed
            self.store.save(ref)
            self.emit("reference", ref.model_dump())

    async def run(self, ref: Reference, file: Path | None = None) -> Reference:
        async with self.store.lock:
            try:
                await self._run(ref, file)
            except Exception as exc:  # noqa: BLE001 - tell the user, never crash the app
                log.warning("Couldn't analyse reference %s: %s", ref.name, exc)
                message = str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__
                self._update(ref, status="failed", step="", error=message)
            finally:
                folder = self.store.folder(ref.id)
                for leftover in folder.iterdir() if folder.exists() else ():
                    if leftover.is_file() and not _KEEP.match(leftover.name):
                        leftover.unlink(missing_ok=True)  # the video itself: the frames are all that's needed
        return ref

    async def _run(self, ref: Reference, file: Path | None) -> None:
        folder = self.store.folder(ref.id)
        if ref.source == "link":
            self._update(ref, step="Downloading the video…")
            cand = Candidate(platform=ref.platform or "link", id=ref.id, url=ref.url)
            try:
                file = await asyncio.to_thread(self.downloader.download, cand, folder, None)
            except NotAVideo as exc:
                raise NotAVideo(f"{exc}. If it's a picture, save it and add the file instead.") from exc
            ref.caption, ref.author, ref.duration = cand.caption[:2000], cand.author, cand.duration
        if file is None or not file.exists():
            raise RuntimeError("The file didn't arrive")

        self._update(ref, step="Taking frames…")
        frames = await asyncio.to_thread(self._frames, ref, file)
        if not frames:
            raise NotAVideo("Couldn't read a picture from it — is it a video or image file?")
        for i, frame in enumerate(frames, start=1):
            self.store.frame_file(ref.id, i).write_bytes(frame)
        ref.frames = len(frames)

        notes = []
        if self.vision.installed():
            if not self.vision.ready:
                self._update(ref, step="Loading the similarity model (the first time downloads ~600 MB)…")
            if await asyncio.to_thread(self.vision.load):
                self._update(ref, step="Measuring how it looks…")
                looks = await asyncio.to_thread(self.vision.embed_images, frames)
                import numpy as np

                np.save(folder / "looks.npy", looks)
                ref.looks = True
                ref.tags = await asyncio.to_thread(self.vision.tags, looks)
            else:
                notes.append(f"the similarity model couldn't load ({self.vision.error})")
        else:
            notes.append("the similarity model isn't installed — quit and reopen Reel Finder to install it")

        self._update(ref, step="Asking the AI what's in it…")
        brain, warning = await self.brain_factory(self.model())
        describe = getattr(brain, "describe_reference", None)
        if describe is None:
            notes.append("no AI description (Ollama isn't running)")
        else:
            picks = frames if len(frames) <= 4 else [frames[i] for i in (0, len(frames) // 3, 2 * len(frames) // 3, -1)]
            try:
                info = await describe(picks, ref.caption)
                ref.description, ref.queries = info["description"], info["queries"]
                ref.hashtags = info["hashtags"]
            except Exception as exc:  # noqa: BLE001
                log.warning("The AI couldn't describe reference %s: %r", ref.name, exc)
                notes.append("the AI couldn't describe it")
        ref.hashtags = list(dict.fromkeys(hashtags_in(ref.caption) + ref.hashtags))[:10]

        if not ref.looks and not ref.description and not ref.hashtags:
            raise RuntimeError("Couldn't analyse it: " + "; ".join(notes))
        self._update(ref, status="ready", step="", note=("Note: " + "; ".join(notes) + ".") if notes else "")

    def _frames(self, ref: Reference, file: Path) -> list[bytes]:
        media = self.downloader.inspect(file)
        if media.video_codec and media.duration >= 0.3:
            ref.kind = "video"
            ref.duration = ref.duration or media.duration
            return self.downloader.extract_frames(file, ref.duration, FRAME_COUNT)
        if media.audio_codecs and not media.video_codec:
            raise NotAVideo("That file is sound only — there's no picture to compare")
        picture = self.downloader.to_jpeg(file.read_bytes(), max_side=640)
        if picture[:2] != b"\xff\xd8":
            return []
        ref.kind = "image"
        return [picture]


def reference_summary(refs: list[Reference]) -> str:
    """One line per reference for logs and reports."""
    return "; ".join(f"{r.name[:60]} ({r.status}{', ' + ', '.join(r.tags) if r.tags else ''})" for r in refs)
