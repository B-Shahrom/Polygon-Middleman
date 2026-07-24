# Maestro ↔ Polygon Middleman — Integration Manual (Phase 1)

Documentation only. Every claim is cited to `file:line` in this repo at the commit that adds
this doc. Where something does not exist it says **NOT IMPLEMENTED**; where it could not be
verified it says **UNVERIFIED — <what to check>**. No credential values appear here.

Scope note: an HTTP-driven import path **already exists** (`POST /api/import/problem` and
friends, added before this doc). This manual documents **what is there today**, including its
limits, rather than the Phase-2 target contract (`/api/import-problem`, job ids). Where the two
differ, it is flagged.

Line numbers are from: `backend/main.py`, `backend/import_pipeline.py`, `backend/zip_parser.py`,
`backend/statement_parser.py`, `backend/activity_log.py`, `backend/polygon_api.py`,
`frontend/src/wizard/zipImport/pipeline.ts`, `frontend/src/wizard/zipImport/useImportQueue.ts`,
`frontend/src/api/client.ts`, `frontend/src/types/polygon.ts`.

---

## §1 Runtime and configuration

**Start the backend** (the only thing Maestro needs; the React frontend is **not** required for
headless import):

```
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Cited: `start_backend.bat:14`, `start_backend.sh:21`, `.claude/launch.json` (`runtimeArgs`:
`["-m","uvicorn","main:app","--host","127.0.0.1","--port","8000","--reload","--app-dir","backend"]`).
The launcher also creates a venv and runs `pip install -r requirements.txt` on first run
(`start_backend.bat`, `start_backend.sh`).

**Frontend** (`Vite` on `:5173`, `.claude/launch.json`) is a human UI only. None of the HTTP
endpoints require it.

**Bind address / port:** `127.0.0.1:8000`. Configurable via the `--host`/`--port` uvicorn args
(`start_backend.bat:14`). It binds loopback deliberately — see Auth.

**Auth: there is NONE on the HTTP surface.** Confirmed:
- No auth dependency/middleware on any route. The only credential check is `get_creds()`
  (`backend/main.py:154`), which raises `401` **only if `config.json` lacks `api_key`/`api_secret`**
  — it does not authenticate the *caller*.
- CORS is restricted to `http://localhost:5173`, `http://localhost:3000`, `http://127.0.0.1:5173`
  (`backend/main.py:64-69`). CORS is **browser-enforced only** — a server-side client (curl, a
  Maestro process) is not subject to it. So Maestro has no auth barrier.
- The only protection is the loopback bind (`--host 127.0.0.1`), so reach it over a private
  network (e.g. Tailscale), never a public port.

**Config file** = `backend/config.json` (`backend/main.py:136`, gitignored). `load_config()`
default is `{"api_key": "", "api_secret": ""}` (`backend/main.py:139-143`). Keys the app reads/writes
(**names and types only**):

| Key | Type | Required | Notes |
|---|---|---|---|
| `api_key` | string | **Yes** (for any Polygon call) | `get_creds()` 401s if empty (`main.py:154-156`). |
| `api_secret` | string | **Yes** | Same. |
| `username` | string | No | Display only (`main.py:176`). |
| `cf_login` | string | No | Codeforces web login for contest automation (`main.py:177`). |
| `cf_password` | string | No | Write-only; never returned (`main.py:172,197`). Not used by import. |
| `default_settings` | object | No | Import defaults (below) (`main.py:224,234`). |

`default_settings` sub-keys and defaults (`DEFAULT_SETTINGS`, `backend/main.py:210-218`):
`enable_groups` (bool), `enable_points` (bool), `checker_source_type` (string, default
`cpp.gcc14-64-msys2-g++23`), `solution_source_type` (string, default `cpp.g++17`),
`default_time_limit` (int ms, default `1000`), `default_memory_limit` (int MB, default `256`).
The import endpoint reads these via `_import_defaults()` (`backend/main.py:701-704`).

