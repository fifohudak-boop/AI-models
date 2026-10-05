"""How much a video looks like your reference videos (or your description).

Uses CLIP (ViT-B/32) through fastembed: ONNX on the CPU, no GPU or PyTorch, ~35 ms per image.
The model (~600 MB) downloads once into data/models. Without it Reel Finder still works, with the
AI and keywords doing all the judging.
"""

from __future__ import annotations

import io
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .config import DATA_DIR

log = logging.getLogger("reelfinder")

MODELS_DIR = Path(os.environ.get("REELFINDER_MODELS", DATA_DIR / "models"))
IMAGE_MODEL = "Qdrant/clip-ViT-B-32-vision"
TEXT_MODEL = "Qdrant/clip-ViT-B-32-text"

# Calibrated on real short-form videos (Pinterest searches across 7 topics: 84 covers, 10 videos):
#   a video's own frames vs its cover   0.83–0.94  → 80–100
#   the same kind of video               0.75–0.87  → 55–90
#   unrelated videos                     ~0.50      → 0
LOOK_LO, LOOK_HI = 0.55, 0.90
#   a description vs covers of what it describes: 0.25–0.32; vs other covers: 0.10–0.22
TEXT_LO, TEXT_HI = 0.18, 0.32

# Short-form themes the reference is matched against when there's no AI model to describe it.
# They double as search terms, so they're phrased the way people search.
CONCEPTS = [
    "car drift", "street racing", "jdm cars", "supercar", "car meet", "drag racing", "rally car",
    "formula 1", "car interior", "car detailing", "offroad 4x4", "motorcycle", "motorcycle stunts",
    "bicycle", "skateboarding", "surfing", "snowboarding", "skiing", "parkour", "extreme sports",
    "boxing", "mma fight", "martial arts", "football", "basketball", "tennis", "golf", "running",
    "gym workout", "bodybuilding", "yoga", "pilates", "dance", "dance choreography", "ballet",
    "fashion outfit", "streetwear", "luxury lifestyle", "watches", "jewelry", "sneakers", "perfume",
    "makeup", "skincare", "hairstyle", "nails", "tattoo", "cooking", "baking", "street food",
    "restaurant food", "dessert", "pizza", "sushi", "burger", "coffee", "cocktails", "fruit",
    "anime edit", "gaming", "3d animation", "motion graphics", "typography", "cinematic film",
    "black and white film", "vintage film", "slow motion", "time lapse", "drone footage",
    "city at night", "neon lights", "rain", "snow", "sunset", "beach", "ocean waves", "underwater",
    "mountains", "forest", "waterfall", "desert", "lake", "nature landscape", "autumn", "flowers",
    "garden", "plants", "travel vlog", "hiking", "camping", "fishing", "boats", "airplane", "train",
    "architecture", "interior design", "cozy room", "home decor", "cat", "dog", "horse", "wildlife",
    "concert", "dj", "music studio", "guitar", "piano", "singing", "comedy skit", "talking to camera",
    "podcast", "interview", "asmr", "satisfying video", "art painting", "drawing", "pottery",
    "woodworking", "diy craft", "photography", "product showcase", "unboxing", "tech gadgets",
    "computer setup", "study with me", "wedding", "baby", "couple", "friends party", "nightclub",
    "fireworks", "space", "christmas", "halloween", "meditation",
]


def _scale(x: float, lo: float, hi: float) -> int:
    return int(round(100 * min(1.0, max(0.0, (x - lo) / (hi - lo)))))


def look_score(cos: float) -> int:
    """0–100: how alike two pictures look (CLIP cosine, calibrated)."""
    return _scale(cos, LOOK_LO, LOOK_HI)


def text_score(cos: float) -> int:
    """0–100: how well a picture shows what a text describes (CLIP cosine, calibrated)."""
    return _scale(cos, TEXT_LO, TEXT_HI)


def look_weight(closeness: int) -> float:
    """How much the final score leans on looking like the reference (vs. the AI's judgement)."""
    return 0.4 + 0.5 * max(0, min(100, closeness)) / 100


def min_look(closeness: int) -> int:
    """The lowest look score a video may have and still be saved; 0 below "Close"."""
    return 0 if closeness < 50 else int(round((closeness - 50) * 1.4))


def closeness_label(closeness: int) -> str:
    if closeness < 35:
        return "Same kind of video"
    if closeness < 70:
        return "Same look"
    if closeness < 90:
        return "Very close"
    return "Nearly identical"


