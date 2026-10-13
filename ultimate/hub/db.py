"""Ultimate's own database (one SQLite file in the data folder).

It holds your models, which social account belongs to which model, your post history and
the analytics history. Videos and pictures stay as plain files in your folders.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import DB_FILE

# Each entry upgrades the database by one version. Never edit an entry that has shipped; add one.
MIGRATIONS = [
    """
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      folders TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE persona_accounts (
      account_id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL
    );
    CREATE TABLE pending_connects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      known_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX batches_persona ON batches (persona_id, created_at);
    CREATE TABLE post_metrics (
      post_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      identifier TEXT NOT NULL,
      published_at TEXT,
      url TEXT,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      saves INTEGER,
      reach INTEGER,
      extra TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      error TEXT,
      fetched_at INTEGER,
      next_fetch_at INTEGER
    );
    CREATE INDEX post_metrics_account ON post_metrics (account_id);
    CREATE INDEX post_metrics_due ON post_metrics (next_fetch_at);
    CREATE TABLE post_daily (
      post_id TEXT NOT NULL,
      day TEXT NOT NULL,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      saves INTEGER,
      reach INTEGER,
      PRIMARY KEY (post_id, day)
    );
    CREATE TABLE account_stats (
      account_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      day TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (account_id, metric, day)
    );
    CREATE TABLE account_stats_fetch (
      account_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE studio_jobs (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX studio_jobs_persona ON studio_jobs (persona_id, created_at);
    """,
]

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_path: Path | None = None


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def open_db(path: Path = DB_FILE) -> sqlite3.Connection:
    """Open (and upgrade) the database; tests point it somewhere else."""
    global _conn, _path
    with _lock:
        if _conn is not None:
            _conn.close()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        conn.row_factory = _dict_row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        current = conn.execute("PRAGMA user_version").fetchone()["user_version"]
        for version in range(current, len(MIGRATIONS)):
            conn.execute("BEGIN")
            try:
                _run_script(conn, MIGRATIONS[version])
                conn.execute(f"PRAGMA user_version = {version + 1}")
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        _conn, _path = conn, path
        return conn


def _run_script(conn: sqlite3.Connection, script: str) -> None:
    # executescript() would COMMIT the surrounding transaction; run statement by statement.
    for statement in script.split(";"):
        if statement.strip():
            conn.execute(statement)


def conn() -> sqlite3.Connection:
    if _conn is None:
        open_db()
    assert _conn is not None
    return _conn


def rows(sql: str, params: tuple | list = ()) -> list[dict]:
    with _lock:
        return conn().execute(sql, params).fetchall()


def row(sql: str, params: tuple | list = ()) -> dict | None:
    with _lock:
        return conn().execute(sql, params).fetchone()


def run(sql: str, params: tuple | list = ()) -> int:
    with _lock:
        return conn().execute(sql, params).rowcount


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    with _lock:
        c = conn()
        c.execute("BEGIN")
        try:
            yield c
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise


def kv_get(key: str, fallback: Any = None) -> Any:
    found = row("SELECT value FROM kv WHERE key = ?", (key,))
    if found is None:
        return fallback
    try:
        return json.loads(found["value"])
    except ValueError:
        return fallback


def kv_set(key: str, value: Any) -> None:
    run(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )


def placeholders(items: list | tuple) -> str:
    return ",".join("?" for _ in items) or "NULL"