**Health / readiness:** `GET /health` → `{"status":"ok"}` (`backend/main.py:203-205`).
⚠️ It returns `ok` even when credentials are **not** configured — credential-dependent calls then
`401`. To confirm creds are set, use `GET /credentials` → `has_secret` (bool) + non-empty `api_key`
(`backend/main.py:170-179`), or `GET /api/logs` → `server.credentials_set` (`backend/main.py:112`,
`_server_status` `backend/main.py:101`).

**Python / deps / host:** Python **3.13** (venv `3.13.14`); the code uses `str | None` unions so
**3.10+** is required. Dependency manager: `pip` + venv. `requirements.txt`: `fastapi`,
`uvicorn[standard]`, `httpx`, `python-multipart`, `python-dotenv`, `requests`, `playwright`.
`playwright install chromium` browsers are needed **only** for contest automation, **not** for
import. `python-multipart` is required for the multipart `POST /api/import/problem`.

---

## §2 Endpoint inventory

There are **64 paths** (see `docs/maestro/openapi.json`, generated from `main.app.openapi()`,
OpenAPI `3.1.0`). Categories:

- **Activity log:** `GET /`, `GET /api/logs`, `GET /api/logs.txt`, `POST /api/logs/clear`
  (`main.py:106,112,117,130`).
- **Credentials / settings:** `GET|POST /credentials` (`main.py:170,182`), `GET|POST /settings`
  (`main.py:221,229`).
- **Health:** `GET /health` (`main.py:203`).
- **~45 Polygon proxy endpoints:** `GET /api/problems.list`, `POST /api/problem.create`, and the
  full `problem.*` surface (`main.py:257-693`). Each forwards to Polygon via `proxy()`
  (`main.py:160-165`).
- **Headless import:** `POST /api/import/problem`, `GET /api/import/verify/{problemId}`,
  `GET /api/import/package/{problemId}` (`main.py:716,772,788`).
- **Contest:** `GET /api/contest.problems` (read; `main.py:808`), and browser-automation
  `POST /api/automation/contest/{list,create,add}` (`main.py:854,865,879`).

**Request schemas:** captured in `openapi.json`. `POST /api/import/problem` is `multipart/form-data`
(`files: List[UploadFile]` + `timeLimit`, `memoryLimit`, `onExists`, `checkerType`, `solutionType`
form fields — `main.py:716-724`).

**Response schemas — important caveat:** the `problem.*` proxy endpoints return Polygon's **raw JSON
body** as-is (`proxy()` returns `Response(content=body, media_type=content_type)`, `main.py:160-165`).
FastAPI does not model those responses, so `openapi.json` shows only generic `200`/`422` with **no
response body schema** for them. The prose here is the source of truth for their shapes.

**Error body shape:**
- FastAPI `HTTPException` → `{"detail": "..."}` (e.g. `get_creds` 401 detail at `main.py:156`;
  `_packages` 400 at `main.py:711-712`; `import_package` 404 at `main.py:794`).
- ⚠️ **Polygon FAILED is passed through with HTTP 200.** `proxy()` does not translate Polygon errors
  (`main.py:160-165`); a failed Polygon call returns HTTP 200 with body `{"status":"FAILED","comment":
  "..."}`. **Maestro must inspect the body's `status`, not the HTTP code, for every `/api/problem.*`
  and `/api/problems.list` call.** (The frontend does this in `handleResponse`, `client.ts:86-106`.)
- The **import** endpoints do fold Polygon failures into their own response instead: per-step
  failures become `results[].errors` + a per-step `log` (see §3/§9), returned with HTTP 200.

**Browser-only endpoints:** none. No endpoint uses a session cookie or a browser-held multi-step
flow. The browser-only logic lives in the **React app** (the import wizard/queue), not in an
endpoint — and its core (the import pipeline) is now also reachable headlessly via `/api/import/*`.
The contest-automation endpoints are HTTP-callable but launch a real Chromium and need a human for
the first Cloudflare/login (`backend/contest_automation.py`) — see §10.

