"""Analytics, per model. A copy of Fifofarm's: the posting engine asks each network how every video
posted from here is doing (often while it's new, less often as it ages) and one snapshot per day is
kept so growth can be charted. Account numbers (followers, reach…) come every few hours.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

from . import accounts as account_store
from . import batches as batch_store
from . import db, postiz
from .platforms import platform_name

log = logging.getLogger("ultimate.analytics")

MINUTE = 60
HOUR = 60 * MINUTE
DAY = 24 * HOUR
TRACK_DAYS = 90
MAX_POST_CALLS_PER_RUN = 40
MAX_ACCOUNT_CALLS_PER_RUN = 10
ACCOUNT_REFRESH_S = 6 * HOUR

ANALYTICS_NETWORKS = {"instagram", "instagram-standalone", "facebook", "threads", "x", "linkedin-page",
                      "pinterest", "tiktok", "youtube", "gmb"}

COLUMN_SOURCES = {
    "views": ["views", "video_views", "plays", "impressions"],
    "likes": ["likes", "reactions"],
    "comments": ["comments", "replies"],
    "shares": ["shares", "reposts", "retweets"],
    "saves": ["saves", "saved", "bookmarks"],
    "reach": ["reach"],
}


def slug(label: Any) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", str(label).lower()))


def day_of(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _day_ts(day: str) -> float:
    return datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()


def normalize_day(value: Any, fallback_ts: float) -> str:
    ts = batch_store.parse_iso(value) if isinstance(value, str) else None
    if ts is None and isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        return value
    return day_of(ts if ts is not None else fallback_ts)


def _number(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def parse_metrics(items: Any) -> dict[str, dict]:
    """[{label, data: [{total, date}]}] → {views: {label, value}, …} using each metric's newest value."""
    out: dict[str, dict] = {}
    for m in items if isinstance(items, list) else []:
        label = str((m or {}).get("label") or "").strip()
        points = (m or {}).get("data") if isinstance((m or {}).get("data"), list) else []
        value = _number(points[-1].get("total")) if points and isinstance(points[-1], dict) else None
        if not label or value is None:
            continue
        out[slug(label)] = {"label": label, "value": value}
    return out


def columns_from(metrics: dict[str, dict]) -> dict[str, int | None]:
    out: dict[str, int | None] = {}
    for column, sources in COLUMN_SOURCES.items():
        key = next((k for k in sources if k in metrics), None)
        out[column] = round(metrics[key]["value"]) if key else None
    return out


def refresh_delay(published_ts: float, now: float) -> float | None:
    """Hourly while a video is new, then less and less often; after 90 days the numbers stay."""
    age = now - published_ts
    if not age >= 0:
        return HOUR
    if age < 2 * DAY:
        return HOUR
    if age < 7 * DAY:
        return 6 * HOUR
    if age < 30 * DAY:
        return DAY
    if age < TRACK_DAYS * DAY:
        return 7 * DAY
    return None


def sync_tracked_posts(now: float | None = None, batches: list[dict] | None = None) -> None:
    now = time.time() if now is None else now
    batches = batch_store.all_batches() if batches is None else batches
    since = now - TRACK_DAYS * DAY
    wanted: dict[str, dict] = {}
    in_history: set[str] = set()
    for b in batches:
        created = batch_store.parse_iso(b.get("createdAt")) or 0
        scheduled = batch_store.parse_iso(b.get("scheduleAt"))
        latest = max(created, scheduled or 0)
        first_check = max(scheduled, now) if scheduled else now
        for item in b.get("items", []):
            if not item.get("postId") or item.get("rejected"):
                continue
            in_history.add(item["postId"])
            if latest >= since:
                wanted[item["postId"]] = {"batch": b["id"], "account": item["accountId"],
                                          "identifier": item["identifier"], "first": first_check}
    known = {r["post_id"] for r in db.rows("SELECT post_id FROM post_metrics")}
    with db.tx() as c:
        for post_id, w in wanted.items():
            if post_id not in known:
                c.execute("""INSERT INTO post_metrics (post_id, batch_id, account_id, identifier, status, next_fetch_at)
                             VALUES (?, ?, ?, ?, 'waiting', ?)""",
                          (post_id, w["batch"], w["account"], w["identifier"], w["first"]))
        for post_id in known - in_history:
            c.execute("DELETE FROM post_metrics WHERE post_id = ?", (post_id,))
            c.execute("DELETE FROM post_daily WHERE post_id = ?", (post_id,))


