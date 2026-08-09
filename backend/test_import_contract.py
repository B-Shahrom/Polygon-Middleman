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
import import_jobs
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
        self.assertEqual(fake.calls.count("problem.tests"), 6)         # capped at `retries` (default 6)

    def test_503_html_is_retried(self):
        # A 503 "Service Temporarily Unavailable" page (the checker-upload symptom)
        # is transient and retried, not surfaced as a genuine failure.
        fake = FakePolygon()
        fake.transient["problem.saveFile"] = 3        # three 503s, then OK
        with FakeTransport(fake):
            api = _Api("k", "s")
            run(api.call("problem.saveFile", {"problemId": 1}))
        self.assertEqual(fake.calls.count("problem.saveFile"), 4)      # 3 retries + success


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

    def test_standard_checker_directive_skips_upload(self):
        # A standard-checker directive sets it by name (setChecker) and does NOT
        # upload — which also sidesteps the 503-prone saveFile.
        opts = {**OPTS, "checker": {"kind": "standard", "name": "ncmp", "polygonId": "std::ncmp.cpp"}}
        res, fake = self._run(zp.parse_zip(make_zip()), opts=opts)
        self.assertTrue(res["ok"])
        self.assertIn("problem.setChecker", fake.calls)
        self.assertNotIn("problem.saveFile", fake.calls)       # no checker.cpp upload

    def test_custom_checker_directive_uploads_from_archive(self):
        opts = {**OPTS, "checker": {"kind": "custom", "name": None, "polygonId": None}}
        res, fake = self._run(zp.parse_zip(make_zip()), opts=opts)
        self.assertTrue(res["ok"])
        self.assertIn("problem.saveFile", fake.calls)          # custom → upload the archive's checker


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


# ── Manifest support ──────────────────────────────────────────────────────────

import hashlib
import manifest as mf

OPTS_COMMON = {"timeLimit": 1000, "memoryLimit": 256, "onExists": "fill",
               "checkerType": "cpp.g++17", "solutionType": "cpp.g++17"}


def make_manifest(slug="edu-demo-problem", archive_bytes=None, *,
                  time_limit_s=2, memory_limit_mb=512, measured_worst_s=0.05,
                  schema_version="1.0", checker=None) -> bytes:
    entry = {
        "idx": 1, "slug": slug,
        "archive": {
            "filename": f"{slug}.zip",
            "sha256": hashlib.sha256(archive_bytes).hexdigest() if archive_bytes is not None else "0" * 64,
            "bytes": len(archive_bytes) if archive_bytes is not None else 0,
        },
        "tests_archive": None,
        "checker": checker,
        "limits": {"time_limit_s": time_limit_s, "memory_limit_mb": memory_limit_mb,
                   "measured_worst_s": measured_worst_s},
    }
    return json.dumps({"schema_version": schema_version, "set": {"name": "t"},
                       "problems": [entry]}).encode()


