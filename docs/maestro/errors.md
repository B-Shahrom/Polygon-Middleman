# Error taxonomy — Polygon Middleman (as of Phase 1)

How each failure surfaces **today**, whether it is worth retrying, and the recommended handling.
Cited to `file:line`. **Key caveat up front:** for the raw `/api/problem.*` proxy endpoints, a
Polygon-side failure returns **HTTP 200** with body `{"status":"FAILED","comment":"..."}` — inspect
the body, not the HTTP status (`backend/main.py:160-165`). The `/api/import/*` endpoints instead fold
failures into their JSON (`results[].ok`, `results[].errors`, `results[].log`, `parseErrors`).

**Machine-distinguishability today (important for Maestro):** import failures are **semi-structured** —
`results[].ok`/`errors` are booleans/counts, but the *reason* is free-text in `results[].log[].text`
and in Polygon `comment` strings. There are **no per-error codes**. Distinguishing "retry" vs "halt"
currently requires reading text. Making this machine-distinguishable is a **Phase-2** requirement, not
a current guarantee.

| # | Condition | How it surfaces | Retryable | Recommended handling |
|---|---|---|---|---|
| 1 | **Bad / unreadable ZIP** | `POST /api/import/problem` → HTTP **200**, body `parseErrors: [{file, error}]`; log line `parse failed: <file> — <err>` (`main.py:749-751`). The problem is skipped, others proceed. | **No** | Fix the archive; re-submit. |
| 2 | **ZIP parses but incomplete** (no checker/solution/tests, or tests-only with absent base) | HTTP **200**; import runs what exists; `results[].log` carries advisory warnings; a tests-only pack with no base **creates an empty problem** (`pipeline.ts:151-162`; `zip_parser.py` warnings). Not an error unless a step throws. | N/A | Inspect `results[].log`; decide if the resulting problem is acceptable. |
| 3 | **Credentials not configured** | Any Polygon-backed call → HTTP **401** `{"detail":"API credentials not configured. Go to Settings."}` (`main.py:154-156`). | **No** | `POST /credentials` (names in §1), then retry. |
| 4 | **Polygon auth rejected** (creds present but wrong) | Raw proxy: HTTP **200** body `{"status":"FAILED","comment":...}` (`main.py:160-165`). Import: per-step `error` in `results[].log`, `errors++` (`import_pipeline.py` `step()`); commit/verify skipped. | **No** | Read `comment`; verify `api_key`/`api_secret`. |
| 5 | **Polygon rate limit / transient Polygon error** | **UNVERIFIED** exact shape — no documented limit, none enforced here. Likely a `FAILED` `comment`, or an httpx error (see #7). On import it becomes a per-step `error` (`import_pipeline.py` `step()`). | **Maybe** (transient) | **UNVERIFIED** classification — not distinguished from #4/#11. Back off, re-submit the import (idempotent — §3 of the manual). |
| 6 | **Verify FAILED** (problem broken) | `GET /api/import/verify/{id}` → HTTP **200** `{"state":"FAILED","comment":...}` (`main.py:772-785`). | **No** by default (**Maybe** if Polygon transient — **not distinguished**, `NOT IMPLEMENTED`, manual §4) | Treat as broken; read `comment` (free-text). Fix the problem; re-import. |
| 7 | **Network timeout to Polygon** | httpx/requests timeout is **120 s** (`polygon_api.py`). Raw proxy: the exception propagates → HTTP **500** (FastAPI default). Import: caught by `step()` → `errors++`, logged; commit/verify skipped. | **Yes** | Re-submit the import; it is idempotent (fills/overwrites the same problem, manual §3). |
| 8 | **Package not ready** | `GET /api/import/package/{id}` → HTTP **404** `{"detail":"No READY package for this problem yet."}` (`main.py:793-794`). | **Yes** | Poll `GET /api/import/verify/{id}` until `state == "READY"`, then download. |
| 9 | **`problem.packages` FAILED** (during verify/download) | `_packages()` → HTTP **400** `{"detail":<comment>}` (`main.py:707-713`). | **Maybe** | Inspect `detail`; retry if transient, else halt. |
| 10 | **Tests still missing after 4 fill rounds** | `POST /api/import/problem` → HTTP **200**, `results[].ok=false`, `errors>0`; log `"... still missing after auto-fill (indices ...). Skipping commit & verify — retry to finish."` (`pipeline.ts:110-116`; `import_pipeline.py`). **Not committed.** | **Yes** | Re-submit the same import — the fill/append logic completes the gaps (manual §3). |
| 11 | **Mid-pipeline step failure** (statement/checker/solution/group save throws) | HTTP **200**, `results[].ok=false`, `errors>0`; the failing step logged `error` in `results[].log`; commit + verify **skipped**; working copy left **uncommitted** (`pipeline.ts:28-43,145-146`). | **Depends** (transient → yes; malformed content → no) | Read `results[].log` for the failing step. Re-submit if transient; fix input if not. No rollback exists (manual §3). |
| 12 | **Malformed request** (missing `files`, bad multipart) | FastAPI validation → HTTP **422** `{"detail":[{loc,msg,type}...]}` (`openapi.json` `422` responses). | **No** | Fix the request shape (`multipart/form-data`, `files` field). |

**Signals Maestro should read, in priority order:**
1. HTTP status (`401`/`404`/`422`/`500`/`400`) for transport- and request-level errors.
2. `results[].ok` and `results[].errors` for per-problem import outcome (`main.py:769`;
   `import_pipeline.py:_result`).
3. `results[].log[]` (`{text,status}`) for the failing step's free-text reason.
4. `GET /api/import/verify/{id}` `state` + `comment` for build/verify outcome.
5. `GET /api/logs?since=<seq>` for a cross-cutting tail (§8 of the manual).

**Gap flagged for Phase 2:** none of the above gives a stable machine-readable *error code*; retry-vs-halt
currently depends on parsing text. Phase 2 asks for this to be code-distinguishable in the response.