class Vision:
    """CLIP image + text encoders, loaded on first use and shared by everything."""

    def __init__(self, models_dir: Path = MODELS_DIR):
        self.models_dir = models_dir
        self._image = None
        self._text = None
        self._concepts = None
        self._lock = threading.Lock()
        self.error = ""

    @staticmethod
    def installed() -> bool:
        try:
            import fastembed  # noqa: F401
            import numpy  # noqa: F401
            from PIL import Image  # noqa: F401
        except Exception:  # noqa: BLE001 - any import problem means "not available"
            return False
        return True

    @property
    def ready(self) -> bool:
        return self._image is not None and self._text is not None

    def downloaded(self) -> bool:
        """Whether the model files are already on disk (so loading won't download ~600 MB)."""
        return any(self.models_dir.glob("*clip-ViT-B-32-vision*")) and any(self.models_dir.glob("*clip-ViT-B-32-text*"))

    def load(self) -> bool:
        """Load (downloading the first time) both encoders. Returns False if that's impossible."""
        if self.ready:
            return True
        with self._lock:
            if self.ready:
                return True
            if not self.installed():
                self.error = "the similarity package (fastembed) isn't installed"
                return False
            try:
                from fastembed import ImageEmbedding, TextEmbedding

                self.models_dir.mkdir(parents=True, exist_ok=True)
                self._image = ImageEmbedding(IMAGE_MODEL, cache_dir=str(self.models_dir))
                self._text = TextEmbedding(TEXT_MODEL, cache_dir=str(self.models_dir))
                self.error = ""
            except Exception as exc:  # noqa: BLE001 - offline, disk full, … — run without it
                self._image = self._text = None
                self.error = str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__
                log.warning("Couldn't load the similarity model: %s", self.error)
                return False
        return True

    def embed_images(self, images: list[bytes]):
        """One L2-normalised row per image (JPEG/PNG/WebP bytes). Undecodable images raise ValueError."""
        import numpy as np
        from PIL import Image

        if not self.load():
            raise RuntimeError(self.error or "similarity model unavailable")
        pics = []
        for raw in images:
            try:
                pic = Image.open(io.BytesIO(raw))
                pic.load()
                pics.append(pic.convert("RGB"))
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"not an image: {exc}") from exc
        with self._lock:
            vectors = np.array(list(self._image.embed(pics, batch_size=16)), dtype=np.float32)
        return _normalise(vectors)

    def embed_texts(self, texts: list[str]):
        import numpy as np

        if not self.load():
            raise RuntimeError(self.error or "similarity model unavailable")
        with self._lock:
            vectors = np.array(list(self._text.embed(texts)), dtype=np.float32)
        return _normalise(vectors)

    def text_match(self, text: str, picture) -> int:
        """0–100: how well one embedded picture shows `text`."""
        return text_score(float(self.embed_texts([text])[0] @ picture))

    def tags(self, pictures, k: int = 4) -> list[str]:
        """The short-form themes (from CONCEPTS) that best describe these embedded pictures."""
        import numpy as np

        if self._concepts is None:
            self._concepts = self.embed_texts([f"a photo of {c}" for c in CONCEPTS])
        mean = _normalise(np.asarray(pictures).mean(axis=0, keepdims=True))[0]
        sims = self._concepts @ mean
        order = np.argsort(-sims)
        top = float(sims[order[0]])
        # Only themes nearly as good as the best one: the 3rd and 4th guesses are often noise.
        best = [CONCEPTS[i] for i in order[:k] if float(sims[i]) >= top - 0.015 and text_score(float(sims[i])) >= 35]
        return best or [CONCEPTS[order[0]]]


def _normalise(vectors):
    import numpy as np

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.where(norms == 0, 1, norms)


@dataclass
class ReferenceSet:
    """The frames of every reference video, embedded. A video matches if it looks like any one of them."""

    frames: list = field(default_factory=list)  # one (n_frames, dim) matrix per reference video

    def __bool__(self) -> bool:
        return bool(self.frames)

    def look(self, picture) -> int:
        """0–100 for one picture (e.g. a cover): its best match among the reference videos."""
        best = 0.0
        for ref in self.frames:
            sims = ref @ picture
            centre = ref.mean(axis=0)
            centre = centre / (float((centre @ centre) ** 0.5) or 1.0)
            best = max(best, 0.6 * float(sims.max()) + 0.4 * float(centre @ picture))
        return look_score(best)

    def frames_look(self, pictures) -> int:
        """0–100 for a downloaded video's frames: on average, how close each frame gets to the reference."""
        best = 0.0
        for ref in self.frames:
            best = max(best, float((pictures @ ref.T).max(axis=1).mean()))
        return look_score(best)


# One shared instance for the app.
vision = Vision()


if __name__ == "__main__":
    # `python -m reelfinder.similarity download` fetches the model ahead of time (used by start.command).
    import sys

    if sys.argv[1:] == ["download"]:
        if not Vision.installed():
            sys.exit(1)
        if vision.downloaded():
            sys.exit(0)  # already here; the app loads it when it's needed
        print("\n\033[1mDownloading the look-matching model (one-time, about 600 MB)…\033[0m", flush=True)
        if not vision.load():
            print(f"Couldn't download the look-matching model right now ({vision.error}). "
                  "It will try again next time.")
            sys.exit(1)
