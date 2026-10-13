"""Which social account belongs to which model.

Accounts live in the posting engine (Postiz), shared with your Fifofarm. Ultimate only remembers
which model each one belongs to. Accounts are connected through the network's sign-in window, so
the new account's id isn't known up front: when you start connecting a network for a model, the
accounts that existed then are remembered, and a new account of that network that shows up
afterwards goes to that model. When it's unclear (two models connecting the same network at once)
it stays unassigned and you pick the model on the Accounts page.
"""

from __future__ import annotations

import json
import time

from . import db

CONNECT_WINDOW_S = 60 * 60  # sign-in links are valid for an hour
GRACE_S = 3 * 60 * 60  # an account can show up a while after its link expired
MAX_OPEN_PER_NETWORK = 5


def _now_iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))


def persona_map() -> dict[str, str]:
    return {r["account_id"]: r["persona_id"] for r in db.rows("SELECT account_id, persona_id FROM persona_accounts")}


def record_pending_connect(persona_id: str, provider: str, known_ids: list[str], now: float | None = None) -> None:
    now = time.time() if now is None else now
    db.run(
        "INSERT INTO pending_connects (persona_id, provider, known_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        (persona_id, provider, json.dumps(known_ids), int(now), int(now + CONNECT_WINDOW_S)),
    )
    # Each connect is good for one account; keep only a model's latest few.
    db.run(
        """DELETE FROM pending_connects WHERE persona_id = ? AND provider = ? AND id NOT IN (
             SELECT id FROM pending_connects WHERE persona_id = ? AND provider = ?
             ORDER BY created_at DESC, id DESC LIMIT ?)""",
        (persona_id, provider, persona_id, provider, MAX_OPEN_PER_NETWORK),
    )


def claim_new_accounts(accounts: list[dict], now: float | None = None) -> list[tuple[str, str]]:
    """Give newly connected accounts to the model that connected them. Returns (account, model) pairs."""
    now = time.time() if now is None else now
    owners = persona_map()
    fresh = [a for a in accounts if a["id"] not in owners]
    if not fresh:
        return []
    db.run("DELETE FROM pending_connects WHERE expires_at < ?", (int(now - GRACE_S - 24 * 3600),))
    pending = [
        {**p, "known": set(json.loads(p["known_ids"])), "used": False}
        for p in db.rows("SELECT * FROM pending_connects WHERE expires_at >= ? ORDER BY created_at, id",
                         (int(now - GRACE_S),))
    ]
    claimed: list[tuple[str, str]] = []
    for account in fresh:
        matches = [p for p in pending if not p["used"] and p["provider"] == account["identifier"]
                   and account["id"] not in p["known"]]
        models = {p["persona_id"] for p in matches}
        if len(models) != 1:
            continue
        match = matches[0]
        match["used"] = True
        db.run("DELETE FROM pending_connects WHERE id = ?", (match["id"],))
        assign(account["id"], match["persona_id"], now)
        claimed.append((account["id"], match["persona_id"]))
    return claimed


def assign(account_id: str, persona_id: str | None, now: float | None = None) -> None:
    if not persona_id:
        db.run("DELETE FROM persona_accounts WHERE account_id = ?", (account_id,))
        return
    db.run(
        """INSERT INTO persona_accounts (account_id, persona_id, assigned_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET persona_id = excluded.persona_id, assigned_at = excluded.assigned_at""",
        (account_id, persona_id, _now_iso(time.time() if now is None else now)),
    )


def accounts_of(persona_id: str, accounts: list[dict]) -> list[dict]:
    owners = persona_map()
    return [a for a in accounts if owners.get(a["id"]) == persona_id]


def label_accounts(accounts: list[dict], names: dict[str, str]) -> list[dict]:
    """Every account, with the model it belongs to (or none)."""
    owners = persona_map()
    out = []
    for a in accounts:
        pid = owners.get(a["id"])
        out.append({**a, "modelId": pid, "modelName": names.get(pid) if pid else None})
    return out