class TestManifestModule(unittest.TestCase):
    def test_parse_units_seconds_to_ms(self):
        m = mf.parse_manifest(make_manifest(time_limit_s=2, memory_limit_mb=512, measured_worst_s=0.05))
        e = m["problems"]["edu-demo-problem"]
        self.assertEqual(e["timeLimit"], 2000)          # time_limit_s → ms
        self.assertEqual(e["memoryLimit"], 512)         # MB stays MB
        self.assertEqual(e["measuredWorstMs"], 50)      # measured_worst_s → ms

    def test_unsupported_schema_raises(self):
        with self.assertRaises(mf.ManifestError):
            mf.parse_manifest(make_manifest(schema_version="2.0"))

    def test_looks_like_manifest(self):
        self.assertTrue(mf.looks_like_manifest("MANIFEST.json", b"{}"))
        self.assertTrue(mf.looks_like_manifest("x.json", make_manifest()))     # content sniff
        self.assertFalse(mf.looks_like_manifest("problem.zip", make_zip()))    # a ZIP (PK)

    def test_verify_archive_match_mismatch_undescribed(self):
        z = make_zip()
        m = mf.parse_manifest(make_manifest(archive_bytes=z))
        self.assertIsNone(mf.verify_archive(m, "edu-demo-problem.zip", z))              # matches
        self.assertIsNotNone(mf.verify_archive(m, "edu-demo-problem.zip", z + b"x"))    # tampered
        self.assertIsNone(mf.verify_archive(m, "not-in-manifest.zip", z))               # undescribed → skip

    def test_archive_verified_flag(self):
        z = make_zip()
        m = mf.parse_manifest(make_manifest(archive_bytes=z))
        self.assertIs(mf.archive_verified(m, "edu-demo-problem.zip", z), True)
        self.assertIs(mf.archive_verified(m, "edu-demo-problem.zip", z + b"x"), False)
        self.assertIsNone(mf.archive_verified(m, "other.zip", z))     # undescribed
        self.assertIsNone(mf.archive_verified(None, "edu-demo-problem.zip", z))  # no manifest

    def test_resolve_limit_precedence(self):
        self.assertEqual(mf.resolve_limit(2000, 1500, 1000), (2000, "form"))     # form wins
        self.assertEqual(mf.resolve_limit(None, 1500, 1000), (1500, "manifest")) # then manifest
        self.assertEqual(mf.resolve_limit(None, None, 1000), (1000, "default"))  # then default

    def test_resolve_limit_chain_form_manifest_characteristics_default(self):
        chain = lambda f, m, c: mf.resolve_limit_chain(
            [(f, "form"), (m, "manifest"), (c, "characteristics")], 1000)
        self.assertEqual(chain(3000, 2000, 1500), (3000, "form"))
        self.assertEqual(chain(None, 2000, 1500), (2000, "manifest"))
        self.assertEqual(chain(None, None, 1500), (1500, "characteristics"))
        self.assertEqual(chain(None, None, None), (1000, "default"))

    def test_manifest_checker_normalized(self):
        m = mf.parse_manifest(make_manifest(
            checker={"kind": "native", "name": "ncmp", "polygon_id": "std::ncmp.cpp"}))
        self.assertEqual(mf.checker_for(m, "edu-demo-problem"),
                         {"kind": "standard", "name": "ncmp", "polygonId": "std::ncmp.cpp"})
        m2 = mf.parse_manifest(make_manifest(checker={"kind": "custom", "name": None}))
        self.assertEqual(mf.checker_for(m2, "edu-demo-problem")["kind"], "custom")


class TestManifestIntegration(unittest.TestCase):
    def test_manifest_limit_is_applied_and_source_recorded(self):
        # Drives the real create_job → _run_job with a per-slug manifest limit and
        # asserts it lands (appliedTimeLimit) with the source labelled.
        async def go():
            saved = import_jobs._persist
            import_jobs._persist = lambda job: None      # no DB writes in the test
            try:
                with FakeTransport(FakePolygon()):
                    job = import_jobs.create_job(
                        [("edu-demo-problem", zp.parse_zip(make_zip()))],
                        OPTS_COMMON, [], "k", "s",
                        limits_by_slug={"edu-demo-problem":
                                        {"timeLimit": 2000, "memoryLimit": 512, "source": "manifest"}})
                    source_at_creation = job["problems"][0]["limitsSource"]
                    others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
                    await asyncio.gather(*others)
                return source_at_creation, job
            finally:
                import_jobs._persist = saved
        source, job = asyncio.run(go())
        p = job["problems"][0]
        self.assertEqual(source, "manifest")               # set synchronously at creation
        self.assertEqual(p["limitsSource"], "manifest")
        self.assertEqual(p["appliedTimeLimit"], 2000)      # manifest value overrode opts_common
        self.assertEqual(p["appliedMemoryLimit"], 512)


# ── characteristics.md → limits ───────────────────────────────────────────────

import characteristics as ch

CHARACTERISTICS_SAMPLE = (
    "# Characteristics — Test Batch\n\n_desc_\n\n---\n\n## General\n\n"
    "| idx | slug | title | languages | group | tests | subtasks | checker | TL | ML |\n"
    "|-----|------|-------|-----------|-------|-------|----------|---------|-----|------|\n"
    "| 1 | edu-a-school-bag | School Bag | EN | easy | 29 (2+27) | none | ncmp (native) | 1 s | 256 MB |\n"
    "| 2 | edu-a-two-budgets | Two Budgets | EN, RU | medium | 27 (2+25) | none | ncmp (native) | 2 s | 256 MB |\n"
    "| 3 | edu-a-dnc-restore | Memory-Limited | EN | hard | 19 (2+17) | none | custom | 2 s | 64 MB |\n"
    "| 4 | edu-a-segtree | Range Queries | EN | hard | 19 (2+17) | none | ncmp (native) | 3 s | 512 MB |\n"
    "| 5 | edu-a-na | NA Problem | EN | easy | 10 (2+8) | none | ncmp (native) | N/A | 256 MB |\n\n"
    "---\n\n## Example (inside a fence — must be ignored)\n\n"
    "```\n"
    "| idx | slug | title | languages | group | tests | subtasks | checker | TL | ML |\n"
    "|---|---|---|---|---|---|---|---|---|---|\n"
    "| 9 | edu-FAKE | Fake | EN | easy | 1 (1+0) | none | ncmp (native) | 99 s | 9999 MB |\n"
    "```\n"
)


