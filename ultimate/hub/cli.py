"""Small helpers for start.command.

    python -m hub.cli ai-models   the local AI models your models' Reel Finder settings use (one per line)
"""

from __future__ import annotations

import json
import sys

from .config import MODELS_DATA_DIR
from .reels.config import DEFAULT_MODEL


def ai_models() -> list[str]:
    found: list[str] = []
    for path in sorted(MODELS_DATA_DIR.glob("*/reels-settings.json")):
        try:
            name = json.loads(path.read_text()).get("model")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(name, str) and name.strip() and name.strip() not in found:
            found.append(name.strip())
    return found or [DEFAULT_MODEL]


def main(argv: list[str]) -> int:
    if argv == ["ai-models"]:
        print("\n".join(ai_models()))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
