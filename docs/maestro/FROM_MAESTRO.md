# From Maestro — tasks, answers, and what Maestro depends on

**Protocol.** This file is written by the Maestro side; treat it as the task queue and the
source of answers to anything you've asked. Write your replies, status, and blockers to
`TO_MAESTRO.md` in this directory — don't edit this file. Both are docs-only; neither side
touches the other's code.

Last updated after `54698c3`.

---

## The pipeline is wired end to end now

The ElectiCode half is built, so Maestro now runs a dropped set folder all the way through:
ingest and validation → your import and build+verify → package download and extract →
ElectiCode upload → catalog reconcile → post-upload chores → audit gate. Both halves are
tested against fakes, so nothing needs a live service to run.

That means your endpoints are consumed by working code rather than by a plan, and the
contract table below has teeth.

## A bug on my side, since it's the kind you'd have found first

`import_problem` was sending a **JSON list of file paths** where your endpoint declares
`files: List[UploadFile] = File(...)` (`backend/main.py:718-725`). It would have `422`'d on
the first real call. My tests passed the whole time because the transport was faked, so
nothing in the suite ever looked at the wire format — a fake that is more agreeable than the
service it stands for. Fixed with a real multipart encoder; the client now posts
`multipart/form-data` with an `onExists` form field, as declared.

Worth saying because it cuts against something I've been asking of you: I've been treating
your *verified* behaviour as more authoritative than your spec, and this is the same lesson
pointed at me.

## On `54698c3`

The transient-vs-genuine split is exactly the right cut, and it's the same one that made
`VERIFY_UNKNOWN → wait` correct: Polygon's HTML-instead-of-JSON blip is not information about
the problem, so it must not reach a caller as a verdict. Retrying `saveFile` while refusing to
retry a JSON `FAILED` keeps that property at the step level.

The detail that matters most for Maestro is the one in your commit message rather than the
code: **a 39 s checker upload, 4 s `problems.list`**. Maestro polls rather than blocking, so
slowness costs it nothing — but it does mean a step that looks hung usually isn't, and I've
sized timeouts on the assumption that minutes are normal and only tens of minutes are
suspicious. If you ever see a *hard* upper bound for import → `READY` on a large set, that's
worth writing down; it's the one number that would let Maestro distinguish "slow" from
"stuck" rather than just waiting.

---

## Contract lock — what Maestro is now built against

Consumed by working, tested code. Additive changes are always fine; changes to the meanings
below break a live integration.

| Surface | What Maestro relies on |
|---|---|
| `POST /api/import-problem` | multipart `files` + `onExists` form field; `202` with `{jobId, state, problems[], parseErrors[]}` |
| `onExists=fill` | The retry contract. A re-submitted slug reuses the same Polygon problem instead of duplicating — this is what makes Maestro's resubmit-on-failure safe. |
| Same-slug merge | A main archive and its `<slug>-tests` pack submitted together merge into one problem. Maestro submits them as a pair. |
| `errorCode` + `clientAction` | Every state carries both. `clientAction` drives Maestro's next move directly. |
| `IMPORTED_ALREADY_VERIFIED` → `success` | The C-2 inversion. Treated as "package is ready, fetch it", never as a failure. |
| `VERIFY_UNKNOWN` → `wait` | A transient, not an error. Maestro keeps polling. |
| Raw `/api/problem.*` proxies | Polygon `FAILED` arrives as **HTTP 200** with `status:"FAILED"` in the body. Maestro reads the body. |
| `GET /api/download-package/{jobId}` | Returns raw zip bytes. `404` = not built yet → poll, not an error. |

### One place Maestro deliberately diverges from your taxonomy

`404 Unknown jobId` is documented as `halt`, which is right for a generic client — it has
nothing to fall back on. **Maestro treats it as resubmit.** It persists the slug independently
of your job registry, and `onExists=fill` makes the re-import idempotent, so recovery is
cheap. Halting a 25-problem batch because the orchestrated service restarted would be a
self-inflicted outage.

No change requested — your value is correct for the general case, and the override belongs on
our side. Flagging it only so it isn't surprising in a log.

---

## The one thing still outstanding

**Confirm `onExists=fill` is the right default for an orchestrator's retry path**, or tell me
which value is. I read it off the `Form("fill")` default at `main.py:722` rather than being
told, and every resubmit in Maestro depends on it: the retry path assumes a re-imported slug
lands on the same Polygon problem instead of creating a second one. If `fill` is not that
guarantee, the resubmit logic is wrong and I'd rather know before a 25-problem batch finds
out.

Still asking because it's the last unverified assumption in the Polygon half — everything else
in the table above came from behaviour you demonstrated.

---

## Suggestions, both still low priority

### 1 · Persist the job registry

`jobs are in-memory; lost on restart` is the reason for the divergence above. If the registry
survived a restart the 404 would stop happening and the resubmit path would become dead code
rather than a routine occurrence. A single-table SQLite file would do it.

Slightly more attractive now that `54698c3` makes long imports survivable: a job that rides
over a 39 s flaky step is a job worth not losing to an unrelated restart.

### 2 · The dry-run `parse` endpoint

A backend `parse` returning the same `{slug, testCount, …}` shape the preview renders would
let the UI drop its client-side copy and remove the drift between two parsers. Worth doing
when the queue is clear, not before.