def _set_status(post_id: str, status: str, error: str | None, next_fetch: float | None,
                facts: dict | None = None) -> None:
    facts = facts or {}
    db.run("""UPDATE post_metrics SET status = ?, error = ?, next_fetch_at = ?,
                published_at = COALESCE(?, published_at), url = COALESCE(?, url) WHERE post_id = ?""",
           (status, error, next_fetch, facts.get("publishedAt"), facts.get("url"), post_id))


def _save_numbers(row: dict, metrics: dict, now: float, published_ts: float) -> None:
    c = columns_from(metrics)
    delay = refresh_delay(published_ts, now)
    with db.tx() as conn:
        conn.execute("""UPDATE post_metrics SET views = ?, likes = ?, comments = ?, shares = ?, saves = ?, reach = ?,
                          extra = ?, status = 'ok', error = NULL, fetched_at = ?, next_fetch_at = ? WHERE post_id = ?""",
                     (c["views"], c["likes"], c["comments"], c["shares"], c["saves"], c["reach"], json.dumps(metrics),
                      now, None if delay is None else now + delay, row["post_id"]))
        conn.execute("""INSERT INTO post_daily (post_id, day, views, likes, comments, shares, saves, reach)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(post_id, day) DO UPDATE SET views = excluded.views, likes = excluded.likes,
                          comments = excluded.comments, shares = excluded.shares, saves = excluded.saves,
                          reach = excluded.reach""",
                     (row["post_id"], day_of(now), c["views"], c["likes"], c["comments"], c["shares"], c["saves"],
                      c["reach"]))


async def refresh_posts(now: float, max_calls: int) -> int:
    due = db.rows("SELECT * FROM post_metrics WHERE next_fetch_at IS NOT NULL AND next_fetch_at <= ? "
                  "ORDER BY next_fetch_at LIMIT ?", (now, max_calls))
    if not due:
        return 0
    by_batch = {b["id"]: b for b in batch_store.all_batches()}
    start, end = float("inf"), float("-inf")
    for row in due:
        b = by_batch.get(row["batch_id"])
        for t in (b and batch_store.parse_iso(b.get("createdAt")), b and batch_store.parse_iso(b.get("scheduleAt")), now):
            if t:
                start, end = min(start, t), max(end, t)
    posts = await postiz.list_posts(batch_store.iso(start - 2 * DAY), batch_store.iso(end + 2 * DAY))
    by_id = {p.get("id"): p for p in posts}
    calls = 0
    unreachable = 0
    for row in due:
        post = by_id.get(row["post_id"])
        if not post:
            _set_status(row["post_id"], "gone", None, None)
            continue
        if post.get("state") == "ERROR":
            _set_status(row["post_id"], "failed", None, None)
            continue
        published = batch_store.parse_iso(post.get("publishDate"))
        if post.get("state") != "PUBLISHED":
            _set_status(row["post_id"], "waiting", None, max(published or now, now) + 15 * MINUTE)
            continue
        published = published or now
        facts = {"publishedAt": batch_store.iso(published), "url": post.get("releaseURL") or None}
        age = now - published
        if row["identifier"] not in ANALYTICS_NETWORKS:
            _set_status(row["post_id"], "unsupported", None, None, facts)
            continue
        if not post.get("releaseId"):
            gone = age > 3 * DAY
            _set_status(row["post_id"], "unavailable" if gone else "waiting", None, None if gone else now + HOUR, facts)
            continue
        later = refresh_delay(now - age, now)
        retry_at = None if later is None else now + max(later, 6 * HOUR)
        db.run("UPDATE post_metrics SET next_fetch_at = ? WHERE post_id = ?", (now + HOUR, row["post_id"]))
        calls += 1
        try:
            result = await postiz.post_analytics(row["post_id"], 30)
            unreachable = 0
        except postiz.PostizError as exc:
            _set_status(row["post_id"], "error" if row["fetched_at"] is None else "ok", str(exc),
                        now + HOUR if exc.status == 503 else retry_at, facts)
            if exc.status == 503:
                unreachable += 1
                if unreachable >= 3:
                    raise
            continue
        if isinstance(result, dict) and result.get("missing"):
            _set_status(row["post_id"], "unavailable", None, None, facts)
            continue
        metrics = parse_metrics(result)
        if not metrics:
            if row["fetched_at"] is not None:
                _set_status(row["post_id"], "ok", None, retry_at, facts)
                continue
            give_up = age > 7 * DAY
            _set_status(row["post_id"], "unavailable" if give_up else "no-data", None,
                        None if give_up else now + (HOUR if age < DAY else 6 * HOUR), facts)
            continue
        _set_status(row["post_id"], "ok", None, None, facts)
        _save_numbers(row, metrics, now, published)
    return calls