class TestCharacteristics(unittest.TestCase):
    def test_derive_limits_normalized_units(self):
        lim = ch.derive_limits_from_characteristics(CHARACTERISTICS_SAMPLE)
        self.assertEqual(lim["edu-a-school-bag"], {"timeLimit": 1000, "memoryLimit": 256})
        self.assertEqual(lim["edu-a-two-budgets"], {"timeLimit": 2000, "memoryLimit": 256})
        self.assertEqual(lim["edu-a-dnc-restore"], {"timeLimit": 2000, "memoryLimit": 64})
        self.assertEqual(lim["edu-a-segtree"], {"timeLimit": 3000, "memoryLimit": 512})

    def test_na_limit_is_none_not_wrong_number(self):
        lim = ch.derive_limits_from_characteristics(CHARACTERISTICS_SAMPLE)
        self.assertEqual(lim["edu-a-na"], {"timeLimit": None, "memoryLimit": 256})

    def test_fenced_table_is_ignored(self):
        lim = ch.derive_limits_from_characteristics(CHARACTERISTICS_SAMPLE)
        self.assertNotIn("edu-FAKE", lim)          # the code-fence example must not leak in
        self.assertEqual(len(lim), 5)              # exactly the 5 General-table rows

    def test_parse_checker(self):
        self.assertEqual(ch.parse_checker("ncmp (native)"),
                         {"kind": "standard", "name": "ncmp", "polygonId": "std::ncmp.cpp"})
        self.assertEqual(ch.parse_checker("wcmp (native)")["polygonId"], "std::wcmp.cpp")
        self.assertEqual(ch.parse_checker("custom"),
                         {"kind": "custom", "name": None, "polygonId": None})
        self.assertIsNone(ch.parse_checker("N/A"))
        self.assertIsNone(ch.parse_checker(""))

    def test_derive_includes_checker(self):
        d = ch.derive_from_characteristics(CHARACTERISTICS_SAMPLE)
        self.assertEqual(d["edu-a-school-bag"]["checker"]["kind"], "standard")   # "ncmp (native)"
        self.assertEqual(d["edu-a-school-bag"]["checker"]["polygonId"], "std::ncmp.cpp")
        self.assertEqual(d["edu-a-dnc-restore"]["checker"]["kind"], "custom")    # "custom"

    def test_unit_parsers(self):
        self.assertEqual(ch.parse_time_ms("1 s"), 1000)
        self.assertEqual(ch.parse_time_ms("2000 ms"), 2000)
        self.assertEqual(ch.parse_time_ms("1.5 s"), 1500)
        self.assertIsNone(ch.parse_time_ms("N/A"))
        self.assertIsNone(ch.parse_time_ms(""))
        self.assertEqual(ch.parse_memory_mb("256 MB"), 256)
        self.assertEqual(ch.parse_memory_mb("1 GB"), 1024)
        self.assertEqual(ch.parse_memory_mb("64 MB"), 64)
        self.assertIsNone(ch.parse_memory_mb("N/A"))


class TestCancel(unittest.TestCase):
    def test_cancel_marks_job_cancelled_midflight(self):
        async def go():
            saved_persist = import_jobs._persist
            saved_call = import_pipeline.call_polygon
            import_jobs._persist = lambda job: None
            started = asyncio.Event()
            async def hanging(method, k, s, params=None, files=None):
                started.set()
                await asyncio.sleep(3600)      # block until cancelled
            import_pipeline.call_polygon = hanging
            try:
                job = import_jobs.create_job([("edu-demo-problem", zp.parse_zip(make_zip()))],
                                             OPTS_COMMON, [], "k", "s")
                await asyncio.wait_for(started.wait(), timeout=5)   # pipeline is mid-call
                ok = import_jobs.cancel_job(job["jobId"])
                for _ in range(100):           # let the CancelledError handler run
                    await asyncio.sleep(0)
                    if job["state"] == "cancelled":
                        break
                return ok, job
            finally:
                import_jobs._persist = saved_persist
                import_pipeline.call_polygon = saved_call
        ok, job = asyncio.run(go())
        self.assertTrue(ok)
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual(job["problems"][0]["importState"], "cancelled")
        self.assertEqual(job["problems"][0]["errorCode"], "CANCELLED")

    def test_cancel_unknown_or_done_returns_false(self):
        self.assertFalse(import_jobs.cancel_job("no-such-job-id"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