---

## §3 The import pipeline — step by step

Canonical implementation: `frontend/src/wizard/zipImport/pipeline.ts` → `runImportPipeline`
(`pipeline.ts:25`). A faithful backend port exists: `backend/import_pipeline.py` →
`run_import_pipeline` (`import_pipeline.py:112`), driven by `POST /api/import/problem`
(`main.py:716`). Citations below give the frontend line and note the backend equivalent.

**Ordered Polygon calls (non-tests-only problem):**

1. **create-or-resolve** — `problem.create {name: slug}` (`pipeline.ts:50`; `import_pipeline.py:135`).
   If it throws matching `/already\s+have|already\s+exists|such\s+problem/i` → treat as *existing*
   (`pipeline.ts:54`; `import_pipeline.py:41`); any other create error is fatal and returns
   immediately (`pipeline.ts:57-58`). If no id yet → `problems.list` and match `name === slug`
   (case-insensitive) (`pipeline.ts:61-68`; `import_pipeline.py:145-153`). Still none → fatal
   (`pipeline.ts:70-73`).
2. **exists handling** — `onExists === 'reset'` **and not** tests-only → `problem.discardWorkingCopy`
   (`pipeline.ts:78-83`); otherwise fill/update in place (`pipeline.ts:84-86`).
3. **updateInfo** — `inputFile=stdin, outputFile=stdout, interactive=false, timeLimit, memoryLimit`
   (`pipeline.ts:165-168`; `import_pipeline.py` step 2).
4. **saveStatement** per language, including the `tutorial` field when a tutorial was parsed
   (`pipeline.ts` step 3; `import_pipeline.py` "Statements").
5. **saveFile `checker.cpp`** (`type=source`, `sourceType=checkerType`) then **setChecker**
   (`pipeline.ts` step 4). Optional **validator.cpp** + **setValidator** (step 4b).