def save_account_stats(account_id: str, items: Any, now: float) -> None:
    with db.tx() as c:
        for m in items if isinstance(items, list) else []:
            label = str((m or {}).get("label") or "").strip()
            points = [p for p in ((m or {}).get("data") or []) if isinstance(p, dict) and _number(p.get("total")) is not None]
            if not label or not points:
                continue
            kind = "daily" if len(points) > 1 else "total"
            for p in points:
                day = day_of(now) if kind == "total" else normalize_day(p.get("date"), now)
                c.execute("""INSERT INTO account_stats (account_id, metric, label, kind, day, value) VALUES (?, ?, ?, ?, ?, ?)
                             ON CONFLICT(account_id, metric, day) DO UPDATE SET label = excluded.label,
                               kind = excluded.kind, value = excluded.value""",
                          (account_id, slug(label), label, kind, day, _number(p.get("total"))))
        c.execute("""INSERT INTO account_stats_fetch (account_id, fetched_at, error) VALUES (?, ?, NULL)
                     ON CONFLICT(account_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = NULL""",
                  (account_id, now))


async def refresh_accounts(now: float, accounts: list[dict] | None, max_calls: int) -> int:
    listed = accounts
    if listed is None:
        listed = await postiz.list_integrations()
        account_store.claim_new_accounts(listed, now)
    owned = account_store.persona_map()
    fetched = {r["account_id"]: r["fetched_at"] for r in db.rows("SELECT account_id, fetched_at FROM account_stats_fetch")}
    calls = 0
    for a in listed:
        # Only accounts that belong to a model: the rest belong to Fifofarm's people.
        if a.get("disabled") or a.get("identifier") not in ANALYTICS_NETWORKS or a["id"] not in owned:
            continue
        if (fetched.get(a["id"]) or 0) > now - ACCOUNT_REFRESH_S:
            continue
        if calls >= max_calls:
            break
        calls += 1
        try:
            save_account_stats(a["id"], await postiz.account_analytics(a["id"], 30), now)
        except postiz.PostizError as exc:
            if exc.status == 503:
                raise
            db.run("""INSERT INTO account_stats_fetch (account_id, fetched_at, error) VALUES (?, ?, ?)
                      ON CONFLICT(account_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error""",
                   (a["id"], now, str(exc)[:300]))
    return calls


_running: asyncio.Task | None = None


async def run_analytics(*, now: float | None = None, accounts: list[dict] | None = None,
                        max_post_calls: int = MAX_POST_CALLS_PER_RUN) -> None:
    """One run: pick up new posts, refresh what's due, refresh account numbers. Callers share a run."""
    global _running
    if _running is None or _running.done():
        _running = asyncio.create_task(_run(time.time() if now is None else now, accounts, max_post_calls))
    await asyncio.shield(_running)


async def _run(now: float, accounts: list[dict] | None, max_post_calls: int) -> None:
    if not postiz.configured():
        return
    sync_tracked_posts(now)
    failure: Exception | None = None
    try:
        await refresh_posts(now, max_post_calls)
    except Exception as exc:  # noqa: BLE001 - account numbers still get their turn
        failure = exc
    try:
        await refresh_accounts(now, accounts, MAX_ACCOUNT_CALLS_PER_RUN)
    except Exception as exc:  # noqa: BLE001
        failure = failure or exc
    if failure:
        raise failure


async def analytics_loop(every_s: float = 10 * MINUTE, first_after_s: float = 60) -> None:
    await asyncio.sleep(first_after_s)
    while True:
        try:
            await run_analytics()
        except postiz.PostizError as exc:
            if exc.status not in (503, 401, 424):
                log.warning("Analytics refresh failed: %s", exc)
        except Exception as exc:  # noqa: BLE001 - never stop the loop
            log.warning("Analytics refresh failed: %s", exc)
        await asyncio.sleep(every_s)


