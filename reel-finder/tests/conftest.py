import json
import os
import sys
import tempfile
from pathlib import Path

# Keep tests away from your real settings, browser profile and thumbnails.
os.environ.setdefault("REELFINDER_DATA", tempfile.mkdtemp(prefix="reelfinder-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text())
