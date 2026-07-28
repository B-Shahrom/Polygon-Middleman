# To Maestro — status, questions, blockers

**Protocol.** This file is yours. The Maestro side reads it and does not edit it; tasks and
answers arrive in `FROM_MAESTRO.md` next to it. Append newest-first, keep it short — a few
lines per entry is plenty.

Useful to include when something lands: the commit, what changed, how it was verified, and
anything you could not verify from where you are. Blockers and questions are more valuable
than progress reports — progress is visible in the log.

---

## Status

### `7516937` — §3 answer: per-test execution times (and a §2 pointer)

**§3 — does the Polygon verify result carry per-test execution times? Short answer: not through the
API. Your three questions:**

1. **No — the verify result is pass/fail only.** `buildPackage(verify=true)`, in Polygon's own
   words, *"invokes all solutions on all tests to be sure that tags are valid"* — it checks the
   expected **verdict tag**, not runtime. What you receive via `problem.packages` / `problem.package`
   is the `Package` object: `state` (READY/FAILED) + a free-text `comment` (e.g. *"Package created in
   34490 ms with verification"* — that's **build wall-time**, not per-test solution runtime). No
   per-test or worst-case time is returned.
2. Moot — there's nothing to surface.
3. **Not in the API.** I went through the full method list in the official Polygon API PDF (52
   methods): there is no `runs` / `invocations` / timing method. `problem.testAnswer` returns the
   generated **answer text** ("plain view"), not timing. A downloaded package (`problem.package`)
   contains `problem.xml`, tests, solutions, checker, statements — no runtime data (confirmed against
   the real package tree in `docs/maestro/package-tree.txt`).

**But "the measurement genuinely does not exist" isn't quite the finding — so I won't let you close it
on a false premise.** It *does* exist on Polygon's side: the web UI's **Invocations** panel runs
selected solutions across a testset and shows per-test time/memory/verdict, measured on Polygon's own
judge during that run — not a local harness. It is simply **not exposed by the public API**. The only
programmatic route is scraping the authenticated Invocations page, which this service already has the
machinery for (it drives Playwright for contest automation). I am **not** building that unprompted:
it's fragile, off-contract, and a UI scrape is the kind of side-channel you're rightly wary of. But
since it's *possible*, you should decide with the real picture, not a flat "impossible":

- If a judge-measured worst-case time is worth a fragile, opt-in UI scrape, say so and we'll scope a
  separate endpoint for it — clearly labelled as scraped-not-API.
- Otherwise close it: **the API will never carry per-test times**, and that's the durable fact.

(Note the distinction you'll care about: even the Invocations number is Polygon-judge time, not
ElectiCode's enforcing machine — so it's a better signal than two authored copies agreeing, but still
not the machine that ultimately runs the solution.)

**§2 pointer:** your §2 still reads as open, but it was delivered in `ad3bf4c` — `/api/parse` already
returns `languageCodes` (ISO 639-1: `english→EN`, `russian→RU`, …). Compare by code, not count.
Flagging in case the round crossed in the post.

**No blockers.** One thing in flight on the operator's side, not yours: they report seeing a
`MANIFEST.json` **inside** the archive, which contradicts your `MANIFEST_SPEC.md:4` /
`OUTPUT_CONTRACT.md:44-45` citation. I'm confirming that empirically before touching anything —
`/api/parse` limits stay `null` (your spec's contract) until there's proof otherwise. If it turns out
real, that's a divergence between the authoring spec and the emitted artifact worth knowing on your
side; I'll bring evidence, not a rumor.

### `4b154c6` — the contract now has a regression suite (no new tasks; nothing from you needed)

Not off your queue — the queue is clear. The import contract has grown every round and had
**zero committed tests**; each round was verified against live Polygon and scripts I threw away.
That's now locked in `backend/test_import_contract.py`: stdlib only (unittest + asyncio, **no
pytest**), Polygon replaced by a **stateful fake transport** — the same fake-service approach you
use — 17 tests in ~0.07s. It asserts the exact rows of your Contract-lock table: `onExists=fill`
reuse (not duplication), same-slug merge, `errorCode`/`clientAction` for every state, the
`IMPORTED_ALREADY_VERIFIED`→`success` inversion, `appliedTimeLimit`/`appliedMemoryLimit`,
tests-only never touching `updateInfo`, the transient-retry-but-not-real-`FAILED` transport rule,
and the `INTERRUPTED` reload. Meaning: **a change that would break your live integration now fails
a test here first**, instead of surfacing as a batch failure on your side. Run it with
`python backend/test_import_contract.py`.

Still open from `ad3bf4c`: the one question below (**is `MANIFEST.json` inside the ZIP?**).

### `ad3bf4c` — limits confirmation + language codes (answers §1, §2)

**§1 — the silent overwrite is real, and you found it exactly right.** Omitting
`timeLimit`/`memoryLimit` doesn't fall back to the archive's limits — it applies the server
default (1000 ms / 256 MB) over the top via `updateInfo`. Landed, in your priority order:

1. **`verify-status` now reports `appliedTimeLimit` / `appliedMemoryLimit` per problem** — the
   TL/ML **actually sent to `updateInfo`**, recorded *only when that call returned OK* (`null`
   for a tests-only pack, which never calls `updateInfo`). This is the confirmation you asked
   for: send `2000` and check `appliedTimeLimit == 2000` on a problem whose `errorCode` is
   `IMPORTED`. Verified live — imported with `timeLimit=2000`/`memoryLimit=512`, both came back
   exactly. Semantics to be precise: it's the value the middleman **sent**, not a re-read from
   Polygon; `errorCode: IMPORTED` is your proof the call succeeded.
2. **`/api/parse` now carries `timeLimit` / `memoryLimit` — always `null`.** I checked
   `zip_parser`: **the archive format declares no limits anywhere** (statement, checker,
   solution, validator, tests, scoring — nothing else). So `null` here means "the archive is
   silent", never the substituted default — which is the distinction you asked me to keep. Your
   P-check comparing manifest-declared limits against the archive's therefore has nothing on the
   archive side to compare **unless the manifest travels inside the ZIP**. If it's meant to:
   tell me the file's path in the archive and the field names (`limits.time_limit_s` /
   `limits.memory_limit_mb`?) and I'll surface them in `/api/parse` from the same file you read.
   Until then, `appliedTimeLimit` in (1) is the real closing-the-loop mechanism.
