"""History: a "batch" is one press of the Post button — the same content sent to several accounts.

The posting engine tracks each account's post separately; Ultimate remembers which ones belong
together (and to which model) and merges their live status. Same logic as Fifofarm's History.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from . import db

MAX_BATCHES_PER_MODEL = 2000
DAY = 24 * 3600
FAILURE_WORDS = re.compile(r"error|couldn't|could not|failed|unable", re.I)


def parse_iso(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ts * 1000) % 1000:03d}Z"


def create(persona_id: str, fields: dict) -> dict:
    batch = {"id": str(uuid.uuid4()), "createdAt": iso(time.time()), "modelId": persona_id, **fields}
    db.run("INSERT INTO batches (id, persona_id, created_at, data) VALUES (?, ?, ?, ?)",
           (batch["id"], persona_id, batch["createdAt"], json.dumps(batch)))
    # Keep the newest few thousand per model.
    db.run("""DELETE FROM batches WHERE persona_id = ? AND id NOT IN (
                SELECT id FROM batches WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?)""",
           (persona_id, persona_id, MAX_BATCHES_PER_MODEL))
    return batch


def get(batch_id: str, persona_id: str | None = None) -> dict | None:
    row = db.row("SELECT data, persona_id FROM batches WHERE id = ?", (batch_id,))
    if not row or (persona_id and row["persona_id"] != persona_id):
        return None
    return json.loads(row["data"])


def list_for(persona_id: str, limit: int = 50) -> list[dict]:
    rows = db.rows("SELECT data FROM batches WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?",
                   (persona_id, limit))
    return [json.loads(r["data"]) for r in rows]


def all_batches() -> list[dict]:
    return [json.loads(r["data"]) for r in db.rows("SELECT data FROM batches ORDER BY created_at DESC")]


def save(batch: dict) -> None:
    db.run("UPDATE batches SET data = ? WHERE id = ?", (json.dumps(batch), batch["id"]))


def remove(batch_id: str) -> None:
    db.run("DELETE FROM batches WHERE id = ?", (batch_id,))


def posts_window(batches: list[dict]) -> tuple[str, str] | None:
    """Time window that covers every post in these batches (the engine lists posts by publish date)."""
    start, end = float("inf"), float("-inf")
    for b in batches:
        created = parse_iso(b.get("createdAt")) or time.time()
        when = parse_iso(b.get("scheduleAt")) or created
        start, end = min(start, created, when), max(end, created, when)
    if start == float("inf"):
        return None
    return iso(start - DAY), iso(end + DAY)


def _error_from_notifications(item: dict, batch: dict, notifications: list[dict]) -> str | None:
    """The engine's error details only reach its public API as notifications naming the network."""
    since = (parse_iso(item.get("sentAt")) or parse_iso(batch.get("createdAt")) or 0) - 5
    network = item["identifier"].split("-")[0].lower()
    candidates = []
    for n in notifications:
        at = parse_iso(n.get("createdAt") or n.get("updatedAt")) or 0
        text = str(n.get("content") or n.get("title") or "")
        if at >= since and FAILURE_WORDS.search(text) and network in text.lower():
            candidates.append((at, text))
    candidates.sort()
    match = next((t for _, t in candidates if item.get("accountName") and item["accountName"] in t), None)
    match = match or (candidates[0][1] if candidates else None)
    if not match:
        return None
    text = re.sub(r"<[^>]+>", " ", match)
    text = re.sub(r"^An error occurred while posting on [\w-]+:\s*", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def item_status(item: dict, post: Any, batch: dict, notifications: list[dict], now: float | None = None) -> dict:
    """post: None = no live data yet (right after posting); False = not in the engine anymore."""
    now = time.time() if now is None else now
    if item.get("rejected"):
        return {"state": "failed", "error": item["rejected"]}
    if not item.get("postId"):
        return {"state": "failed", "error": "Not sent."}
    if post is None:
        scheduled = parse_iso(batch.get("scheduleAt"))
        return {"state": "scheduled" if scheduled and scheduled > now + 60 else "posting"}
    if not post:
        return {"state": "deleted"}
    state = post.get("state")
    if state == "PUBLISHED":
        return {"state": "published", "url": post.get("releaseURL") or None}
    if state == "ERROR":
        return {"state": "failed",
                "error": _error_from_notifications(item, batch, notifications) or "The network rejected the post."}
    if state == "DRAFT":
        return {"state": "draft"}
    publish = parse_iso(post.get("publishDate"))
    return {"state": "scheduled" if publish and publish > now + 60 else "posting"}


def with_status(batch: dict, posts_by_id: dict[str, dict] | None, notifications: list[dict]) -> dict:
    items = []
    for item in batch.get("items", []):
        post = None if posts_by_id is None else posts_by_id.get(item.get("postId") or "", False)
        items.append({**item, **item_status(item, post, batch, notifications)})
    counts: dict[str, int] = {}
    for item in items:
        counts[item["state"]] = counts.get(item["state"], 0) + 1
    return {**batch, "items": items, "counts": counts}


def days_ago(days: float) -> str:
    return iso((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
