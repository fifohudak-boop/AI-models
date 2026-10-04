from __future__ import annotations

from pydantic import BaseModel

# Where a candidate is in the pipeline:
#   queued → checking → scored → picked → downloading → downloaded
#   skipped   (failed one of your filters)
#   notpicked (checked, but not among the best N)
#   failed    (couldn't be saved as a playable video — the next best one takes its place)
#   unchecked (only when you press "Stop now")


class Candidate(BaseModel):
    """One short video (or Pinterest image) an agent found, plus where it is in the pipeline."""

    platform: str
    id: str
    url: str
    kind: str = "video"  # "video" or "image" (Pinterest image pins)
    caption: str = ""
    author: str = ""
    views: int | None = None
    likes: int | None = None
    duration: float | None = None
    timestamp: int | None = None
    thumbnail_url: str | None = None
    image_url: str | None = None  # full-size picture for image pins
    # Grid links (Instagram /p/…, Pinterest /pin/…) can be photos; the download step tells for sure.
    maybe_not_video: bool = False
    # True when the details came from the site's own data (not just a link on the page).
    rich: bool = False

    query: str = ""
    agent: int | None = None
    found_at: float = 0.0
    status: str = "queued"
    score: int | None = None
    reason: str = ""
    quick: bool = False  # scored from the caption only (the AI ran out of time)
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
        """Combine two sightings of the same video; the site's own data beats a bare page link."""
        fields = ("caption", "author", "views", "likes", "duration", "timestamp", "thumbnail_url", "image_url")
        prefer_other = other.rich and not self.rich
        for field in fields:
            theirs = getattr(other, field)
            if theirs and (prefer_other or not getattr(self, field)):
                setattr(self, field, theirs)
        if other.rich:
            self.kind = other.kind
            self.rich = True
        if not other.maybe_not_video:
            self.maybe_not_video = False
