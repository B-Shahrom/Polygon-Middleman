"""
Import pipeline — a Python port of frontend/src/wizard/zipImport/pipeline.ts and
helpers.ts, driving Polygon directly via call_polygon so a whole problem can be
imported headlessly (create → statements → checker → solution → tests → groups →
commit → build+verify). Behavior mirrors the frontend importer, including the
filename-keyed append/replace test upload, the self-healing fill rounds, and the
tests-only append mode.
"""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional

from polygon_api import call_polygon
from statement_parser import derive_dependencies_from_scoring, derive_points_from_scoring


class Logger:
    def __init__(self):
        self.entries: List[Dict] = []

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


class _Api:
    def __init__(self, api_key: str, api_secret: str):
        self._key = api_key
        self._secret = api_secret

    async def call(self, method: str, params: dict, files: Optional[dict] = None):
        body, _ = await call_polygon(method, self._key, self._secret, params, files)
        text = body.decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
        except Exception:
            raise RuntimeError(f"{method}: non-JSON response ({text[:160]})")
        if data.get("status") == "FAILED":
            raise RuntimeError(data.get("comment", f"{method} failed"))
        return data.get("result")


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


async def _save_one_test(api: _Api, pid: int, t: Dict) -> bool:
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
    except Exception:
        return False


async def _find_missing_tests(api: _Api, pid: int, expected: List[Dict]) -> List[Dict]:
    try:
        res = await api.call("problem.tests", {"problemId": pid, "testset": "tests", "noInputs": True})
        have = {t["index"] for t in (res or [])}
        return [t for t in expected if t["index"] not in have]
    except Exception:
        return []


async def run_import_pipeline(parsed: Dict, opts: Dict, api_key: str, api_secret: str) -> Dict:
    api = _Api(api_key, api_secret)
    log = Logger()
    errors = 0
    slug = opts["slug"]
    tests_only = parsed.get("testsOnly", False)

    async def step(label: str, fn):
        nonlocal errors
        log.add(label, "running")
        try:
            msg = await fn()
            log.update_last("done", msg or re.sub(r"\.\.\.$", "", label))
        except Exception as e:
            errors += 1
            log.update_last("error", f"{re.sub(r'\.\.\.$', '', label)} — {e}")

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

    async def upload_tests():
        nonlocal plan, tests_complete
        if not parsed["tests"]:
            return
        async def do():
            nonlocal plan, tests_complete
            existing = await _fetch_existing_tests(api, pid)
            plan = _plan_test_uploads(existing, parsed["tests"])
            for t in plan:
                await _save_one_test(api, pid, t)
            missing = await _find_missing_tests(api, pid, plan)
            rounds = 0
            refilled = 0
            while missing and rounds < 4:
                log.update_last("running", f"Filling {len(missing)} missing test(s) (round {rounds + 1})...")
                for t in missing:
                    if await _save_one_test(api, pid, t):
                        refilled += 1
                missing = await _find_missing_tests(api, pid, plan)
                rounds += 1
            if missing:
                tests_complete = False
                idxs = ", ".join(str(t["index"]) for t in missing)
                raise RuntimeError(
                    f"{len(missing)}/{len(plan)} test(s) still missing after auto-fill (indices {idxs}). "
                    "Skipping commit & verify — retry to finish."
                )
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
                       already_verified=already_verified, tests_complete=tests_complete, committed=committed)

    # 2. Info
    await step(
        f"Setting problem info (TL={opts['timeLimit']}ms, ML={opts['memoryLimit']}MB)...",
        lambda: api.call("problem.updateInfo", {
            "problemId": pid, "inputFile": "stdin", "outputFile": "stdout",
            "interactive": False, "timeLimit": opts["timeLimit"], "memoryLimit": opts["memoryLimit"],
        }),
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

    # 4. Checker
    if parsed["checkerCode"]:
        async def save_checker():
            await api.call("problem.saveFile",
                           {"problemId": pid, "type": "source", "name": "checker.cpp", "sourceType": opts["checkerType"]},
                           _cpp_file("checker.cpp", parsed["checkerCode"]))
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
                   already_verified=already_verified, tests_complete=tests_complete, committed=committed)


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
def _classify(pid, errors, verify_requested, already_verified, tests_complete, committed):
    if pid is None:
        return "CREATE_FAILED", "halt"
    if already_verified:
        return "IMPORTED_ALREADY_VERIFIED", "success"
    if not tests_complete:
        return "TESTS_INCOMPLETE", "retry"
    if errors == 0:
        return "IMPORTED", "proceed"
    if committed and not verify_requested:
        return "VERIFY_REQUEST_FAILED", "retry"
    return "STEP_FAILED", "retry"


def _result(failed: bool, errors: int, pid: Optional[int], verify_requested: bool,
            log: Logger, parsed: Dict, opts: Dict, *,
            already_verified: bool = False, tests_complete: bool = True, committed: bool = False) -> Dict:
    code, action = _classify(pid, errors, verify_requested, already_verified, tests_complete, committed)
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
        "log": log.entries,
    }
