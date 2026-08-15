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
| `TEST_TOO_BIG` | One or more tests exceed Polygon's per-test size cap (~30 MB) — Polygon returns **HTTP 413 Payload Too Large**. Detected on `saveTest`, raised immediately (**never retried** — retrying a 413 can't succeed), excluded from the fill loop; **commit is skipped** (broken testset). The message lists the offending test indices. | `halt` — shrink or split those tests, then re-POST. Retrying as-is fails identically. |
| `VERIFY_REQUEST_FAILED` | Committed, but the `buildPackage` trigger failed (a non-already-verified error). | `retry`. |
| `STEP_FAILED` | A pipeline step errored **after in-pipeline retries** — commit **skipped**. Transient Polygon responses (`503`/`502` unavailable, `429 Too Many Requests`) are retried inside the pipeline (6× exponential backoff, `import_pipeline.py` `_Api.call`; a `429` backs off harder). A single blip no longer reaches here; this code means either a *persistent* transient failure or a genuine content error (e.g. a non-compiling `solution.cpp`). | `retry`, but **cap retries** — a content error won't recover; read `log[]` for the reason. |
| `CREATE_FAILED` | Couldn't create or resolve the problem. | `halt`. |
| `INTERRUPTED` | The backend restarted while this problem was still importing. The pipeline's background task can't be resumed, so the reloaded job marks the in-flight problem failed (`import_jobs.py` `load_persisted`). Completed problems in the same job keep their real state. | `retry` — re-POST; `onExists=fill` makes it idempotent. |
| `CANCELLED` | A caller stopped the import mid-flight via `POST /api/import-cancel/{jobId}` (or `/api/import-cancel-all`). The background task is cancelled at its next await; unfinished problems get this code and `importState: cancelled`. Nothing was committed to Polygon. | `halt` — it was a deliberate stop, don't auto-retry. A human can re-POST to resume (`onExists=fill` is clean). |

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
| Unknown `jobId` | `404` `{"detail":"Unknown jobId: ..."}` on `verify-status`/`download-package`. | `halt` for a **genuinely** unknown id. Jobs now **persist across restart** (SQLite, `job_store.py`; reloaded on startup), so a restart no longer 404s a known job — one that was mid-flight returns with `INTERRUPTED`/`retry` instead. Your resubmit-on-404 override stays valid as a belt-and-braces fallback; it just fires far less often now. |
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

## Time / memory limits — a silent overwrite, and how to confirm

- **Omitting `timeLimit`/`memoryLimit` on `import-problem` applies the SERVER DEFAULT** (`main.py`:
  `timeLimit if timeLimit is not None else settings["default_time_limit"]`), and the import
  **sets** it on Polygon via `problem.updateInfo`. So a caller that leaves the field off does
  **not** get "the archive's limits" — it gets the configured default, written over the top
  (defaults: 1000 ms / 256 MB, `DEFAULT_SETTINGS`). **Always send both explicitly** if the
  problem's limits matter — a wrong limit doesn't fail a build, it silently TLEs correct
  solutions later.
- **The archive format carries no limits.** `zip_parser` extracts statement, checker, solution,
  validator, tests and scoring — there is nowhere in the ZIP that declares TL/ML. `/api/parse`
  therefore reports `timeLimit: null` / `memoryLimit: null` (**null = archive is silent**, never
  the default). The form field on `import-problem` is the only source of a non-default limit.
- **Confirm what landed:** `verify-status.problems[].appliedTimeLimit` / `appliedMemoryLimit`
  report the TL/ML **actually sent to `updateInfo`, recorded only when that call succeeded**
  (`null` if the info step failed, or for a tests-only pack, which never calls `updateInfo`).
  Send `2000` and check `appliedTimeLimit == 2000` on a problem whose `errorCode` is `IMPORTED`
  — that closes the loop instead of sending-and-hoping. (It's the value the middleman sent, not
  a re-read from Polygon; with `errorCode: IMPORTED` the `updateInfo` call returned OK.)
- **Know WHERE the limit came from:** `verify-status.problems[].limitsSource` ∈
  `form | manifest | characteristics | default | mixed`. `form` = an explicit
  `timeLimit`/`memoryLimit` field; `manifest` = an uploaded `MANIFEST.json`; `characteristics`
  = an uploaded `characteristics.md`; `default` = the server default; `mixed` = the two
  dimensions came from different sources. Precedence is always
  **form > manifest > characteristics > default**. This exists so a fallback (usually right)
  can never be silently mistaken for an explicit value — assert the source, not just the number.

### Optional `characteristics.md` travelling with the archives

Upload it as one of the multipart `files` (named `characteristics.md`, or markdown with a
Characteristics heading + General table). Optional; a second authored source of the same facts.

- **Limits.** The General table's per-slug `TL`/`ML` (normalized: `2 s`→2000 ms, `64 MB`→64) feed
  the limit precedence at the `characteristics` tier (below `manifest`, above `default`).
- **Checker.** The `checker` column drives the checker step: `ncmp (native)` sets the **standard**
  testlib checker by name (`setChecker std::ncmp.cpp`, **no upload** — which also sidesteps the
  503-prone `saveFile`); `custom` uploads the archive's `checker.cpp`. `verify-status` reports
  `checkerKind` (`standard` | `null`). Manifest checker wins over characteristics when both exist.
- **`/api/parse`** surfaces a per-problem `characteristics` object `{timeLimit, memoryLimit,
  checker}` and a `resolved` object `{timeLimit, memoryLimit, limitsSource, checker}` — the
  effective decision an import would make (absent a form field), so a caller can preview it.

### Optional `MANIFEST.json` (set descriptor) travelling with the archives

Upload it as one of the multipart `files` (named `MANIFEST.json`, or any `.json` carrying
`schema_version` + `problems`). Optional — absent, everything below is unchanged. Pinned to
`schema_version` `1.0`.

- **Integrity gate.** For every uploaded archive the manifest describes (by filename), the
  Middleman verifies its `sha256` and byte size. A mismatch **drops that archive** and reports it
  in `parseErrors` as `{file, error: "integrity: sha256 mismatch (…)"}` — the problem is NOT
  imported. A second, independent gate to Maestro's own gate-time hash.
- **Limits.** Each `problems[].limits.time_limit_s` (→ ms) / `memory_limit_mb` becomes the
  per-slug limit **when no explicit form field is sent** (`limitsSource: manifest`). An explicit
  form field still wins (`limitsSource: form`).
- **`/api/parse`** surfaces a per-problem `manifest` object when the manifest describes that slug:
  `{timeLimit (ms), memoryLimit (MB), measuredWorstMs, archiveVerified}`. Absent a manifest (or an
  undescribed slug) it is `null`. The archive-derived `timeLimit`/`memoryLimit` stay `null` as
  always — the manifest is a separate, clearly-namespaced source.

## Load & rate limiting (429)

Polygon rate-limits (**HTTP 429 Too Many Requests**) when too many requests fire at once — a
large parallel batch trips it, and each retry adds to the flood. Two guards:

- **App-wide concurrency cap.** `call_polygon` is gated by a semaphore
  (`polygon_api.MAX_CONCURRENT_POLYGON`, default 4), so total concurrent Polygon requests stay
  bounded no matter how many import jobs run in parallel. Raising the UI's "parallel agents"
  above this only queues the surplus behind the gate — it doesn't increase Polygon load.
- **Harder backoff on 429.** A `429` is retried like other transients but with a longer delay,
  so a retry doesn't immediately re-trip the limit. A sustained 429 storm still slows a batch;
  the fix is fewer parallel jobs, not more retries.
