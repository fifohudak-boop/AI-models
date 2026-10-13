import os
import sys
import tempfile
from pathlib import Path

# Keep tests away from your real data (settings, models, browser profile, thumbnails).
os.environ.setdefault("ULTIMATE_DATA", tempfile.mkdtemp(prefix="ultimate-test-"))
os.environ.setdefault("ULTIMATE_MEDIA_ROOT", tempfile.mkdtemp(prefix="ultimate-media-"))
os.environ.setdefault("REELFINDER_HOME", tempfile.mkdtemp(prefix="reel-finder-app-"))
# The similarity model (~600 MB) is downloaded once and shared between test runs.
os.environ.setdefault("REELFINDER_MODELS", str(Path.home() / ".cache" / "reelfinder-models"))
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent / "reels"))
