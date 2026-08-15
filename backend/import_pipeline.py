"""
Import pipeline — a Python port of frontend/src/wizard/zipImport/pipeline.ts and
helpers.ts, driving Polygon directly via call_polygon so a whole problem can be
imported headlessly (create → statements → checker → solution → tests → groups →
commit → build+verify). Behavior mirrors the frontend importer, including the
filename-keyed append/replace test upload, the self-healing fill rounds, and the
tests-only append mode.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Dict, List, Optional

from polygon_api import call_polygon
from statement_parser import derive_dependencies_from_scoring, derive_points_from_scoring
import activity_log as alog


class Logger:
    def __init__(self, sink: Optional[List[Dict]] = None):
        # If a sink list is provided, append/mutate IT directly so a caller
        # holding the same reference (the job's problem record) sees each step
        # as it happens — that's what makes verify-status stream a live log
        # instead of staying empty until the whole pipeline returns.
        self.entries: List[Dict] = sink if sink is not None else []

    def add(self, text: str, status: str = "running"):
        self.entries.append({"text": text, "status": status})

    def update_last(self, status: str, text: Optional[str] = None):
        if not self.entries:
            self.add(text or "", status)
            return
        self.entries[-1]["status"] = status
        if text is not None:
            self.entries[-1]["text"] = text


_EXISTS_RE = re.compile(r"already\s+have|already\s+exists|such\s+problem", re.I)


class PayloadTooLarge(RuntimeError):
    """Polygon returned HTTP 413 — the item (a test, usually) exceeds Polygon's
    per-item size cap (~30 MB). PERMANENT: retrying can never succeed, so this is
    raised immediately and never retried."""


class _Api:
    def __init__(self, api_key: str, api_secret: str):
        self._key = api_key
        self._secret = api_secret

    async def call(self, method: str, params: dict, files: Optional[dict] = None, retries: int = 6):
        """Call Polygon, retrying TRANSIENT failures with EXPONENTIAL backoff.

        Polygon's front intermittently returns an HTML error page instead of JSON —
        `503`/`502` under load, or `429 Too Many Requests` when a big parallel batch
        outruns its rate limit — so a single blip must not fail a whole import. This
        rides over ~50s across 6 tries; a `429` backs off HARDER (retrying a rate
        limit fast only adds to the flood).

        A `413 Payload Too Large` is the exception: the item exceeds Polygon's size
        cap and NO retry can help, so it's raised immediately as PayloadTooLarge — no
        wasted retry budget. A real Polygon `FAILED` (valid JSON) is a genuine error
        and is NOT retried; saveTest/saveFile/saveStatement are idempotent, so retry
        is safe."""
        last = ""
        for attempt in range(retries):
            text = ""
            rate_limited = False
            try:
                body, _ = await call_polygon(method, self._key, self._secret, params, files)
                text = body.decode("utf-8", errors="replace")
                data = json.loads(text)
            except json.JSONDecodeError:                         # HTML error page
                if ("413" in text) or ("Payload Too Large" in text):
                    raise PayloadTooLarge(
                        f"{method}: 413 Payload Too Large — exceeds Polygon's size cap (retrying won't help)")
                snippet = " ".join(text.split())[:100]
                if ("429" in text) or ("Too Many Requests" in text):
                    rate_limited = True
                    last = f"Polygon 429 rate-limited ({snippet})"
                elif ("503" in text) or ("502" in text) or ("Unavailable" in text) or ("Bad Gateway" in text):
                    last = f"Polygon 5xx unavailable ({snippet})"
                else:
                    last = f"non-JSON response ({snippet})"
            except Exception as e:                               # network / transport — transient
                last = f"transport error: {e}"
            else:
                if data.get("status") == "FAILED":
                    raise RuntimeError(data.get("comment", f"{method} failed"))
                return data.get("result")
            if attempt < retries - 1:
                delay = min(2.0 * (2 ** attempt), 20.0)          # 2,4,8,16,20
                if rate_limited:
                    delay = min(delay * 2, 30.0)                 # back off harder on a rate limit
                alog.record("warn", "import",
                            f"{method}: {last} — retrying (attempt {attempt + 2}/{retries}) in {int(delay)}s")
                await asyncio.sleep(delay)
        raise RuntimeError(f"{method}: {last} (after {retries} attempts)")


def _cpp_file(name: str, code: str):
    return {"file": (name, code.encode("utf-8"), "application/octet-stream")}


async def _fetch_existing_tests(api: _Api, pid: int) -> List[Dict]:
    try:
        res = await api.call("problem.tests", {"problemId": pid, "testset": "tests", "noInputs": True})
        return [{"index": t["index"], "description": (t.get("description") or "").strip()} for t in (res or [])]
    except Exception:
        return []


def _plan_test_uploads(existing: List[Dict], incoming: List[Dict]) -> List[Dict]:
    desc_to_index: Dict[str, int] = {}
    max_index = 0
    for e in existing:
        max_index = max(max_index, e["index"])
        if e["description"]:
            desc_to_index[e["description"]] = e["index"]
    used = set()
    plan = []
    for t in incoming:
        key = t["filename"]
        if key and key in desc_to_index and key not in used:
            target = desc_to_index[key]
        else:
            max_index += 1
            target = max_index
        if key:
            used.add(key)
        plan.append({**t, "index": target})
    return plan


async def _save_one_test(api: _Api, pid: int, t: Dict):
    """Returns True (uploaded), "toobig" (413 — exceeds Polygon's size cap, permanent),
    or False (transient failure — worth a fill-round retry)."""
    try:
        params = {
            "problemId": pid, "testset": "tests", "testIndex": t["index"],
            "testInput": t["input"], "testGroup": t["group"],
            "testUseInStatements": t["group"] == "0", "checkExisting": False,
        }
        if t.get("filename"):
            params["testDescription"] = t["filename"]
        await api.call("problem.saveTest", params)
        return True
    except PayloadTooLarge:
        return "toobig"
    except Exception:
        return False


async def _find_missing_tests(api: _Api, pid: int, expected: List[Dict]) -> List[Dict]:
    try:
        res = await api.call("problem.tests", {"problemId": pid, "testset": "tests", "noInputs": True})
        have = {t["index"] for t in (res or [])}
        return [t for t in expected if t["index"] not in have]
    except Exception:
        return []


async def run_import_pipeline(parsed: Dict, opts: Dict, api_key: str, api_secret: str,
                              log_sink: Optional[List[Dict]] = None) -> Dict:
    api = _Api(api_key, api_secret)
    log = Logger(log_sink)
    errors = 0
    slug = opts["slug"]
    tests_only = parsed.get("testsOnly", False)
    # The TL/ML actually applied to the problem via updateInfo — recorded only when
    # that call succeeds, so verify-status can CONFIRM what landed (a caller sends a
    # limit and can check it took, instead of sending and hoping). Stays None for a
    # tests-only pack, which never touches updateInfo.
    applied_limits: Dict[str, Optional[int]] = {"timeLimit": None, "memoryLimit": None}

    async def step(label: str, fn):
        nonlocal errors
        log.add(label, "running")
        clean_label = re.sub(r"\.\.\.$", "", label)  # backslash-free f-string on <3.12
        try:
            msg = await fn()
            done_msg = msg or clean_label
            log.update_last("done", done_msg)
            alog.record("ok", "import", f"{slug}: {done_msg}")
        except Exception as e:
            errors += 1
            log.update_last("error", f"{clean_label} — {e}")
            alog.record("error", "import", f"{slug}: {clean_label} — {e}")

    # 1. Create-or-resolve
    problem_id: Optional[int] = None
    existed = False
    log.add(f'{"Resolving" if tests_only else "Creating"} problem "{slug}"...', "running")
    try:
        res = await api.call("problem.create", {"name": slug})
        problem_id = (res or {}).get("id")
    except Exception as e:
        if _EXISTS_RE.search(str(e)):
            existed = True
        else:
            log.update_last("error", f"Failed to create problem — {e}")
            return _result(False, errors + 1, None, False, log, parsed, opts)

    if not problem_id:
        try:
            res = await api.call("problems.list", {"showDeleted": False})
            all_p = res if isinstance(res, list) else []
            found = next((p for p in all_p if p.get("name") == slug), None) or \
                next((p for p in all_p if str(p.get("name", "")).lower() == slug.lower()), None)
            problem_id = found.get("id") if found else None
        except Exception:
            pass

    if not problem_id:
        log.update_last("error", f'Failed to resolve problem "{slug}"')
        return _result(False, errors + 1, None, False, log, parsed, opts)

    pid = problem_id
    if existed:
        if opts.get("onExists") == "reset" and not tests_only:
            log.update_last("done", f"Exists (#{pid}) — reset & overwrite")
            await step("Discarding working copy...", lambda: _discard(api, pid))
        else:
            log.update_last("done", f'Exists (#{pid}) — {"appending tests" if tests_only else "filling / updating"}')
    else:
        log.update_last("done", f"Created problem #{pid}")

    # Shared: description-keyed test upload with self-healing fill.
    plan: List[Dict] = []
    tests_complete = True
    tests_too_big = False

    async def upload_tests():
        nonlocal plan, tests_complete, tests_too_big
        if not parsed["tests"]:
            return
        async def do():
            nonlocal plan, tests_complete, tests_too_big
            existing = await _fetch_existing_tests(api, pid)
            plan = _plan_test_uploads(existing, parsed["tests"])
            too_big: set = set()          # test indices Polygon rejected as 413 (permanent)
            for t in plan:
                if await _save_one_test(api, pid, t) == "toobig":
                    too_big.add(t["index"])
            # A too-big test can never upload — don't feed it back into the fill loop.
            def _still_missing(found):
                return [t for t in found if t["index"] not in too_big]
            missing = _still_missing(await _find_missing_tests(api, pid, plan))
            rounds = 0
            refilled = 0
            while missing and rounds < 4:
                log.update_last("running", f"Filling {len(missing)} missing test(s) (round {rounds + 1})...")
                for t in missing:
                    r = await _save_one_test(api, pid, t)
                    if r == "toobig":
                        too_big.add(t["index"])
                    elif r:
                        refilled += 1
                missing = _still_missing(await _find_missing_tests(api, pid, plan))
                rounds += 1
            if missing or too_big:
                tests_complete = False
                parts = []
                if too_big:
                    tests_too_big = True
                    parts.append(f"{len(too_big)} test(s) exceed Polygon's size cap (indices "
                                 f"{', '.join(map(str, sorted(too_big)))}) — shrink or split them")
                if missing:
                    parts.append(f"{len(missing)} test(s) still missing after auto-fill "
                                 f"(indices {', '.join(str(t['index']) for t in missing)})")
                raise RuntimeError("; ".join(parts) + ". Skipping commit & verify — fix and retry.")
            existing_idx = {e["index"] for e in existing}
            replaced = sum(1 for t in plan if t["index"] in existing_idx)
            added = len(plan) - replaced
            change = f" ({added} new, {replaced} replaced)" if existing else ""
            filled = f" · auto-filled {refilled}" if refilled else ""
            return f"{len(plan)}/{len(plan)} tests uploaded & verified{change}{filled}"
        await step(f"Uploading {len(parsed['tests'])} tests...", do)

    verify_requested = False
    already_verified = False
    committed = False

    async def commit_and_verify():
        nonlocal errors, verify_requested, already_verified, committed
        if errors == 0 and tests_complete:
            await step("Committing changes...", lambda: _commit(api, pid))
            if errors == 0:
                committed = True
                log.add("Requesting verification (build package)...", "running")
                try:
                    await api.call("problem.buildPackage", {"problemId": pid, "full": False, "verify": True})
                    log.update_last("done", "Verification requested (building in background)")
                    verify_requested = True
                except Exception as e:
                    # Polygon refuses to rebuild a revision that already has a
                    # non-failed verified package. That is NOT a failure — the
                    # package exists and is usable. Treat it as success.
                    if _is_already_verified(str(e)):
                        log.update_last("done", "Already verified for this revision (package exists)")
                        verify_requested = True
                        already_verified = True
                    else:
                        errors += 1
                        log.update_last("error", f"Verification request failed — {e}")
        else:
            log.add("Skipped commit & verify — an earlier step failed (fix and retry)", "error")

    # Tests-only pack: append tests only, leave statement/scoring/groups untouched.
    if tests_only:
        await step("Enabling groups and points...", lambda: _enable(api, pid))
        await upload_tests()
        await commit_and_verify()
        return _result(False, errors, pid, verify_requested, log, parsed, opts,
                       already_verified=already_verified, tests_complete=tests_complete, committed=committed,
                       tests_too_big=tests_too_big)

    # 2. Info
    async def set_info():
        await api.call("problem.updateInfo", {
            "problemId": pid, "inputFile": "stdin", "outputFile": "stdout",
            "interactive": False, "timeLimit": opts["timeLimit"], "memoryLimit": opts["memoryLimit"],
        })
        # Record only after the call returns OK — appliedTimeLimit/appliedMemoryLimit
        # in verify-status then mean "this landed", not "this was attempted".
        applied_limits["timeLimit"] = opts["timeLimit"]
        applied_limits["memoryLimit"] = opts["memoryLimit"]
        return f"Setting problem info (TL={opts['timeLimit']}ms, ML={opts['memoryLimit']}MB)"
    await step(
        f"Setting problem info (TL={opts['timeLimit']}ms, ML={opts['memoryLimit']}MB)...",
        set_info,
    )

    # 3. Statements (+ per-language tutorial)
    langs = list(parsed["languages"].keys())
    if langs:
        async def save_statements():
            with_tut = []
            for code in langs:
                s = parsed["languages"][code]
                tut = parsed["tutorials"].get(code, "")
                if tut:
                    with_tut.append(code)
                params = {
                    "problemId": pid, "lang": code, "encoding": "UTF-8",
                    "name": s["name"], "legend": s["legend"], "input": s["input"], "output": s["output"],
                    "scoring": s["scoring"], "interaction": s["interaction"], "notes": s["notes"],
                }
                if tut:
                    params["tutorial"] = tut
                await api.call("problem.saveStatement", params)
            tut_note = f" · tutorial: {', '.join(with_tut)}" if with_tut else ""
            return f"Statements saved: {', '.join(langs)}{tut_note}"
        await step(f"Saving statements for {len(langs)} language(s)...", save_statements)

    # 4. Checker. A manifest/characteristics directive can select a STANDARD testlib
    # checker, set by name with NO file upload (which also sidesteps the 503-prone
    # saveFile). Otherwise the bespoke checker.cpp from the archive is uploaded.
    checker = opts.get("checker") or {}
    if checker.get("kind") == "standard" and checker.get("polygonId"):
        std_id = checker["polygonId"]
        async def set_std_checker():
            await api.call("problem.setChecker", {"problemId": pid, "checker": std_id})
            return f"Standard checker set: {std_id} (no upload)"
        await step(f"Setting standard checker {std_id}...", set_std_checker)
    elif parsed["checkerCode"]:
        async def save_checker():
            try:
                await api.call("problem.saveFile",
                               {"problemId": pid, "type": "source", "name": "checker.cpp", "sourceType": opts["checkerType"]},
                               _cpp_file("checker.cpp", parsed["checkerCode"]))
            except Exception as e:
                # problem.saveFile has had Polygon-side 503 incidents that leave
                # saveSolution / setChecker working — so a custom checker is stuck
                # while a STANDARD one (set by name) would import. Make that actionable.
                if "503" in str(e) or "unavailable" in str(e).lower():
                    raise RuntimeError(
                        f"{e} — Polygon's file-upload endpoint (saveFile) is down. A standard "
                        "checker (declare it in characteristics.md/MANIFEST.json, e.g. 'ncmp (native)') "
                        "is set by name and avoids saveFile; otherwise retry when Polygon recovers.")
                raise
            await api.call("problem.setChecker", {"problemId": pid, "checker": "checker.cpp"})
            return "Checker uploaded & set"
        await step("Uploading checker.cpp...", save_checker)

    # 4b. Validator
    if parsed["validatorCode"]:
        async def save_validator():
            await api.call("problem.saveFile",
                           {"problemId": pid, "type": "source", "name": "validator.cpp", "sourceType": opts["checkerType"]},
                           _cpp_file("validator.cpp", parsed["validatorCode"]))
            await api.call("problem.setValidator", {"problemId": pid, "validator": "validator.cpp"})
            return "Validator uploaded & set"
        await step("Uploading validator.cpp...", save_validator)

    # 5. Main solution
    if parsed["solutionCode"]:
        await step("Uploading solution.cpp [MA]...", lambda: api.call(
            "problem.saveSolution",
            {"problemId": pid, "name": "solution.cpp", "tag": "MA", "sourceType": opts["solutionType"]},
            _cpp_file("solution.cpp", parsed["solutionCode"]),
        ))

    # 5b. Extra solutions
    if parsed["extraSolutions"]:
        async def save_extras():
            uploaded = 0
            labels = []
            for s in parsed["extraSolutions"]:
                try:
                    await api.call("problem.saveSolution",
                                   {"problemId": pid, "name": s["filename"], "tag": s["tag"], "sourceType": opts["solutionType"]},
                                   _cpp_file(s["filename"], s["code"]))
                    uploaded += 1
                    labels.append(f"{s['filename']} [{s['tag']}]")
                except Exception:
                    pass
            if uploaded == 0:
                raise RuntimeError("all extra solutions failed")
            return f"Extra solutions: {', '.join(labels)}"
        await step(f"Uploading {len(parsed['extraSolutions'])} extra solution(s)...", save_extras)

    # 6. Enable groups & points
    await step("Enabling groups and points...", lambda: _enable(api, pid))

    # 7. Tests
    await upload_tests()

    # 8. Group policies + deps + points (indices come from the plan)
    all_groups = sorted({t["group"] for t in plan}, key=lambda g: int(g))
    if all_groups:
        async def config_groups():
            await _enable(api, pid)
            non_sample = [g for g in all_groups if g != "0"]

            async def set_group_points(group: str, pts: int) -> bool:
                t = next((x for x in plan if x["group"] == group), None)
                if not t:
                    return False
                params = {
                    "problemId": pid, "testset": "tests", "testIndex": t["index"],
                    "testInput": t["input"], "testGroup": group, "testPoints": pts, "checkExisting": False,
                }
                if t.get("filename"):
                    params["testDescription"] = t["filename"]
                await api.call("problem.saveTest", params)
                return True

            if parsed["hasScoring"]:
                dep_map = derive_dependencies_from_scoring(parsed["scoringText"])
                points_map = derive_points_from_scoring(parsed["scoringText"])
                for group in all_groups:
                    deps = dep_map.get(group)
                    params = {"problemId": pid, "testset": "tests", "group": group, "pointsPolicy": "COMPLETE_GROUP"}
                    if deps:
                        params["dependencies"] = ",".join(deps)
                    await api.call("problem.saveTestGroup", params)
                pts_applied = 0
                for group, pts in points_map.items():
                    if await set_group_points(group, pts):
                        pts_applied += 1
                return f"Derived from scoring — deps: {len(dep_map)} group(s), points: {pts_applied} group(s) (COMPLETE_GROUP)"

            last_group = all_groups[-1]
            other_groups = [g for g in all_groups if g != last_group]
            for group in all_groups:
                params = {"problemId": pid, "testset": "tests", "group": group, "pointsPolicy": "COMPLETE_GROUP"}
                if group == last_group and other_groups:
                    params["dependencies"] = ",".join(other_groups)
                await api.call("problem.saveTestGroup", params)
            pts_info = ""
            if non_sample:
                if await set_group_points(non_sample[-1], 100):
                    pts_info = f", 100pts on group {non_sample[-1]}"
            dep_info = f", group {last_group} depends on {','.join(other_groups)}" if other_groups else ""
            return f"Groups configured (COMPLETE_GROUP){dep_info}{pts_info}"
        await step("Configuring group policies...", config_groups)

    # 9 & 10. Commit + verify
    await commit_and_verify()
    return _result(False, errors, pid, verify_requested, log, parsed, opts,
                   already_verified=already_verified, tests_complete=tests_complete, committed=committed,
                   applied_limits=applied_limits, tests_too_big=tests_too_big)


async def _discard(api: _Api, pid: int):
    await api.call("problem.discardWorkingCopy", {"problemId": pid})
    return "Working copy discarded"


async def _commit(api: _Api, pid: int):
    await api.call("problem.commitChanges", {"problemId": pid, "message": "Import via Polygon Middleman"})
    return "Changes committed"


async def _enable(api: _Api, pid: int):
    await api.call("problem.enableGroups", {"problemId": pid, "testset": "tests", "enable": True})
    await api.call("problem.enablePoints", {"problemId": pid, "enable": True})
    return "Groups & points enabled"


# Polygon returns this FAILED when a rebuild is refused because the revision
# already has a non-failed verified package — i.e. success, not failure.
_ALREADY_VERIFIED_RE = re.compile(r"already .*package .*revision|already non-failed package", re.I)


def _is_already_verified(msg: str) -> bool:
    return bool(_ALREADY_VERIFIED_RE.search(msg or ""))


# Per-problem import error codes and the client action each implies.
#   proceed  — imported OK; poll verify-status next.
#   success  — treat as done; the built package is usable now (fetch it).
#   retry    — transient / idempotent; re-running the import is safe.
#   halt     — broken input/config; stop and surface — retrying won't help.
def _classify(pid, errors, verify_requested, already_verified, tests_complete, committed,
              tests_too_big=False):
    if pid is None:
        return "CREATE_FAILED", "halt"
    if already_verified:
        return "IMPORTED_ALREADY_VERIFIED", "success"
    if tests_too_big:
        # A test exceeds Polygon's size cap — re-uploading it will fail identically.
        # Needs the test shrunk/split, so don't tell an orchestrator to retry blindly.
        return "TEST_TOO_BIG", "halt"
    if not tests_complete:
        return "TESTS_INCOMPLETE", "retry"
    if errors == 0:
        return "IMPORTED", "proceed"
    if committed and not verify_requested:
        return "VERIFY_REQUEST_FAILED", "retry"
    return "STEP_FAILED", "retry"


def _result(failed: bool, errors: int, pid: Optional[int], verify_requested: bool,
            log: Logger, parsed: Dict, opts: Dict, *,
            already_verified: bool = False, tests_complete: bool = True, committed: bool = False,
            applied_limits: Optional[Dict[str, Optional[int]]] = None, tests_too_big: bool = False) -> Dict:
    code, action = _classify(pid, errors, verify_requested, already_verified, tests_complete, committed,
                             tests_too_big)
    applied_limits = applied_limits or {"timeLimit": None, "memoryLimit": None}
    return {
        "name": parsed.get("displayName") or opts["slug"],
        "slug": opts["slug"],
        "problemId": pid,
        "ok": (not failed) and errors == 0,
        "failed": failed,
        "errors": errors,
        "verifyRequested": verify_requested,
        "alreadyVerified": already_verified,
        "testsOnly": parsed.get("testsOnly", False),
        "errorCode": code,
        "clientAction": action,
        # The TL/ML actually applied via updateInfo (None if not applied — e.g. a
        # tests-only pack, or the info step failed). Lets the caller confirm limits.
        "appliedTimeLimit": applied_limits["timeLimit"],
        "appliedMemoryLimit": applied_limits["memoryLimit"],
        "log": log.entries,
    }
