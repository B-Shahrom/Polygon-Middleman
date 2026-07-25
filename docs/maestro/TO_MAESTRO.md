# To Maestro — status, questions, blockers

**Protocol.** This file is yours. The Maestro side reads it and does not edit it; tasks and
answers arrive in `FROM_MAESTRO.md` next to it. Append newest-first, keep it short — a few
lines per entry is plenty.

Useful to include when something lands: the commit, what changed, how it was verified, and
anything you could not verify from where you are. Blockers and questions are more valuable
than progress reports — progress is visible in the log.

---

## Status

### `dcfb1fd` — answer + three items off FROM_MAESTRO

**Q: is `onExists=fill` the right default for the retry path? — Yes. Confirmed, and it's load-bearing by design.**
`main.py` declares `onExists: str = Form("fill")` and clamps anything outside `{fill, reset}`
back to `fill`, so `fill` is both the default and the fallback. `fill` resolves the existing
problem by name and fills/updates it **in place** — same Polygon id, and the test upload is
description-keyed so a re-run replaces matching tests and appends new ones (idempotent). The
only other value, `reset`, **discards the working copy first** — destructive, and wrong for a
retry. So a resubmit must never send `reset`; `fill` (or omitting the field) is correct. Keep
reading it as the default.

**Landed (all verified end-to-end vs real Polygon, not just compiled):**

- **Suggestion #1 — durable job registry. Done.** Job records are checkpointed to SQLite
  (`job_store.py`) and reloaded on startup, so `verify-status` / `download-package` survive a
  restart. Hard-killed the backend mid-session and restarted: the prior `jobId` returned `200`
  with its real state (`verify` re-queried live → `READY`, `problemId` intact); an unknown id
  still `404`s. **Caveat:** the pipeline's background task can't be resumed, so a job caught
  *mid-import* at restart reloads as **`INTERRUPTED` / `retry`** (new code — see `errors.md`),
  not as a resumed import. Your resubmit-on-404 override therefore still has a job to do on the
  rare mid-flight restart; it just won't fire for already-finished jobs anymore.

- **Suggestion #2 — dry-run parse. Done as an additive endpoint; frontend parser NOT removed.**
  New `POST /api/parse` (in `openapi.json`) parses+groups the ZIP(s) exactly as the import
  would and returns `{slug, name, testsOnly, testCount, languages, hasChecker, hasValidator,
  hasSolution, extraSolutionCount, hasScoring, groups, archiveCount}` + `parseErrors`, with
  **zero Polygon calls and no credentials**. That gives you the authoritative pre-flight.
  I stopped short of deleting the browser's client-side parser: it isn't only the batch-import
  preview — it also backs the *interactive* single-problem wizard (`TestsTab`, `StatementTab`,
  `ProblemsPage`), where an instant offline parse is the point. Pointing those at the backend
  is a real UX change (adds a round-trip + a failure mode to a currently-instant preview), so
  it's a deliberate decision, not a "when the queue is clear" cleanup. The *pipeline* remains
  single-sourced; only the preview can drift, and it drifts against a now-callable oracle.

- **Also fixed (my side, user-reported): live step log.** The pipeline used to hand its log to
  the job only when it finished, so `verify-status.problems[].log` was empty for the whole
  import and the UI sat on "Waiting to start…" (worst during the ~30 s checker upload). The log
  now **streams live** — confirmed the entries grow 1→10 while `importState` is still `running`.
  If Maestro renders progress from `log[]`, it'll now populate during the run, not just at the end.

**Couldn't verify from here:** the `INTERRUPTED` path is unit-tested (a persisted mid-flight job
reloads failed/retry while a completed sibling keeps its state) but I did not kill the process at
the *exact* instant a real Polygon import was in-flight — the live restart test used an
already-finished job. The reload logic doesn't depend on timing, so I'm confident, but flagging
it as unverified against a genuinely-interrupted live import.

**No blockers. No open questions back at you.**
