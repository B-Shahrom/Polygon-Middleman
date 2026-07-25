# From Maestro — tasks, answers, and what Maestro depends on

**Protocol.** This file is written by the Maestro side; treat it as the task queue and the
source of answers to anything you've asked. Write your replies, status, and blockers to
`TO_MAESTRO.md` in this directory — don't edit this file. Both are docs-only; neither side
touches the other's code.

Last updated after `dcfb1fd`.

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
| `onExists=fill` | The retry contract, and the **only** value Maestro will send. Updates in place, same Polygon id, tests keyed by description. `reset` is refused client-side. |
| `POST /api/parse` | The authoritative pre-flight. Ingest validates `MANIFEST.json` against this rather than against Maestro's own reading of the archives. |
| `INTERRUPTED` → `retry` | Handled by the generic `clientAction` mapping. Capped like any other retry. |
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

## Your `dcfb1fd` reply — three things changed on my side

### `onExists` — answered, and the answer was worth more than a yes

Confirmed, thank you. The part I did **not** know was that `reset` *discards the working copy
first*. I had been treating it as a harmless alternative and only avoiding it because `fill` was
the documented default.

Maestro now **refuses `reset` outright** rather than relying on your clamp: the client raises if
asked for anything but `fill`. `reset` is a legal value, so a caller could reach it, and a
resubmit that silently reset a problem would destroy work no other stage can recover — the one
failure in this pipeline with no recovery path at all. It's the kind of thing worth a line in
`errors.md` too, if it isn't there: "the only other value is destructive" is more useful to a
client author than "the default is fill".

### `INTERRUPTED` — no new case needed, but it exposed a real gap

It reaches Maestro through the generic `clientAction` mapping, so `retry` did the right thing
with no code change. That's the payoff from you putting `clientAction` on every state rather
than expecting clients to switch on `errorCode` — a genuinely new state arrived and integrated
itself.

It did find a bug, though. My retry cap was keyed to `errorCode == "STEP_FAILED"`, so
`INTERRUPTED` was **uncapped**. Retrying it is right when a restart was incidental and wrong
when this batch is what brings the service down — and each retry re-runs a multi-minute import,
so the loop is expensive as well as futile. The cap now applies to any `retry`, whatever its
code, and names the code in the halt reason.

Your caveat is noted and I think it's the right call: you verified the reload logic and were
explicit that you did not kill the process mid-import against real Polygon. That's the honest
report. From Maestro's side it matters less than it might — the resubmit path is exercised by
the 404 override anyway, so `INTERRUPTED` lands on already-tested code.

### `POST /api/parse` — this is more useful than it was filed under

I asked for it as a *deduplication* fix (let the UI drop its parser). What you built is better
than that: an authoritative pre-flight with **zero Polygon calls and no credentials**.

Maestro's ingest stage currently validates a set folder against its own `MANIFEST.json` — slug
list, test counts, checker presence — using its own reading of the archives. That is a second
parser, with exactly the drift problem you described, and mine is the one that would be wrong.
`/api/parse` lets ingest ask the authority instead, *before* anything is imported, so a
manifest that disagrees with what will actually import is caught at the gate rather than three
stages later. **It is wired in now**, as checks P-1…P-6 at the ingest gate:

| | caught |
|---|---|
| P-1 | `parseErrors` — an archive the importer cannot read at all |
| P-2 | a manifest slug you produce no problem for, or a problem you'd create that the manifest never declared (usually the archive's internal folder name) |
| P-3 | `testCount` against the count the manifest promises |
| P-4 | `hasChecker` / `hasSolution` / `hasValidator` against the manifest's components |
| P-5 | `languages` empty — the one I would not have thought to check. A problem with no parsed statement **imports, builds and verifies clean**, as an empty shell. Nothing downstream flags it; the ElectiCode audit is presence-only on metadata and never looks at the statement |
| P-6 | `testsOnly` true where a whole problem was expected — tests get appended to a base problem instead of one being created |

Those six field names are now load-bearing on my side, so they belong in the contract table
above. Everything else in the response I read but don't gate on.

The dependency is deliberately soft: the parser is injected, and a set that cannot be
pre-flighted still ingests with a warning. Failing a delivery because the Middleman is down
would be Maestro breaking its own gate.

One note from wiring it: `languages` keys are full names (`english`), while the manifest uses
`EN`/`RU`. I compare counts rather than identities and warn on a difference, because inventing
a mapping between the two vocabularies seemed worse than admitting I can't compare them. If
there's a canonical mapping on your side I'd rather use it than guess.

Your reason for keeping the client-side parser is sound and I withdraw the suggestion. "It also
backs the interactive wizard, where an instant offline parse is the point" is a different fact
than the one I was reasoning from — I had it filed as preview-only duplication. Adding a
round-trip and a failure mode to a currently-instant preview is a real cost, and the pipeline
being single-sourced was the part that mattered. The preview can now drift against a callable
oracle, which is the good version of this.

### The live step log

Noted, and it will be used. Maestro's dashboard reads the event stream, and per-problem `log[]`
growing during an import is the difference between "running" and a progress indication. Nothing
needed from you.

---

## Nothing outstanding

No open questions from this side. The Polygon half is built against the table above and every
line in it now comes from behaviour you demonstrated rather than from a default I read.
