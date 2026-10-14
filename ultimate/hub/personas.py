"""Models: each one gets its own Fifofarm, Reel Finder and AI Studio.

A model has a name, a color, its social accounts and four folders:
  references  your reference videos/pictures for this model (you connect one of your folders)
  photos      photos of the model, used by AI Studio (you connect one of your folders)
  found       where Reel Finder saves the videos it finds
  generated   where AI Studio saves what it makes
"found" and "generated" start in ~/Movies/Fifofarm Ultimate/<model>/ until you choose others.
Your files are never deleted, not even when you remove a model.
"""

from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from . import db
from .config import DEFAULT_MEDIA_ROOT, MODELS_DATA_DIR

FOLDER_KINDS: dict[str, str] = {
    "references": "Reference folder",
    "photos": "Model photos",
    "found": "Found videos",
    "generated": "AI Studio",
    "edited": "Edited reels",
}
DEFAULT_FOLDERS = ("found", "generated", "edited")  # created for you; the others are yours to connect

COLORS = ["#4f46e5", "#db2777", "#059669", "#d97706", "#0891b2", "#7c3aed", "#dc2626", "#65a30d"]
_ID = re.compile(r"^[0-9a-f]{12}$")
MAX_NAME = 40


class PersonaError(ValueError):
    pass


def valid_id(persona_id: str) -> bool:
    return bool(_ID.match(persona_id or ""))


def folder_safe(name: str) -> str:
    cleaned = re.sub(r"[^\w .-]", "", name, flags=re.UNICODE).strip(" .")
    return cleaned[:60] or "Model"


def default_folder(name: str, kind: str) -> str:
    return str(DEFAULT_MEDIA_ROOT / folder_safe(name) / FOLDER_KINDS[kind])


def data_dir(persona_id: str) -> Path:
    if not valid_id(persona_id):
        raise PersonaError("Unknown model.")
    return MODELS_DATA_DIR / persona_id


def _public(row: dict) -> dict:
    try:
        folders = json.loads(row["folders"] or "{}")
    except ValueError:
        folders = {}
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "position": row["position"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
        "folders": {kind: folders.get(kind) or "" for kind in FOLDER_KINDS},
    }


def check_name(name: Any, *, exclude: str | None = None) -> str:
    if not isinstance(name, str):
        raise PersonaError("Give the model a name.")
    cleaned = re.sub(r"\s+", " ", name).strip()
    if not cleaned:
        raise PersonaError("Give the model a name.")
    if len(cleaned) > MAX_NAME:
        raise PersonaError(f"Keep the name under {MAX_NAME} characters.")
    clash = db.row("SELECT id FROM personas WHERE name = ? COLLATE NOCASE AND id != ?", (cleaned, exclude or ""))
    if clash:
        raise PersonaError(f"There's already a model called {cleaned}.")
    return cleaned


def list_all() -> list[dict]:
    return [_public(r) for r in db.rows("SELECT * FROM personas ORDER BY position, created_at")]


def get(persona_id: str) -> dict | None:
    if not valid_id(persona_id):
        return None
    found = db.row("SELECT * FROM personas WHERE id = ?", (persona_id,))
    return _public(found) if found else None


def require(persona_id: str) -> dict:
    persona = get(persona_id)
    if not persona:
        raise PersonaError("That model doesn't exist anymore.")
    return persona


def create(name: Any, color: str | None = None) -> dict:
    cleaned = check_name(name)
    used = {p["color"] for p in list_all()}
    color = color if color in COLORS else next((c for c in COLORS if c not in used), COLORS[len(used) % len(COLORS)])
    persona_id = uuid.uuid4().hex[:12]
    folders = {kind: default_folder(cleaned, kind) for kind in DEFAULT_FOLDERS}
    position = (db.row("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM personas") or {"p": 0})["p"]
    db.run(
        "INSERT INTO personas (id, name, color, position, folders, notes, created_at) VALUES (?, ?, ?, ?, ?, '', ?)",
        (persona_id, cleaned, color, position, json.dumps(folders), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
    )
    data_dir(persona_id).mkdir(parents=True, exist_ok=True)
    return require(persona_id)


def update(persona_id: str, patch: dict[str, Any]) -> dict:
    persona = require(persona_id)
    if "name" in patch:
        db.run("UPDATE personas SET name = ? WHERE id = ?", (check_name(patch["name"], exclude=persona_id), persona_id))
    if "color" in patch:
        if patch["color"] not in COLORS:
            raise PersonaError("Pick one of the colors.")
        db.run("UPDATE personas SET color = ? WHERE id = ?", (patch["color"], persona_id))
    if "notes" in patch:
        notes = str(patch["notes"] or "")[:2000]
        db.run("UPDATE personas SET notes = ? WHERE id = ?", (notes, persona_id))
    if "folders" in patch:
        folders = dict(persona["folders"])
        for kind, value in (patch["folders"] or {}).items():
            if kind not in FOLDER_KINDS:
                raise PersonaError(f"Unknown folder: {kind}")
            folders[kind] = normalize_folder(value) if value else ""
            if not folders[kind] and kind in DEFAULT_FOLDERS:
                folders[kind] = default_folder(get(persona_id)["name"], kind)  # type: ignore[index]
        db.run("UPDATE personas SET folders = ? WHERE id = ?", (json.dumps(folders), persona_id))
    return require(persona_id)


def reorder(ids: list[str]) -> list[dict]:
    with db.tx() as c:
        for position, persona_id in enumerate(ids):
            c.execute("UPDATE personas SET position = ? WHERE id = ?", (position, persona_id))
    return list_all()


def remove(persona_id: str) -> None:
    """Forget a model: its accounts become unassigned; its history goes; your files stay."""
    require(persona_id)
    with db.tx() as c:
        c.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
        c.execute("DELETE FROM persona_accounts WHERE persona_id = ?", (persona_id,))
        c.execute("DELETE FROM pending_connects WHERE persona_id = ?", (persona_id,))
        batch_ids = [r["id"] for r in c.execute("SELECT id FROM batches WHERE persona_id = ?", (persona_id,)).fetchall()]
        if batch_ids:
            marks = db.placeholders(batch_ids)
            post_ids = [r["post_id"] for r in c.execute(
                f"SELECT post_id FROM post_metrics WHERE batch_id IN ({marks})", batch_ids).fetchall()]
            c.execute(f"DELETE FROM post_metrics WHERE batch_id IN ({marks})", batch_ids)
            if post_ids:
                c.execute(f"DELETE FROM post_daily WHERE post_id IN ({db.placeholders(post_ids)})", post_ids)
        c.execute("DELETE FROM batches WHERE persona_id = ?", (persona_id,))
        c.execute("DELETE FROM studio_jobs WHERE persona_id = ?", (persona_id,))
    shutil.rmtree(data_dir(persona_id), ignore_errors=True)


def normalize_folder(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PersonaError("Choose a folder.")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute():
        raise PersonaError("Use a full folder path (like /Users/you/Movies/Mia).")
    if path.exists() and not path.is_dir():
        raise PersonaError("That's a file, not a folder.")
    return str(path)


def folder(persona: dict, kind: str) -> Path | None:
    value = persona["folders"].get(kind) or ""
    return Path(value).expanduser() if value else None


def folders_of(persona: dict) -> dict[str, Path]:
    return {kind: Path(v).expanduser() for kind, v in persona["folders"].items() if v}


def inside_folders(persona: dict, path: Path) -> bool:
    """Is this file inside one of the model's folders? (Only those files are served or used.)"""
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return False
    for root in folders_of(persona).values():
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False