6. **saveSolution `solution.cpp` tag `MA`** (step 5); extra tagged solutions (step 5b).
7. **enableGroups('tests', true)` + `enablePoints(true)`** (`pipeline.ts` step 6;
   `import_pipeline.py` `_enable`).
8. **tests** — fetch existing, plan by filename, upload, self-heal (see below).
9. **saveTestGroup** per group: `pointsPolicy=COMPLETE_GROUP`; dependencies + points derived from the
   scoring section (`deriveDependenciesFromScoring`/`derivePointsFromScoring`,
   `statement_parser.py:derive_dependencies_from_scoring`), else the fallback (last group depends on
   all others; 100 pts on the last non-sample group) (`pipeline.ts` step 8).
10. **commitChanges** (message `"Import via Polygon Middleman"`) — **only if `errors === 0 &&
    testsComplete`** (`pipeline.ts:128-133`).
11. **buildPackage(pid, full=false, verify=true)** — **only if `errors` still 0** (`pipeline.ts:134-144`).

**What each step checks / does on failure:** each step is wrapped by `step()`
(`pipeline.ts:28-43`; `import_pipeline.py:78-89`). On throw it does `errors++`, logs `error`, and
**continues** — it does not abort the pipeline. The single exception is the create failure, which
returns immediately (`pipeline.ts:57-58`). Commit and verify are gated on `errors === 0`
(`pipeline.ts:129,134`); if any earlier step failed, commit+verify are **skipped** and it logs
"Skipped commit & verify — an earlier step failed" (`pipeline.ts:145-146`).

**Where state lives between steps:** local variables only — `problemId`/`pid`, `plan`, `errors`,
`testsComplete`, `verifyRequested` (`pipeline.ts:46,75,92-93,127`). Nothing is persisted; in the
frontend these live in **browser memory**. A backend port reconstructs `pid` via create-or-resolve
and holds the same locals (`import_pipeline.py`), so **no browser-held state needs reconstructing** —
Polygon itself holds the per-problem working copy.

**Tests: filename-keyed append/replace.** `fetchExistingTests` → `planTestUploads` → `saveOneTest`
loop → `findMissingTests` + up to **4** fill rounds (`pipeline.ts:94-124`;
`import_pipeline.py:_plan_test_uploads`/`_fetch_existing_tests`/`_save_one_test`/`_find_missing_tests`).
Each test is saved with `checkExisting:false` and `testDescription = <its testset filename>`
(`import_pipeline.py:_save_one_test`). `planTestUploads` **replaces** the test whose filename matches
an existing description, else **appends** at `max index + 1` (`import_pipeline.py:_plan_test_uploads`).
If tests are still missing after 4 rounds, `testsComplete=false` and commit/verify are skipped
(`pipeline.ts:110-116`).

**Multi-archive test packs & the `<slug>-tests` convention:**
- Grouping key: for a **tests-only** archive it is `base_problem_slug(slug)`, else the slug itself
  (`main.py:753-757`; frontend `ZipImport.tsx handleQueue`).
- `base_problem_slug` strips a trailing `-tests`/`-test` (optionally numbered) via regex
  `[-_]tests?(?:[-_]?\d+)?$` (`zip_parser.py:base_problem_slug`; frontend `merge.ts:baseProblemSlug`).
- **tests-only** = an archive with tests but **no** statement/checker/solution/validator/extra
  (`zip_parser.py` `tests_only = ...`; frontend `parseZip.ts`).
- Same-slug archives are merged: statement/checker/solution from the "main" archive; tests pooled
  from all and re-sorted by `(group, global index-from-filename)` (`zip_parser.py:merge_parsed_group`).
- **If the base problem is absent:** create-or-resolve **creates** it (a fresh, empty problem), then
  the tests-only branch appends tests and commits — yielding a problem with tests but **no
  statement/checker/solution** (`pipeline.ts:151-162`; `import_pipeline.py` tests-only branch). It
  does **not** error or skip.

**Idempotency:** re-running an import for an existing slug does **not** duplicate. `problem.create`
throws "already have" → resolve by name → fill (default): statements/checker/solution are
overwritten, tests are replaced-by-filename or appended, and a **new commit + build** is made. So a
re-run is an **overwrite/fill that produces a new revision**, not a no-op and not a duplicate
(`pipeline.ts:54,66`; `import_pipeline.py:_plan_test_uploads`).

**Rollback:** **NOT IMPLEMENTED.** There is no rollback on partial failure. Because commit is gated
(`pipeline.ts:129`), a mid-pipeline failure leaves the problem's **working copy** holding whatever
partial changes succeeded, **uncommitted**; the last committed revision is untouched.
`discardWorkingCopy` is only called on the explicit `onExists:'reset'` path (`pipeline.ts:80`), never
as error recovery.

---

## §4 Build and verify

**Build call:** `buildPackage(pid, full=false, verify=true)` → `POST /api/problem.buildPackage
{problemId, full:false, verify:true}` (`pipeline.ts:137`; `client.ts:272-273`; `main.py:678-685`;
`import_pipeline.py` commit+verify). `verify=true` runs solutions on tests; `full=false` builds the
partial package.

**Polling:**
- Frontend: `setInterval(poll, 4000)` → `problem.packages` → newest by `creationTimeSeconds` → done
  when `state === 'READY' || 'FAILED'` (`useImportQueue.ts:106-122`).
- Headless: `GET /api/import/verify/{problemId}` → `problem.packages` → newest by `(revision, id)` →
  returns `{state, packageId, revision, type, comment}` (`main.py:772-785`).

**Status values (the full set):** `PENDING | RUNNING | READY | FAILED` (`types/polygon.ts:89`). The
headless verify endpoint adds `NONE` when no package exists yet (`main.py:777`). So Maestro should
handle: `NONE`, `PENDING`, `RUNNING`, `READY`, `FAILED`.

**Duration / timeout:** **UNVERIFIED — no measured build durations.** No timeout is imposed anywhere:
the verify endpoint is a single poll (`main.py:772`); the frontend poller loops every 4 s with **no
max attempts / deadline** until `READY`/`FAILED` or the component unmounts (`useImportQueue.ts:120`).
**Maestro must impose its own timeout.** (Data point: a real `standard` package for one problem was
67 MB with 194 test files and compiled binaries — see §5 — so builds are non-trivial.)

**On FAILED — where the reason lives:** the package object's `comment` field, surfaced by the verify
endpoint as `comment` (`main.py:784`; `useImportQueue.ts:115` reads `latest.comment`). It is
**free-text, not structured/machine-readable**. **UNVERIFIED — whether a fuller verify log is
fetchable via the API;** `problem.packages` returns `comment` only, and no separate verify-log
endpoint exists in this app.

**Transient vs. broken:** **NOT IMPLEMENTED.** Nothing in this app distinguishes a transient Polygon
error from a genuinely broken problem. On `FAILED`, Maestro would have to inspect `comment` text
itself; there is no classification here.

---

## §5 Package download and extraction — the hand-off (highest priority)

**Locate + download the latest READY package** (headless): `GET /api/import/package/{problemId}` →
`problem.packages` → filter `state == "READY"` → newest by `(revision, id)` → `problem.package
{problemId, packageId, type}` → returns the **raw ZIP bytes** (`main.py:788-803`). Default `type` is
the package's own type or `"standard"` (`main.py:796`). Download filename header is
`{problemId}-r{revision}-{type}.zip` (`main.py:801`). Frontend equivalent: `bulkDownload`
(`ProblemsPage.tsx:186-191`) → `downloadPackage` which just `window.open(...)` a browser download
(`client.ts:274-281`).

**Does the app extract? NO.** It only **downloads** the archive — backend returns bytes
(`main.py:802-803`), frontend opens a browser download (`client.ts:280`). **Extraction is Maestro's
job.**

**Exact on-disk layout after extraction:** captured for real in
**`docs/maestro/package-tree.txt`** — problem `#563392`
(`edu-tree-applications-equal-population-regions`), `standard` package, `packageId 1425709`,
revision 1, **276 entries**, downloaded via `GET /api/import/package/563392` and unzipped. Key facts:
- **The archive root is flat — there is NO top-level slug/id folder.** The problem *is* the archive
  root. Top-level entries: `problem.xml`, `check.cpp`, `check.exe`, `doall.bat`, `doall.sh`,
  `files/`, `scripts/`, `solutions/`, `statement-sections/`, `statements/`, `tests/` (+ more).
