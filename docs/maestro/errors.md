# Error taxonomy — Polygon Middleman (Phase 2, async import)

Every failure the async import surface can produce, how it surfaces, and the **client
action** the orchestrator should take. Verified end-to-end against real Polygon
(`import_jobs.py`, `import_pipeline.py`, `backend/main.py`).

**Client actions:** `proceed` (imported OK — poll verify), `success` (usable now — a
package exists, fetch it), `wait` (still building / transient — poll again), `retry`
(idempotent — re-POST the import), `halt` (broken input/config — stop and surface).

**The async endpoint never returns a bare HTTP error for a Polygon-side failure** — it
folds every failure into the job's per-problem `errorCode`/`clientAction`
(`main.py` `import_problem`). (The raw `/api/problem.*` proxy endpoints still pass
Polygon `FAILED` through as HTTP **200** with `status:"FAILED"` in the body —
`main.py:160-165` — read the body there, never the HTTP code.)

## Import result codes — `verify-status.problems[].errorCode` / `clientAction`

| `errorCode` | Meaning | `clientAction` |
|---|---|---|
| `IMPORTED` | Created/filled, committed, build+verify requested. | `proceed` — poll `verify` below. |
| `IMPORTED_ALREADY_VERIFIED` | Committed, but the revision already had a non-failed verified package. **This is the `FAILED`-that-means-success from the C-2 finding — the package is `READY` and usable, NOT a failure.** (`import_pipeline.py` `_is_already_verified`, `_classify`.) | **`success`** — fetch the package. |
| `TESTS_INCOMPLETE` | Tests still missing after 4 fill rounds; **not committed** (`pipeline` gate). | `retry` — re-POST; the fill/append logic completes the gaps (idempotent). |
| `VERIFY_REQUEST_FAILED` | Committed, but the `buildPackage` trigger failed (a non-already-verified error). | `retry`. |
| `STEP_FAILED` | A pipeline step errored — commit **skipped**. Covers a **transient Polygon HTML/non-JSON response** (observed live on `setChecker`) *and* a genuine content error (e.g. a non-compiling `solution.cpp` — Polygon rejects it at `saveSolution`). | `retry`, but **cap retries** — a content error won't recover; read `log[]` for the reason. |
| `CREATE_FAILED` | Couldn't create or resolve the problem. | `halt`. |

## Build/verify codes — `verify-status.problems[].verify.{state,code,clientAction}`

Fetched **live** from Polygon on each `GET /api/verify-status/{jobId}` (`import_jobs.py`
`_latest_package`).

| `state` | `code` | `clientAction` |
|---|---|---|
| `READY` | `VERIFY_READY` | `success` |
| `FAILED` | `VERIFY_FAILED` | `halt` — the problem is broken; `verify.comment` has the reason (free text). |
| `RUNNING` | `VERIFY_RUNNING` | `wait` |
| `PENDING` | `VERIFY_PENDING` | `wait` |
| (no package yet) | `VERIFY_NONE` | `wait` |
| (transient hiccup) | `VERIFY_UNKNOWN` | `wait` — a Polygon blip (network/non-JSON) while polling packages; the poll **does not 500** (`_latest_package` catches it). |

## Transport / request-level (HTTP status)

| Condition | Surface | `clientAction` |
|---|---|---|
| Credentials not configured | `401` `{"detail":"API credentials not configured..."}` (`get_creds`, `main.py:154-156`) on `import-problem`/`verify-status`/`download-package`. | `halt` — `POST /credentials`, then retry. |
| Unknown `jobId` | `404` `{"detail":"Unknown jobId: ..."}` on `verify-status`/`download-package`. | `halt` (jobs are in-memory; lost on restart). |
| `download-package`, no READY package yet | `404` `{"detail":"No READY package for this problem yet."}`. | `wait` — poll `verify-status` until `VERIFY_READY`, then download. |
| `download-package`, multi-problem job w/o `problemId` | `400` `{"detail":"Job produced N problems; pass ?problemId= ..."}`. | `halt` (fix the request — pass `?problemId=`). |
| `download-package`, `problemId` not in job | `400` `{"detail":"problemId does not belong to this job."}`. | `halt`. |
| Malformed multipart (missing `files`) | `422` `{"detail":[{loc,msg,type}...]}`. | `halt`. |
| Parse-unreadable ZIP | `202`, listed in `parseErrors:[{file,error}]`; that problem is skipped. | `halt` (fix the archive). |

## Two things that matter for a resumable orchestrator

- **Retry is per-stage, not global.** Re-running *import* is idempotent — it resolves the
  existing problem by name and fills/overwrites it, reusing the same Polygon id (verified
  live: a re-POST of the same slug reused problem #563710 and re-verified `READY`, no
  duplicate). Re-triggering a *build* directly is **refused** by Polygon
  (already-verified) — but the async design never does that: the import triggers the build
  once, and Maestro only *polls* the package state via `verify-status`. So Maestro never
  hits the raw `buildPackage` already-verified refusal; the one place it can arise (a
  re-import whose revision is already verified) is folded into `IMPORTED_ALREADY_VERIFIED`
  / `success`.
- **`success` is a first-class action, distinct from `proceed`.** `IMPORTED_ALREADY_VERIFIED`
  and `VERIFY_READY` both mean "done, package usable" — do **not** treat either as a failure
  or halt.