def mark_due(account_ids: list[str], now: float | None = None) -> None:
    if not account_ids:
        return
    now = time.time() if now is None else now
    marks = db.placeholders(account_ids)
    with db.tx() as c:
        c.execute(f"""UPDATE post_metrics SET next_fetch_at = ? WHERE account_id IN ({marks})
                      AND status IN ('ok', 'no-data', 'waiting', 'error')""", (now, *account_ids))
        c.execute(f"DELETE FROM account_stats_fetch WHERE account_id IN ({marks})", account_ids)


# ---------------------------------------------------------------- reading

def _video_from(row: dict, batch: dict | None, account: dict | None) -> dict:
    media = (batch or {}).get("media") or {}
    return {
        "postId": row["post_id"],
        "batchId": row["batch_id"],
        "accountId": row["account_id"],
        "accountName": (account or {}).get("name", "Removed account"),
        "identifier": row["identifier"],
        "platform": platform_name(row["identifier"]),
        "picture": (account or {}).get("picture"),
        "caption": (batch or {}).get("caption", ""),
        "title": (batch or {}).get("title", ""),
        "previewUrl": media.get("previewUrl"),
        "kind": media.get("kind"),
        "postedAt": row["published_at"] or (batch or {}).get("scheduleAt") or (batch or {}).get("createdAt"),
        "published": bool(row["published_at"]),
        "url": row["url"],
        "views": row["views"],
        "likes": row["likes"],
        "comments": row["comments"],
        "shares": row["shares"],
        "saves": row["saves"],
        "reach": row["reach"],
        "status": row["status"],
        "error": row["error"],
        "fetchedAt": batch_store.iso(row["fetched_at"]) if row["fetched_at"] else None,
        "sourcePath": media.get("sourcePath"),
    }


def _views_per_day(account_ids: list[str], published_by_id: dict[str, str | None], days: int, now: float) -> list[dict]:
    out = {day_of(now - i * DAY): 0 for i in range(days - 1, -1, -1)}
    rows = db.rows(f"""SELECT d.post_id, d.day, d.views FROM post_daily d JOIN post_metrics m ON m.post_id = d.post_id
                       WHERE m.account_id IN ({db.placeholders(account_ids)}) ORDER BY d.post_id, d.day""", account_ids)
    current, previous = None, None
    for r in rows:
        if r["post_id"] != current:
            current, previous = r["post_id"], None
        if r["views"] is None:
            continue
        if previous is None:
            published = batch_store.parse_iso(published_by_id.get(r["post_id"]))
            gained = r["views"] if published is not None and _day_ts(r["day"]) - _day_ts(day_of(published)) <= 2 * DAY else 0
        else:
            gained = max(0, r["views"] - previous)
        previous = r["views"]
        if r["day"] in out:
            out[r["day"]] += gained
    return [{"day": d, "views": v} for d, v in out.items()]


def _network_stats(account_ids: list[str], since_day: str) -> dict[str, list[dict]]:
    rows = db.rows(f"""SELECT account_id, metric, label, kind, day, value FROM account_stats
                       WHERE account_id IN ({db.placeholders(account_ids)}) AND day >= ?
                       ORDER BY account_id, metric, day""", (*account_ids, since_day))
    by_account: dict[str, dict[str, dict]] = {}
    for r in rows:
        metrics = by_account.setdefault(r["account_id"], {})
        m = metrics.setdefault(r["metric"], {"key": r["metric"], "label": r["label"], "kind": r["kind"], "points": []})
        m["label"], m["kind"] = r["label"], r["kind"]
        m["points"].append({"day": r["day"], "value": r["value"]})
    out: dict[str, list[dict]] = {}
    for account_id, metrics in by_account.items():
        lst = []
        for m in metrics.values():
            values = [p["value"] for p in m["points"]]
            change = None
            if m["kind"] == "daily":
                total = sum(values)
                value = total / len(values) if m["key"].startswith("average") else total
            else:
                value = values[-1]
                if len(values) > 1:
                    change = value - values[0]
            lst.append({"key": m["key"], "label": m["label"], "kind": m["kind"], "value": value, "change": change,
                        "points": m["points"]})
        out[account_id] = lst
    return out


def _empty() -> dict:
    return {"videos": 0, "views": 0, "likes": 0, "comments": 0, "shares": 0, "saves": 0}


def _add_to(totals: dict, v: dict) -> None:
    totals["videos"] += 1
    for k in ("views", "likes", "comments", "shares", "saves"):
        totals[k] += v.get(k) or 0