- `files/` → `testlib.h`, `olymp.sty`, `problem.tex`, `checker.cpp`, `checker.exe`,
  `statements.ftl`, `towin.exe`.
- `statement-sections/{english,russian}/` → `name.tex`, `legend.tex`, `input.tex`, `output.tex`,
  `scoring.tex`, `notes.tex`, `example.01`, `example.01.a`, …
- `statements/.html/{english,russian}/` → rendered `problem.html` + CSS.
- `solutions/` → `solution.cpp`, `solution.cpp.desc`, `solution.exe`.
- `scripts/` → `gen-*`, `run-checker-tests.*`, `run-validator-tests.*`.
- `tests/` → **194 entries**, numeric names `01`, `02`, … (inputs) plus answer files.
- Max nesting depth = 3 (e.g. `statements/.html/english/problem.html`).

**Per-problem directory naming:** N/A — one problem per package, no per-problem subdir. The **slug**
and **id** appear only in the **download filename** (`main.py:801`) and inside `problem.xml`
(**UNVERIFIED — exact `problem.xml` fields not parsed here**; the file exists).

**One problem or many per package:** **ONE.** `problem.package` is per-problem (`main.py:788`). There
is **no multi-problem package** produced or downloaded by this app (Polygon contest packages are
**NOT IMPLEMENTED** here). So the "multi-problem package" case the task asks for **does not exist** in
this system.

