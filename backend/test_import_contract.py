"""
Contract tests for the headless import surface — the behaviours the Maestro
orchestrator is built against (see docs/maestro/FROM_MAESTRO.md "Contract lock").

Stdlib only (unittest + asyncio) — NO pytest, NO live Polygon. Polygon is replaced
by a stateful fake transport, the same way Maestro tests its own side. Run:

    python test_import_contract.py            # from backend/, with the venv python

Exits non-zero on any failure, so it doubles as a pre-push regression gate.

What it locks:
  - parser: parse_zip (full + tests-only), merge_parsed_group, base_problem_slug
  - classifiers: _classify, _is_already_verified, _plan_test_uploads, iso_639_1
  - transport: _Api.call retries a transient (HTML/non-JSON) response but NOT a
    real Polygon FAILED
  - pipeline: happy path + applied TL/ML, the already-verified→success inversion,
    a failed step skips the commit, tests-only appends
  - job_store: a mid-flight job reloads as INTERRUPTED after a restart
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
import zipfile

# Import the backend modules whether run from backend/ or the repo root.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import import_pipeline
from import_pipeline import (
    _Api, _classify, _is_already_verified, _plan_test_uploads, run_import_pipeline,
)
import zip_parser as zp
from statement_parser import iso_639_1


# ── Fixtures ──────────────────────────────────────────────────────────────────

CHECKER = '#include "testlib.h"\nint main(){return 0;}\n'
SOLUTION = "#include <bits/stdc++.h>\nint main(){}\n"


def make_zip(slug="edu-demo-problem", *, statement=True, checker=True, solution=True,
             tests=(("0", "input_s0_idx0.txt"), ("1", "input_s1_idx0.txt"))) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        if statement:
            z.writestr(f"{slug}/problem_statement.mdx",
                       "**English**\nAdd a and b.\n**Input format**\na b.\n")
        if checker:
            z.writestr(f"{slug}/checker.cpp", CHECKER)
        if solution:
            z.writestr(f"{slug}/solution.cpp", SOLUTION)
        for i, (_grp, name) in enumerate(tests):
            z.writestr(f"{slug}/testset/{name}", f"{i} {i}\n")
    return buf.getvalue()


def make_tests_only_zip(base_slug="edu-demo-problem",
                        names=("input_s0_idx2.txt", "input_s0_idx3.txt")) -> bytes:
    # No statement/checker/solution → parse_zip flags testsOnly. Folder is <slug>-tests.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, name in enumerate(names):
            z.writestr(f"{base_slug}-tests/testset/{name}", f"{i} {i}\n")
    return buf.getvalue()


OPTS = {
    "slug": "edu-demo-problem", "timeLimit": 2000, "memoryLimit": 512,
    "onExists": "fill", "checkerType": "cpp.g++17", "solutionType": "cpp.g++17",
}


# ── Fake Polygon transport ────────────────────────────────────────────────────

class FakePolygon:
    """Stateful stand-in for call_polygon. Tracks saved tests so the pipeline's
    'find missing tests' pass converges, and lets a test inject transient/failed
    responses per method."""

    def __init__(self):
        self.calls: list[str] = []
        self.saved_tests: dict[int, dict[int, str]] = {}   # pid -> {index: description}
        self.next_id = 1000
        self.existing_names: dict[str, int] = {}           # name -> pid (problem.create says "exists")
        self.transient: dict[str, int] = {}                # method -> remaining HTML responses
        self.persistent_fail: dict[str, str] = {}          # method -> FAILED comment
        self.build_already_verified = False

    def _ok(self, result=None):
        return (json.dumps({"status": "OK", "result": result}).encode(), "application/json")

    def _failed(self, comment):
        return (json.dumps({"status": "FAILED", "comment": comment}).encode(), "application/json")

    async def __call__(self, method, key, secret, params=None, files=None):
        self.calls.append(method)
        params = params or {}

        if self.transient.get(method, 0) > 0:            # transient non-JSON blip
            self.transient[method] -= 1
            return (b"<!DOCTYPE html><html>upstream error</html>", "text/html")
        if method in self.persistent_fail:               # genuine Polygon FAILED (valid JSON)
            return self._failed(self.persistent_fail[method])

        if method == "problem.create":
            name = params.get("name")
            if name in self.existing_names:
                return self._failed("You already have such problem")
            self.next_id += 1
            return self._ok({"id": self.next_id})
        if method == "problems.list":
            return self._ok([{"id": pid, "name": n} for n, pid in self.existing_names.items()])
        if method == "problem.tests":
            pid = int(params["problemId"])
            return self._ok([{"index": i, "description": d}
                             for i, d in sorted(self.saved_tests.get(pid, {}).items())])
        if method == "problem.saveTest":
            pid = int(params["problemId"])
            self.saved_tests.setdefault(pid, {})[int(params["testIndex"])] = params.get("testDescription", "")
            return self._ok()
        if method == "problem.buildPackage":
            if self.build_already_verified:
                return self._failed("already non-failed package for this revision with verification")
            return self._ok()
        # updateInfo, saveStatement, saveFile, setChecker, setValidator, saveSolution,
        # enableGroups, enablePoints, saveTestGroup, commitChanges, ...
        return self._ok()


def run(coro):
    return asyncio.run(coro)


class FakeTransport:
    """Context manager that swaps import_pipeline.call_polygon for a fake and
    collapses the retry backoff so the suite stays fast."""
    def __init__(self, fake):
        self.fake = fake
    def __enter__(self):
        self._orig = import_pipeline.call_polygon
        self._orig_sleep = import_pipeline.asyncio.sleep
        import_pipeline.call_polygon = self.fake
        async def _no_sleep(_):  # skip the real backoff delay in tests
            return None
        import_pipeline.asyncio.sleep = _no_sleep
        return self.fake
    def __exit__(self, *a):
        import_pipeline.call_polygon = self._orig
        import_pipeline.asyncio.sleep = self._orig_sleep


# ── Pure functions ────────────────────────────────────────────────────────────

class TestClassifiers(unittest.TestCase):
    def test_classify_matrix(self):
        # (pid, errors, verify_requested, already_verified, tests_complete, committed) -> (code, action)
        self.assertEqual(_classify(None, 0, False, False, True, False), ("CREATE_FAILED", "halt"))
        self.assertEqual(_classify(5, 0, True, True, True, True), ("IMPORTED_ALREADY_VERIFIED", "success"))
        self.assertEqual(_classify(5, 1, False, False, False, False), ("TESTS_INCOMPLETE", "retry"))
        self.assertEqual(_classify(5, 0, True, False, True, True), ("IMPORTED", "proceed"))
        self.assertEqual(_classify(5, 1, False, False, True, True), ("VERIFY_REQUEST_FAILED", "retry"))
        self.assertEqual(_classify(5, 1, False, False, True, False), ("STEP_FAILED", "retry"))

    def test_is_already_verified(self):
        self.assertTrue(_is_already_verified("already non-failed package for this revision with verification"))
        self.assertTrue(_is_already_verified("There is already a package for this revision"))
        self.assertFalse(_is_already_verified("solution.cpp did not compile"))
        self.assertFalse(_is_already_verified(""))

    def test_iso_639_1(self):
        self.assertEqual(iso_639_1("english"), "EN")
        self.assertEqual(iso_639_1("russian"), "RU")
        self.assertEqual(iso_639_1("Chinese"), "ZH")   # case-insensitive
        self.assertIsNone(iso_639_1("klingon"))

    def test_plan_test_uploads_keys_by_description(self):
        existing = [{"index": 1, "description": "a.txt"}, {"index": 2, "description": "b.txt"}]
        incoming = [
            {"filename": "b.txt", "group": "0", "input": "x"},   # → replaces index 2
            {"filename": "c.txt", "group": "0", "input": "y"},   # → new, next index (3)
        ]
        plan = _plan_test_uploads(existing, incoming)
        self.assertEqual(plan[0]["index"], 2)   # matched by description
        self.assertEqual(plan[1]["index"], 3)   # appended past max existing index


class TestParser(unittest.TestCase):
    def test_parse_full_archive(self):
        p = zp.parse_zip(make_zip())
        self.assertEqual(p["problemName"], "edu-demo-problem")
        self.assertFalse(p["testsOnly"])
        self.assertEqual(len(p["tests"]), 2)
        self.assertIn("english", p["languages"])
        self.assertTrue(p["checkerCode"])
        self.assertTrue(p["solutionCode"])

    def test_parse_tests_only(self):
        p = zp.parse_zip(make_tests_only_zip())
        self.assertTrue(p["testsOnly"])
        self.assertEqual(len(p["tests"]), 2)
        self.assertEqual(p["languages"], {})

    def test_base_problem_slug(self):
        self.assertEqual(zp.base_problem_slug("edu-demo-problem-tests"), "edu-demo-problem")
        self.assertEqual(zp.base_problem_slug("edu-demo-problem-tests-2"), "edu-demo-problem")
        self.assertEqual(zp.base_problem_slug("edu-demo-problem"), "edu-demo-problem")

    def test_merge_main_plus_tests_pack(self):
        main = zp.parse_zip(make_zip())
        pack = zp.parse_zip(make_tests_only_zip())
        merged = zp.merge_parsed_group([main, pack])
        self.assertEqual(len(merged["tests"]), 4)          # 2 + 2 pooled
        self.assertTrue(merged["checkerCode"])             # main's components survive
        # indices are re-numbered contiguously across the pool
        self.assertEqual([t["index"] for t in merged["tests"]], [1, 2, 3, 4])


# ── Transport retry ───────────────────────────────────────────────────────────

class TestApiRetry(unittest.TestCase):
    def test_transient_html_is_retried_then_succeeds(self):
        fake = FakePolygon(); fake.transient["problem.saveFile"] = 2   # 2 HTML, then OK
        with FakeTransport(fake):
            api = _Api("k", "s")
            run(api.call("problem.saveFile", {"problemId": 1}))
        self.assertEqual(fake.calls.count("problem.saveFile"), 3)      # 2 retries + success

    def test_real_failed_is_not_retried(self):
        fake = FakePolygon(); fake.persistent_fail["problem.saveSolution"] = "did not compile"
        with FakeTransport(fake):
            api = _Api("k", "s")
            with self.assertRaises(RuntimeError):
                run(api.call("problem.saveSolution", {"problemId": 1}))
        self.assertEqual(fake.calls.count("problem.saveSolution"), 1)  # FAILED = genuine, no retry

    def test_persistent_transient_raises_after_retries(self):
        fake = FakePolygon(); fake.transient["problem.tests"] = 99     # always HTML
        with FakeTransport(fake):
            api = _Api("k", "s")
            with self.assertRaises(RuntimeError):
                run(api.call("problem.tests", {"problemId": 1}))
        self.assertEqual(fake.calls.count("problem.tests"), 3)         # capped at `retries`


# ── Pipeline (fake transport) ─────────────────────────────────────────────────

class TestPipeline(unittest.TestCase):
    def _run(self, parsed, opts=None, fake=None):
        fake = fake or FakePolygon()
        with FakeTransport(fake):
            res = run(run_import_pipeline(parsed, opts or OPTS, "k", "s"))
        return res, fake

    def test_happy_path_and_applied_limits(self):
        res, fake = self._run(zp.parse_zip(make_zip()))
        self.assertTrue(res["ok"])
        self.assertEqual(res["errorCode"], "IMPORTED")
        self.assertEqual(res["clientAction"], "proceed")
        self.assertTrue(res["verifyRequested"])
        self.assertEqual(res["appliedTimeLimit"], 2000)     # §1.1 confirmation field
        self.assertEqual(res["appliedMemoryLimit"], 512)
        self.assertIn("problem.commitChanges", fake.calls)  # committed
        self.assertIn("problem.buildPackage", fake.calls)   # verify requested

    def test_already_verified_is_success_not_failure(self):
        fake = FakePolygon(); fake.build_already_verified = True
        res, _ = self._run(zp.parse_zip(make_zip()), fake=fake)
        self.assertTrue(res["alreadyVerified"])
        self.assertEqual(res["errorCode"], "IMPORTED_ALREADY_VERIFIED")
        self.assertEqual(res["clientAction"], "success")
        self.assertTrue(res["verifyRequested"])

    def test_failed_step_skips_commit(self):
        fake = FakePolygon(); fake.persistent_fail["problem.saveSolution"] = "did not compile"
        res, fake = self._run(zp.parse_zip(make_zip()), fake=fake)
        self.assertFalse(res["ok"])
        self.assertGreater(res["errors"], 0)
        self.assertEqual(res["errorCode"], "STEP_FAILED")
        self.assertEqual(res["clientAction"], "retry")
        self.assertNotIn("problem.commitChanges", fake.calls)   # the whole point: no commit on error
        self.assertNotIn("problem.buildPackage", fake.calls)

    def test_tests_only_appends_without_statement(self):
        parsed = zp.parse_zip(make_tests_only_zip())
        opts = {**OPTS, "slug": "edu-demo-problem"}
        res, fake = self._run(parsed, opts=opts)
        self.assertTrue(res["testsOnly"])
        self.assertNotIn("problem.updateInfo", fake.calls)      # tests-only never touches info
        self.assertIsNone(res["appliedTimeLimit"])             # → applied limits stay None
        self.assertIn("problem.saveTest", fake.calls)

    def test_existing_problem_is_reused_not_duplicated(self):
        fake = FakePolygon(); fake.existing_names["edu-demo-problem"] = 777
        res, fake = self._run(zp.parse_zip(make_zip()), fake=fake)
        self.assertEqual(res["problemId"], 777)                # resolved via problems.list
        self.assertIn("problems.list", fake.calls)


# ── job_store persistence ─────────────────────────────────────────────────────

class TestJobStore(unittest.TestCase):
    def test_mid_flight_job_reloads_interrupted(self):
        import job_store
        import import_jobs
        job_store.DB_PATH = os.path.join(tempfile.gettempdir(), "jobs_contract_test.sqlite3")
        job_store._conn = None
        if os.path.exists(job_store.DB_PATH):
            try:
                os.remove(job_store.DB_PATH)
            except OSError:
                pass
        job = {"jobId": "j1", "state": "running", "createdAt": 1.0, "parseErrors": [],
               "problems": [
                   {"slug": "x", "importState": "running", "errorCode": None,
                    "clientAction": None, "problemId": None, "log": []},
                   {"slug": "y", "importState": "imported", "errorCode": "IMPORTED",
                    "clientAction": "proceed", "problemId": 5, "log": []},
               ]}
        job_store.save(job)
        import_jobs._JOBS.clear()
        n = import_jobs.load_persisted()
        self.assertGreaterEqual(n, 1)
        j = import_jobs.get_job("j1")
        self.assertEqual(j["problems"][0]["importState"], "failed")
        self.assertEqual(j["problems"][0]["errorCode"], "INTERRUPTED")
        self.assertEqual(j["problems"][0]["clientAction"], "retry")
        self.assertEqual(j["problems"][1]["importState"], "imported")   # completed sibling preserved
        self.assertEqual(j["state"], "failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
