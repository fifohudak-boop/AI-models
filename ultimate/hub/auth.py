"""Accounts, logins and per-model access — the part that lets you share Fifofarm Ultimate.

You run the app on your Mac and open it on localhost; there you are always the owner and never
have to log in. When you turn sharing on, other people reach the app over the internet (through a
tunnel) at the share address, and they must log in. Each person is given one or more models and
sees and controls only those. The owner-only things — the API keys, creating and deleting models,
and inviting people — stay with you.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
import uuid

from . import db

COOKIE = "ult_session"
SESSION_TTL = 60 * 60 * 24 * 30  # 30 days
_ITERATIONS = 200_000
_USERNAME = re.compile(r"^[a-z0-9._-]{3,32}$")

# Anyone reaching the app on localhost is you, on your own Mac: always the owner, sees everything.
# This stand-in never has a database row (there is nothing to look up for it).
OWNER_LOCAL: dict = {"id": "local-owner", "username": "", "name": "You", "role": "owner", "local": True}


class AuthError(ValueError):
    pass


def _now() -> int:
    return int(time.time())


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS).hex()


def _public(row: dict) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
        "role": row["role"],
        "createdAt": row["created_at"],
        "models": [r["model_id"] for r in db.rows("SELECT model_id FROM user_models WHERE user_id = ?", (row["id"],))],
    }


def normalize_username(username: str) -> str:
    cleaned = (username or "").strip().lower()
    if not _USERNAME.match(cleaned):
        raise AuthError("Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.")
    return cleaned


def check_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < 6:
        raise AuthError("Give them a password of at least 6 characters.")
    return password


# ---------------------------------------------------------------- people

def _raw(username: str) -> dict | None:
    return db.row("SELECT * FROM users WHERE username = ?", (username.strip().lower(),))


def get_user(user_id: str) -> dict | None:
    found = db.row("SELECT * FROM users WHERE id = ?", (user_id,))
    return _public(found) if found else None


def list_users() -> list[dict]:
    return [_public(r) for r in db.rows("SELECT * FROM users ORDER BY created_at")]


def create_user(username: str, password: str, name: str = "",
                role: str = "guest", model_ids: list[str] | None = None) -> dict:
    username = normalize_username(username)
    check_password(password)
    if role not in ("owner", "guest"):
        raise AuthError("Unknown role.")
    if _raw(username):
        raise AuthError(f"Someone already uses the username “{username}”.")
    salt = secrets.token_hex(16)
    user_id = uuid.uuid4().hex[:12]
    db.run(
        "INSERT INTO users (id, username, name, role, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, username, (name or "").strip()[:60], role, salt, _hash(password, salt),
         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
    )
    set_access(user_id, model_ids or [])
    user = get_user(user_id)
    assert user is not None
    return user


def set_access(user_id: str, model_ids: list[str]) -> None:
    clean = [m for m in dict.fromkeys(model_ids) if m]
    with db.tx() as c:
        c.execute("DELETE FROM user_models WHERE user_id = ?", (user_id,))
        for model_id in clean:
            c.execute("INSERT OR IGNORE INTO user_models (user_id, model_id) VALUES (?, ?)", (user_id, model_id))


def set_password(user_id: str, password: str) -> None:
    check_password(password)
    salt = secrets.token_hex(16)
    if not db.run("UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?", (salt, _hash(password, salt), user_id)):
        raise AuthError("No such person.")
    db.run("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # make them log in again


def delete_user(user_id: str) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM user_models WHERE user_id = ?", (user_id,))
        c.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        c.execute("DELETE FROM users WHERE id = ?", (user_id,))


def forget_model(model_id: str) -> None:
    """A deleted model should no longer appear in anyone's access."""
    db.run("DELETE FROM user_models WHERE model_id = ?", (model_id,))


def verify(username: str, password: str) -> dict | None:
    row = _raw(username)
    if not row:
        return None
    if hmac.compare_digest(_hash(password, row["pw_salt"]), row["pw_hash"]):
        return _public(row)
    return None


# ---------------------------------------------------------------- sessions

def start_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    db.run("INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
           (token, user_id, now, now))
    return token


def user_for_token(token: str) -> dict | None:
    if not token:
        return None
    row = db.row("SELECT * FROM sessions WHERE token = ?", (token,))
    if not row:
        return None
    if _now() - row["created_at"] > SESSION_TTL:
        db.run("DELETE FROM sessions WHERE token = ?", (token,))
        return None
    db.run("UPDATE sessions SET last_seen = ? WHERE token = ?", (_now(), token))
    return get_user(row["user_id"])


def end_session(token: str) -> None:
    if token:
        db.run("DELETE FROM sessions WHERE token = ?", (token,))


# ---------------------------------------------------------------- access

def allowed_models(user: dict) -> set[str] | None:
    """The models this user may touch, or None for all of them (the owner)."""
    if user.get("role") == "owner":
        return None
    return {r["model_id"] for r in db.rows("SELECT model_id FROM user_models WHERE user_id = ?", (user["id"],))}


def can_access_model(user: dict, model_id: str) -> bool:
    allowed = allowed_models(user)
    return allowed is None or model_id in allowed


# ---------------------------------------------------------------- what each person may call

# No login needed for these.
_PUBLIC = {("POST", "/api/auth/login"), ("POST", "/api/auth/logout"), ("GET", "/api/health")}


def _owner_only(method: str, path: str) -> bool:
    """Things only you (the owner) may do: keys, model management, folders on the Mac, people, sharing,
    and the shared Reel Finder browser/logins. Guests can still run and use their own models."""
    if path == "/api/settings" or path.startswith("/api/settings/"):
        return True
    if path == "/api/models" and method == "POST":
        return True
    if path == "/api/models-order":
        return True
    if path.startswith("/api/models/") and method in ("PUT", "DELETE"):
        return True
    if path in ("/api/pick-folder", "/api/open-folder"):
        return True
    if path == "/api/preferences" and method == "PUT":
        return True
    if path == "/api/studio/rates" and method == "PUT":
        return True
    if path == "/api/sharing" and method == "PUT":
        return True
    if path.startswith("/api/m/") and path.endswith("/studio/key"):
        return True  # a model's Alibaba key is the owner's to set, even for a shared model
    if path.startswith("/api/accounts/") and path.endswith("/model") and method == "PUT":
        return True
    if path.startswith("/api/auth/users"):
        return True
    if path in ("/api/reels/import-logins", "/api/reels/browser/close",
                "/api/reels/open-log", "/api/reels/ollama/pull"):
        return True
    if path.startswith("/api/reels/login/") or path.startswith("/api/reels/selftest/"):
        return True
    return False


def model_in_path(path: str) -> str | None:
    """The model id in a /api/m/<id>/... path, if any."""
    parts = path.split("/")
    if len(parts) >= 4 and parts[1] == "api" and parts[2] == "m":
        return parts[3] or None
    return None


def authorize(user: dict | None, method: str, path: str) -> tuple[int, str] | None:
    """None if the request is allowed, else (status, message)."""
    if (method, path) in _PUBLIC:
        return None
    if user is None:
        return 401, "Please log in."
    if _owner_only(method, path) and user.get("role") != "owner":
        return 403, "Only the owner can do that."
    model_id = model_in_path(path)
    if model_id and not can_access_model(user, model_id):
        return 403, "You don't have access to this model."
    return None