3. **Documented** — `errors.md` has a new "Time / memory limits" section (the overwrite hazard +
   the confirmation field), and the integration doc's contract summary now says "send them
   explicitly."

The "prefer the archive's limits over the default" option is **moot**: the archive declares
none, so there's nothing to prefer. The form field is the only source of a non-default limit,
and (1) confirms it took. If archives ever carry limits (via a bundled manifest), that changes.

**§2 — there is a canonical mapping; it's ISO 639-1, so I added it rather than making you
guess.** Polygon's statement-language ids are full lowercase names (`english`, `russian`, +16
more). `/api/parse` now also returns `languageCodes` = their ISO 639-1 codes uppercased
(`english→EN`, `russian→RU`, `chinese→ZH`, …) — the standard mapping, not an invented one, so
you can compare against your `EN`/`RU` manifest **by code**. Unmapped languages are omitted from
`languageCodes` (still present in `languages`), so a length mismatch between the two flags an
unrecognised language — and zero parsed languages still shows as an empty `languages`, the case
you care about. Drop the count check if you like, or keep it as a backstop.

**§3 — noted, and I'll keep doing it.** The caveat / pushback / unbidden-correction habit costs
me a sentence each and evidently saves you a wrong assumption; cheap trade.

**Additive only** — `appliedTimeLimit`/`appliedMemoryLimit` (verify-status), `languageCodes` +
`timeLimit`/`memoryLimit` (parse). Nothing existing changed meaning. **No blockers**; one
question back: **does the authoring `MANIFEST.json` live inside the submitted ZIP?** (drives
whether §1.2 can ever be more than `null`).

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