def overview(accounts: list[dict], days: int = 30, now: float | None = None,
             batches: list[dict] | None = None) -> dict:
    """Everything the Analytics page shows for these accounts (one model's) and period."""
    now = time.time() if now is None else now
    batches = batch_store.all_batches() if batches is None else batches
    since = now - days * DAY
    ids = [a["id"] for a in accounts]
    result: dict[str, Any] = {"days": days, "generatedAt": batch_store.iso(now), "lastCheckedAt": None,
                              "totals": _empty(), "daily": [], "accounts": [], "videos": []}
    if not ids:
        result["daily"] = _views_per_day(["-"], {}, days, now)
        return result
    by_batch = {b["id"]: b for b in batches}
    by_account = {a["id"]: a for a in accounts}
    rows = db.rows(f"SELECT * FROM post_metrics WHERE account_id IN ({db.placeholders(ids)})", ids)
    published_by_id = {r["post_id"]: r["published_at"] for r in rows}
    per_account = {a["id"]: {**_empty(), "best": None} for a in accounts}
    last_checked = 0.0
    for row in rows:
        if row["fetched_at"]:
            last_checked = max(last_checked, row["fetched_at"])
        if row["status"] in ("failed", "gone"):
            continue
        video = _video_from(row, by_batch.get(row["batch_id"]), by_account.get(row["account_id"]))
        when = batch_store.parse_iso(video["postedAt"])
        if when is None or when < since:
            continue
        result["videos"].append(video)
        if not video["published"]:
            continue
        _add_to(result["totals"], video)
        acc = per_account.get(row["account_id"])
        if acc is not None:
            _add_to(acc, video)
            if video["views"] is not None and (not acc["best"] or video["views"] > acc["best"]["views"]):
                acc["best"] = {"postId": video["postId"], "views": video["views"]}
    result["videos"].sort(key=lambda v: batch_store.parse_iso(v["postedAt"]) or 0, reverse=True)
    result["lastCheckedAt"] = batch_store.iso(last_checked) if last_checked else None
    result["daily"] = _views_per_day(ids, published_by_id, days, now)
    network = _network_stats(ids, day_of(since))
    fetches = {r["account_id"]: r for r in db.rows(
        f"SELECT * FROM account_stats_fetch WHERE account_id IN ({db.placeholders(ids)})", ids)}
    for a in accounts:
        stats = per_account[a["id"]]
        fetch = fetches.get(a["id"])
        result["accounts"].append({
            "id": a["id"], "name": a["name"], "identifier": a["identifier"],
            "platform": a.get("platform") or platform_name(a["identifier"]),
            "picture": a.get("picture"), "profile": a.get("profile"),
            "ownerId": None, "ownerName": None,
            "supported": a["identifier"] in ANALYTICS_NETWORKS,
            "videos": stats["videos"], "views": stats["views"], "likes": stats["likes"],
            "comments": stats["comments"], "shares": stats["shares"], "saves": stats["saves"],
            "avgViews": round(stats["views"] / stats["videos"]) if stats["videos"] else 0,
            "bestPostId": (stats["best"] or {}).get("postId"),
            "network": network.get(a["id"], []),
            "networkCheckedAt": batch_store.iso(fetch["fetched_at"]) if fetch else None,
            "networkError": fetch["error"] if fetch else None,
        })
    return result


def video_detail(post_id: str, accounts: list[dict], batches: list[dict] | None = None) -> dict | None:
    row = db.row("SELECT * FROM post_metrics WHERE post_id = ?", (post_id,))
    by_account = {a["id"]: a for a in accounts}
    if not row or row["account_id"] not in by_account:
        return None
    batches = batch_store.all_batches() if batches is None else batches
    batch = next((b for b in batches if b["id"] == row["batch_id"]), None)
    history = db.rows("SELECT day, views, likes, comments, shares, saves, reach FROM post_daily "
                      "WHERE post_id = ? ORDER BY day", (post_id,))
    siblings = [
        _video_from(r, batch, by_account.get(r["account_id"]))
        for r in db.rows("SELECT * FROM post_metrics WHERE batch_id = ? AND post_id != ?", (row["batch_id"], post_id))
        if r["account_id"] in by_account
    ]
    try:
        extra = json.loads(row["extra"]) if row["extra"] else {}
    except ValueError:
        extra = {}
    return {"video": _video_from(row, batch, by_account.get(row["account_id"])), "metrics": list(extra.values()),
            "history": history, "siblings": siblings}