**Polygon-specific files a downstream tool may need to prune:** compiled binaries `check.exe`,
`checker.exe`, `solution.exe`, `towin.exe` (Windows; they dominate the 67 MB), `doall.bat`/`doall.sh`,
the whole `scripts/`, `problem.xml`, `files/testlib.h`, `files/olymp.sty`, and the pre-rendered
`statements/.html/`. **UNVERIFIED — what the Platform Scraper's `problem_uploader.py` expects** (raw
package vs. pruned folder vs. the parent-of-folders it documents); that is the Scraper's contract, not
this app's.

---

## §6 Identity

**Canonical identifier: both a slug and a numeric Polygon id.**
- The **slug** is the archive's root folder name, used verbatim as the Polygon problem `name`
  (`problem.create {name: slug}`, `pipeline.ts:48,50`; `zip_parser.py` `problem_name = folder_name`).
- Polygon assigns a numeric **`id`** returned by `create`/`problems.list`; the app uses that `pid` for
  every subsequent call (`pipeline.ts:75`; `import_pipeline.py` `pid`).

**Is the slug preserved verbatim?** Yes, into the Polygon problem **name** — the `edu-` prefix and
separators are kept (`zip_parser.py` `problem_name = folder_name`; `parseZip.ts:74-75`). The separate
`displayName` (strip `edu-`, spaces, title-case — `parseZip.ts:76-79`; `zip_parser.py display_name`)
is **UI only** and is **not** the Polygon name. So slug → Polygon name is an identity transform.
⚠️ The slug does **not** appear as an extracted **folder** name, because the package has a flat root
(§5). **UNVERIFIED — whether `problem.xml` records the slug** (it exists; contents not parsed).

**Lookup by slug:** `GET /api/problems.list?name=<slug>` — the list endpoint supports a `name` filter
(`main.py:257-271`) → `result[].id`; or list-then-match `name === slug` (`pipeline.ts:66`;
`import_pipeline.py:145-153`). Then use that `id` for `/api/import/verify/{id}` and
`/api/import/package/{id}`.

---

## §7 Concurrency and rate limits

**Two imports at once:**
- **Frontend** runs a bounded worker pool (`useImportQueue.ts:14`), up to `concurrency` jobs
  (default `2`, `ZipImport.tsx:41`), with **same-slug jobs serialized** via a `runningSlugs` ref
  (`useImportQueue.ts:18,64,70`). Different slugs run in parallel.
- **Backend `/api/import/problem`** processes its groups **sequentially within one request**
  (`main.py:760` `for slug, items in groups.items()`). But **two concurrent HTTP requests** to it run
  concurrently on the async server with **no locking** — and Polygon keeps **one working copy per
  problem**, so two overlapping imports of the **same slug** would corrupt each other. **There is no
  backend mutex.** → Maestro must **serialize per slug** itself.

**Polygon rate limits:** **UNVERIFIED — no documented limit found and none enforced in code.** The
frontend removed its per-test throttle (see `memory/zip-import-feature.md`). HTTP timeouts are
`120 s` for both httpx and requests (`polygon_api.py:81,83` region). The origin-sharding in
`client.ts:21-24` is a **browser** connection-pool trick and is irrelevant to a server-side caller.
Recommended ceiling: **UNVERIFIED**; the shipped default is `2` concurrent with per-slug serialization
(`ZipImport.tsx:41`, `useImportQueue.ts:70`). Safe starting point for Maestro: modest global
parallelism, strictly serialized per slug.

**Global/singleton state in the backend:** `_config` is a module global read on each request and
mutated by `POST /credentials`/`POST /settings` (`main.py:151,188-199,234`) — a concurrent credential
write during imports would change creds mid-run (unlikely operationally). The activity log `_BUFFER`
(`deque(maxlen=4000)`) and `_SEQ` counter are module globals guarded by a lock
(`activity_log.py:24-25`, `_LOCK`). No per-import singleton or lock exists — nothing serializes
imports for you.

