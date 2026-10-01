from __future__ import annotations

from pydantic import BaseModel


class Candidate(BaseModel):
    """One short video an agent found, plus where it is in the pipeline."""

    platform: str
    id: str
    url: str
    caption: str = ""
    author: str = ""
    views: int | None = None
    likes: int | None = None
    duration: float | None = None
    timestamp: int | None = None
    thumbnail_url: str | None = None
    # Instagram grid links (/p/...) can be photos; only a metadata probe can tell.
    maybe_not_video: bool = False

    query: str = ""
    agent: int | None = None
    found_at: float = 0.0
    status: str = "found"  # found → judging → accepted → downloading → downloaded | rejected | failed
    score: int | None = None
    reason: str = ""
    thumb: str | None = None  # local thumbnail file name served at /thumbs/
    file: str | None = None

    @property
    def key(self) -> str:
        return f"{self.platform}:{self.id}"

    @property
    def archive_id(self) -> str:
        """The line yt-dlp writes to its download archive for this video."""
        return f"{self.platform} {self.id}"

    def merge(self, other: Candidate) -> None:
        """Fill fields this candidate is missing from another sighting of the same video."""
        for field in ("caption", "author", "views", "likes", "duration", "timestamp", "thumbnail_url"):
            if not getattr(self, field) and getattr(other, field):
                setattr(self, field, getattr(other, field))
        if not other.maybe_not_video:
            self.maybe_not_video = False
