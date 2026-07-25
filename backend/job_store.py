"""
Durable store for import job records — so `GET /api/verify-status/{jobId}` and
`GET /api/download-package/{jobId}` keep working after a backend restart instead
of 404-ing (Maestro's suggestion #1). The registry is otherwise in-memory.

What survives a restart is the job *record* (per-problem state, problemId, error
codes, step log). The background asyncio task that runs the pipeline does NOT — a
job that was still importing when the process died can't be resumed, so it is
marked INTERRUPTED on load (clientAction=retry) and the client resubmits. That is
safe because `onExists=fill` makes a re-import idempotent.

Each job is stored as one JSON blob keyed by jobId. Writes happen on job creation
and once per problem as it reaches a terminal state — small and infrequent, so a
plain synchronous sqlite3 connection is fine. All access is on the event-loop
thread; a lock guards against the rare overlap and lets check_same_thread relax.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import List

DB_PATH = os.path.join(os.path.dirname(__file__), "jobs.sqlite3")

# Drop persisted jobs older than this on load — the registry is a convenience for
# recent retries, not an archive; unbounded growth is the only real risk.
_MAX_AGE_SECONDS = 30 * 24 * 3600

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS jobs ("
            "  job_id  TEXT PRIMARY KEY,"
            "  data    TEXT NOT NULL,"
            "  updated REAL NOT NULL"
            ")"
        )
        _conn.commit()
    return _conn


def save(job: dict) -> None:
    """Upsert a job record. Never raises — persistence is best-effort and must
    never take down a live import."""
    try:
        with _lock:
            conn = _connect()
            conn.execute(
                "INSERT INTO jobs (job_id, data, updated) VALUES (?, ?, ?) "
                "ON CONFLICT(job_id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                (job["jobId"], json.dumps(job), time.time()),
            )
            conn.commit()
    except Exception:
        pass


def load_all() -> List[dict]:
    """Return every persisted job (newest first), pruning stale rows. Never raises
    — a corrupt store should degrade to 'no history', not a failed startup."""
    try:
        with _lock:
            conn = _connect()
            cutoff = time.time() - _MAX_AGE_SECONDS
            conn.execute("DELETE FROM jobs WHERE updated < ?", (cutoff,))
            conn.commit()
            rows = conn.execute("SELECT data FROM jobs ORDER BY updated DESC").fetchall()
        jobs = []
        for (data,) in rows:
            try:
                jobs.append(json.loads(data))
            except Exception:
                continue
        return jobs
    except Exception:
        return []