---

## §8 Observability

**How the log is produced/stored:** an in-memory ring buffer `deque(maxlen=4000)`
(`activity_log.py:24`); `record(level, category, message)` appends `{seq, time, level, category,
message}` (`activity_log.py:31-42`). Feeders: the HTTP middleware logs every request's
method/path/status/duration (`main.py:75-91`); the Polygon proxy logs each call and result
(`main.py:_log_request`/`_log_response` → `alog.record`); the import endpoint logs parse/import lines
(`main.py:751,763,766`); a `logging.Handler` captures uncaught tracebacks (`activity_log.py`). **It is
memory-only — not persisted; lost on restart.**

**Streaming interface:** **NOT IMPLEMENTED** — no SSE, no WebSocket. **But there is a cursor poll:**
`GET /api/logs?since=<seq>` returns only entries with `seq > since` plus a `server` status block
(`main.py:112-114`; `snapshot(since)` `activity_log.py:44-47`). The log page itself polls this every
1 s (`activity_log.py:218,257`). **So Maestro can tail** by tracking the highest `seq` seen and
polling `/api/logs?since=<lastSeq>`. Also: `GET /api/logs.txt` (full text dump, `main.py:117`),
`POST /api/logs/clear` (`main.py:130`).

**Operation/job id:** **NOT IMPLEMENTED.** Imports are synchronous — `POST /api/import/problem`
returns all `results` inline (`main.py:769`); there is no job id and no correlation id. Log entries
carry a per-entry `seq` (`activity_log.py:34`) but there is **no per-operation grouping id**, so
Maestro cannot cleanly correlate a specific import to specific log lines (only by timing/text).

---

## §9 Error taxonomy

See **`docs/maestro/errors.md`** for the table (condition → surface → retryable → handling).

---

## §10 Headless blockers

**Not a blocker — import works headlessly today:** `POST /api/import/problem` +
`GET /api/import/verify/{id}` + `GET /api/import/package/{id}` cover create → commit → verify →
download without a browser (`main.py:716,772,788`).

**The real headless friction:**
1. **`POST /api/import/problem` is synchronous and blocks for the whole import**, including every
   `saveTest` call, before returning (`main.py:764` awaits `run_import_pipeline`). For a large test
   set this is a **multi-minute held HTTP request**. Maestro must use a long client timeout and cannot
   observe import progress mid-flight except via the shared activity log (§8).
2. **No async job model** (`/api/import-problem` returning a job id; `/api/verify-status/{id}` keyed by
   job): **NOT IMPLEMENTED** — the Phase-2 target. Today `verify` is keyed by **Polygon problemId**,
   not a job id (`main.py:772`).
3. **Polygon FAILED comes back as HTTP 200** on the raw `problem.*` proxy endpoints (`main.py:160-165`)
   — Maestro must parse the body `status`, not the HTTP code, if it calls those directly (§2). The
   `/api/import/*` endpoints already fold this into `results[].errors`/`log`.

**What has no HTTP equivalent (React-only):**
- The import **queue** UX — add-while-running, per-job retry, concurrency slider, grouped history
  (`useImportQueue.ts`, `QueueView.tsx`). Headless gets one synchronous batch instead.
- The step-by-step **Upload Wizard** for manual single-problem creation (`frontend/src/wizard/
  UploadWizard.tsx`) — no HTTP endpoint.
- **Origin sharding** (`client.ts:21-24`) — a browser concurrency trick, moot server-side.

**Adjacent (not needed for the Polygon import path):**
- Contest automation `POST /api/automation/contest/*` is HTTP-callable but launches a real Chromium
  and needs a human for the first Cloudflare/login (`backend/contest_automation.py`) — see the
  Maestro plan's ElectiCode stage, not this app's import path.
- Credentials must be present in `config.json`; Maestro can write them via `POST /credentials`
  (`main.py:182`), which stores them in plaintext (gitignored).
