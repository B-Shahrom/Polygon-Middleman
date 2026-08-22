"""
Async import jobs — the headless import surface for the Maestro orchestrator.

`POST /api/import-problem` parses+groups the uploaded ZIP(s), creates a job, kicks
off the import pipeline(s) in the background, and returns a job id immediately (it
never blocks for the minutes an import can take). `GET /api/verify-status/{jobId}`
reports per-problem import state plus the LIVE build/verify state, each tagged with
a machine-readable error code and a client action (proceed / success / retry /
wait / halt) so the orchestrator decides retry-vs-halt from the response, not from
log text.

Job records are held in memory but also checkpointed to a small SQLite store
(`job_store.py`) so verify-status / download-package survive a backend restart;
the background pipeline task itself can't be resumed, so a job that was mid-flight
at restart is reloaded as INTERRUPTED (clientAction=retry).
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Dict, List, Optional, Tuple

from polygon_api import call_polygon
from import_pipeline import run_import_pipeline
import job_store

_JOBS: Dict[str, dict] = {}
_SLUG_LOCKS: Dict[str, asyncio.Lock] = {}
# Live background tasks, so a job can be cancelled mid-flight. NOT persisted (a Task
# isn't serializable and doesn't survive a restart anyway).
_TASKS: Dict[str, "asyncio.Task"] = {}


def cancel_job(job_id: str) -> bool:
    """Cancel a running job's background task. Returns True if there was a live task
    to cancel. The task's CancelledError handler marks the unfinished problems
    'cancelled' and persists — nothing is committed to Polygon, so a later re-import
    (fill) is clean."""
    task = _TASKS.get(job_id)
    if task is not None and not task.done():
        task.cancel()
        return True
    return False


def cancel_all() -> int:
    """Cancel every running import task. Returns how many were cancelled."""
    n = 0
    for jid, task in list(_TASKS.items()):
        if task is not None and not task.done():
            task.cancel()
            n += 1
    return n


def _persist(job: dict) -> None:
    """Checkpoint a job to the durable store (best-effort; never raises)."""
    job_store.save(job)


def load_persisted() -> int:
    """Load persisted jobs into memory on startup. Any job still mid-flight when
    the process last died can't have its pipeline task resumed, so mark those
    problems INTERRUPTED (clientAction=retry) — the client resubmits, and
    `onExists=fill` makes that idempotent. Returns the count loaded."""
    loaded = 0
    for job in job_store.load_all():
        interrupted = False
        for prob in job.get("problems", []):
            if prob.get("importState") in ("queued", "running"):
                prob["importState"] = "failed"
                prob["errorCode"] = "INTERRUPTED"
                prob["clientAction"] = "retry"
                prob.setdefault("log", []).append(
                    {"text": "Backend restarted mid-import — resubmit to finish (fill is idempotent)",
                     "status": "error"})
                interrupted = True
        if interrupted:
            job["state"] = "failed"
        elif job.get("state") == "running":
            # No mid-flight problems but never marked done → settle it.
            job["state"] = "done"
        _JOBS[job["jobId"]] = job
        loaded += 1
    return loaded

# Build/verify state → (code, client action). `success` = usable now; `wait` =
# still building, poll again; `halt` = the problem is broken (see comment).
_VERIFY_ACTION = {
    "READY": ("VERIFY_READY", "success"),
    "FAILED": ("VERIFY_FAILED", "halt"),
    "RUNNING": ("VERIFY_RUNNING", "wait"),
    "PENDING": ("VERIFY_PENDING", "wait"),
    "NONE": ("VERIFY_NONE", "wait"),
    # A transient Polygon hiccup while polling packages — keep waiting, don't halt.
    "UNKNOWN": ("VERIFY_UNKNOWN", "wait"),
}

# Fields copied from the internal problem record into the public status response.
_PUBLIC_FIELDS = (
    "slug", "name", "problemId", "importState", "errors", "verifyRequested",
    "alreadyVerified", "errorCode", "clientAction", "testsOnly", "testCount",
    "appliedTimeLimit", "appliedMemoryLimit", "limitsSource", "checkerKind",
)


def _slug_lock(slug: str) -> asyncio.Lock:
    lock = _SLUG_LOCKS.get(slug)
    if lock is None:
        lock = asyncio.Lock()
        _SLUG_LOCKS[slug] = lock
    return lock


def get_job(job_id: str) -> Optional[dict]:
    return _JOBS.get(job_id)


def list_jobs(limit: int = 60, max_age_s: int = 1800) -> List[dict]:
    """Recent jobs (newest first) as public summaries, so the UI can REHYDRATE its
    queue after a reload/remount and keep tracking imports that are still running in
    the backend. Fast (no Polygon query — the caller polls verify-status for live
    build state). Returns jobs that are still importing OR were created within
    `max_age_s`, capped at `limit`."""
    now = time.time()
    out: List[dict] = []
    for job in sorted(_JOBS.values(), key=lambda j: j.get("createdAt", 0), reverse=True):
        importing = job.get("state") == "running"
        recent = (now - job.get("createdAt", 0)) < max_age_s
        if not (importing or recent):
            continue
        problems = []
        for p in job["problems"]:
            rec = {k: p.get(k) for k in _PUBLIC_FIELDS}
            rec["log"] = p.get("log", [])
            problems.append(rec)
        out.append({
            "jobId": job["jobId"], "state": job["state"], "createdAt": job["createdAt"],
            "problems": problems, "parseErrors": job.get("parseErrors", []),
        })
        if len(out) >= limit:
            break
    return out


def job_problem_ids(job_id: str) -> List[int]:
    job = _JOBS.get(job_id)
    if not job:
        return []
    return [p["problemId"] for p in job["problems"] if p.get("problemId")]


def create_job(groups: List[Tuple[str, dict]], opts_common: dict, parse_errors: list,
               api_key: str, api_secret: str, limits_by_slug: Optional[dict] = None,
               checker_by_slug: Optional[dict] = None) -> dict:
    """`groups` = [(slug, merged_parsed_dict), ...]. `limits_by_slug` maps slug →
    {timeLimit, memoryLimit, source} (resolved form>manifest>characteristics>default
    upstream); `checker_by_slug` maps slug → {kind,name,polygonId} for a STANDARD
    checker to set by name (else the archive's checker.cpp is uploaded). Starts the
    background runner and returns the initial (queued) job record."""
    job_id = uuid.uuid4().hex[:16]
    limits_by_slug = limits_by_slug or {}
    checker_by_slug = checker_by_slug or {}
    problems = [{
        "slug": slug,
        "name": merged.get("displayName") or slug,
        "testsOnly": merged.get("testsOnly", False),
        "testCount": len(merged["tests"]),
        "importState": "queued",       # queued → running → imported | failed
        "problemId": None,
        "errors": 0,
        "verifyRequested": False,
        "alreadyVerified": False,
        "errorCode": None,
        "clientAction": None,
        "appliedTimeLimit": None,
        "appliedMemoryLimit": None,
        # Where the applied limits came from (form|manifest|characteristics|default|
        # mixed) — set even before the import runs, since it's resolved at request time.
        "limitsSource": limits_by_slug.get(slug, {}).get("source"),
        # The checker directive in effect: "standard" (set by name) or None (upload
        # the archive's checker.cpp).
        "checkerKind": (checker_by_slug.get(slug) or {}).get("kind"),
        "log": [],
    } for slug, merged in groups]

    job = {
        "jobId": job_id,
        "state": "running",            # running → done | failed
        "createdAt": time.time(),
        "problems": problems,
        "parseErrors": parse_errors,
    }
    _JOBS[job_id] = job
    _persist(job)
    task = asyncio.create_task(_run_job(job, groups, opts_common, api_key, api_secret,
                                        limits_by_slug, checker_by_slug))
    _TASKS[job_id] = task
    task.add_done_callback(lambda _t, jid=job_id: _TASKS.pop(jid, None))
    return job


async def _run_job(job: dict, groups, opts_common: dict, api_key: str, api_secret: str,
                   limits_by_slug: Optional[dict] = None, checker_by_slug: Optional[dict] = None):
    limits_by_slug = limits_by_slug or {}
    checker_by_slug = checker_by_slug or {}
    try:
        for (slug, merged), prob in zip(groups, job["problems"]):
            prob["importState"] = "running"
            async with _slug_lock(slug):  # serialize same-slug across all jobs
                # Per-slug limits (form>manifest>characteristics>default, resolved upstream)
                # override the request-level fallback; a checker directive selects a
                # standard checker instead of uploading the archive's checker.cpp.
                lim = limits_by_slug.get(slug, {})
                opts = {**opts_common, "slug": slug}
                if "timeLimit" in lim:
                    opts["timeLimit"] = lim["timeLimit"]
                if "memoryLimit" in lim:
                    opts["memoryLimit"] = lim["memoryLimit"]
                if slug in checker_by_slug:
                    opts["checker"] = checker_by_slug[slug]
                try:
                    # Pass the problem's own log list as the sink so steps stream into
                    # the job record live (verify-status reads it), not only at the end.
                    res = await run_import_pipeline(merged, opts, api_key, api_secret,
                                                    log_sink=prob["log"])
                except Exception as e:  # pragma: no cover — pipeline is defensive, but never crash the job
                    prob["log"].append({"text": f"Import crashed: {e}", "status": "error"})
                    prob.update(importState="failed", errors=1, errorCode="STEP_FAILED",
                                clientAction="retry")
                    _persist(job)
                    continue
                prob.update(
                    problemId=res.get("problemId"),
                    errors=res.get("errors", 0),
                    verifyRequested=res.get("verifyRequested", False),
                    alreadyVerified=res.get("alreadyVerified", False),
                    errorCode=res.get("errorCode"),
                    clientAction=res.get("clientAction"),
                    appliedTimeLimit=res.get("appliedTimeLimit"),
                    appliedMemoryLimit=res.get("appliedMemoryLimit"),
                    importState="imported" if (res.get("ok") or res.get("alreadyVerified")) else "failed",
                )
                _persist(job)  # checkpoint each problem's terminal state (survives restart)
    except asyncio.CancelledError:
        # Stop requested mid-flight. Mark whatever hadn't finished as cancelled; nothing
        # was committed to Polygon, so a later re-import (fill) is clean.
        for prob in job["problems"]:
            if prob["importState"] in ("queued", "running"):
                prob.update(importState="cancelled", errorCode="CANCELLED", clientAction="halt")
                prob["log"].append({"text": "Cancelled by user", "status": "error"})
        job["state"] = "cancelled"
        _persist(job)
        raise
    job["state"] = "failed" if any(p["importState"] == "failed" for p in job["problems"]) else "done"
    _persist(job)


async def _latest_package(problem_id: int, api_key: str, api_secret: str) -> Tuple[str, str, Optional[int], Optional[int]]:
    """(state, comment, packageId, revision) for the newest package. A transient
    Polygon hiccup (network error, non-JSON/empty body) returns UNKNOWN rather than
    raising — verify-status is polled repeatedly and must never 500 on a blip."""
    try:
        body, _ = await call_polygon("problem.packages", api_key, api_secret, {"problemId": problem_id})
        data = json.loads(body.decode("utf-8", errors="replace"))
    except Exception as e:
        return "UNKNOWN", f"transient: {e}", None, None
    if data.get("status") == "FAILED":
        return "NONE", data.get("comment", ""), None, None
    pkgs = data.get("result") or []
    if not pkgs:
        return "NONE", "", None, None
    latest = max(pkgs, key=lambda k: (k.get("revision", 0), k.get("id", 0)))
    return latest.get("state") or "NONE", latest.get("comment", ""), latest.get("id"), latest.get("revision")


async def verify_status(job_id: str, api_key: str, api_secret: str) -> Optional[dict]:
    job = _JOBS.get(job_id)
    if job is None:
        return None
    out_problems = []
    for p in job["problems"]:
        out = {k: p[k] for k in _PUBLIC_FIELDS}
        verify = None
        # Only query Polygon for a build once the import actually requested one.
        if p.get("problemId") and p.get("verifyRequested"):
            state, comment, pkg_id, revision = await _latest_package(p["problemId"], api_key, api_secret)
            code, action = _VERIFY_ACTION.get(state, ("VERIFY_UNKNOWN", "wait"))
            verify = {"state": state, "code": code, "clientAction": action,
                      "comment": comment, "packageId": pkg_id, "revision": revision}
        out["verify"] = verify
        out["log"] = list(p["log"])  # snapshot — the pipeline may still be appending
        out_problems.append(out)
    return {
        "jobId": job["jobId"],
        "state": job["state"],
        "createdAt": job["createdAt"],
        "problems": out_problems,
        "parseErrors": job["parseErrors"],
    }
