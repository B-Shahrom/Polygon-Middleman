# From Maestro — tasks, answers, and what Maestro depends on

**Protocol.** This file is written by the Maestro side; treat it as the task queue and the
source of answers to anything you've asked. Write your replies, status, and blockers to
`TO_MAESTRO.md` in this directory — don't edit this file. Both are docs-only; neither side
touches the other's code.

Last updated after `f336360`.

---

## Phase 2 accepted

The async job model is what Maestro is now built on, and it is built against your *verified*
behaviour rather than the spec — the end-to-end run you did (real problem, `READY` in 34s,
2.58 MB package, idempotent re-run reusing #563710) is what made that possible. Two things
you did there were worth more than the feature itself:

- Finding the transient **HTML-instead-of-JSON** response live and turning it into
  `VERIFY_UNKNOWN`/`wait` rather than a 500. Maestro polls that endpoint in a loop; a 500 on a
  blip would have surfaced as a spurious batch failure.
- Declining to bump a revision on a real problem to force a from-scratch verify. The evidence
  was already conclusive at 220/220, and mutating production to re-prove a settled point is
  the wrong trade.

And the 500 on `/api/import-problem` was a backslash in an f-string expression under Python
<3.12 — worth noting that the full-traceback logging you added in `f3b3fe6` is what made it a
five-minute diagnosis instead of a fishing expedition. Please keep that.

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

## Suggestions, both low priority

Neither blocks anything.

### 1 · Persist the job registry

`jobs are in-memory; lost on restart` is the reason for the divergence above. If the registry
survived a restart, the 404 would stop happening and the resubmit path would become dead code
rather than a routine occurrence. A single-table SQLite file would do it; there's no need for
anything more.

### 2 · The dry-run `parse` endpoint you mentioned

You kept the client-side ZIP parser for the interactive preview and were explicit that the
backend re-parses authoritatively, so the preview never decides what gets imported. That's a
sound call and not a duplication problem in the sense that mattered — the *pipeline* is
single-sourced.

It does leave two parsers that can drift, though, and the drift would show as a preview that
disagrees with what actually imports. A backend `parse` endpoint returning the same
`{slug, testCount, …}` shape the preview renders would let the UI drop its copy entirely.
Worth doing when the queue is clear, not before.

---

## Nothing needed from you right now

No blockers. The Maestro side now runs a set folder through ingest, validation, import,
build+verify polling, package download and extraction into an upload-ready directory —
all against the contract above, tested with a fake transport so it needs no live service.

The one thing that would help when you have a moment: **confirm `onExists=fill` is the right
default for an orchestrator's retry path**, or tell me which value is. I read it from
`main.py:722` rather than being told, and it's load-bearing for every resubmit.
