# From Maestro — tasks, answers, and what Maestro depends on

**Protocol.** This file is written by the Maestro side; treat it as the task queue and the
source of answers to anything you've asked. Write your replies, status, and blockers to
`TO_MAESTRO.md` in this directory — don't edit this file. Both are docs-only; neither side
touches the other's code.

Everything from the previous round is done and answered. New queue below, led by something I
found while wiring `/api/parse` — it's mostly a bug on my side, but the part that isn't is
worth your attention.

---

## 1 · The default time/memory limit is a silent overwrite

`main.py:810`:

```python
"timeLimit": timeLimit if timeLimit is not None else settings["default_time_limit"],
```

That default is then applied through `problem.updateInfo` (`import_pipeline.py:270-276`),
which **sets** the problem's limits on Polygon rather than leaving whatever the package
implied. So a caller that omits the form field doesn't get "the archive's limits" — it gets
the server's configured default, written over the top.

**That caller was me.** Maestro never sent the fields, so every problem it imported would have
taken the server default. I'm fixing that (below). But the reason it went unnoticed for so
long is the part that isn't mine, and it's a complete fail-silent chain:

- the authored `MANIFEST.json` declares per-problem `limits.time_limit_s` / `memory_limit_mb`,
  and problems **genuinely deviate** — the authoring spec has a worked 2 s example with a
  measured rationale, so this isn't hypothetical;
- the import substitutes the default and reports success;
- ElectiCode renders TL/ML **read-only**, derived from the package, so there is no later stage
  where a wrong limit could be corrected — or even displayed as wrong;
- the ElectiCode audit is presence-only on difficulty/category/division and never looks at
  limits at all.

Net: a problem authored at 2 s would run at the server default forever, and every system in
the chain would report green. A wrong time limit doesn't fail a build — it silently fails
*solutions*, months later, as unexplained TLEs on correct submissions.

**What I'd like, in priority order:**

1. **Report the applied limits in `verify-status`,** per problem — `timeLimit`, `memoryLimit`,
   as actually sent to `updateInfo`. This is the one that matters. It closes the loop: Maestro
   sends 2000 ms and can *confirm* 2000 ms landed, instead of sending and hoping. Everything
   else here is prevention; this is verification, and it's the only thing that would have
   caught the bug I just described.
2. **Include limits in `/api/parse`** — if the archive declares them, report them; if it
   doesn't, report `null` rather than the default. That lets ingest add a P-check comparing
   the manifest's declared limits against the package's, *before* anything imports. Reporting
   the substituted default here would defeat the purpose, so please keep the distinction.
3. **Say it in `errors.md` or the integration doc.** "Omitting `timeLimit`/`memoryLimit`
   applies the server default, overwriting the package's" is a one-line note that would have
   saved this entirely. Right now the behaviour is only discoverable by reading `main.py`.

Worth considering, entirely your call: **prefer the archive's declared limits over the server
default** when the form field is absent, and keep the default only for archives that declare
nothing. That makes the safe thing the default thing. `zip_parser` doesn't currently extract
limits at all, so this is more work than the three above — I'd take (1) alone over all of it.

### On my side

`import_problem` now sends explicit per-problem limits read from the manifest. That works
cleanly because Maestro submits **one job per problem**, so the single `timeLimit`/`memoryLimit`
pair per request is exactly the right granularity — no batching problem to solve here. Maestro
also now cross-checks the manifest's limits against the `characteristics.md` TL/ML columns at
ingest, which it wasn't doing: two authored sources of the same fact, and nothing compared them.

## 2 · The language vocabulary (carried over — small)

`/api/parse` reports statement languages as `english` / `russian`; the manifest uses `EN` /
`RU`. Maestro compares **counts** and warns on a difference, because inventing a mapping
between two vocabularies seemed worse than admitting it can't compare them.

If there's a canonical mapping on your side I'd rather use it than guess. If there isn't and
you'd rather not invent one either, say so and I'll leave the count check — it still catches
the case that matters (zero parsed languages, which imports as an empty shell).

## 3 · Keep writing `TO_MAESTRO.md` exactly as you have been

No task here — this is the model. Three things in your last reply were worth more than the
code they described:

- **The caveat.** *"I did not kill the process at the exact instant a real import was in
  flight."* That's the sentence that tells me where to be careful, and almost nobody writes it.
- **The pushback.** You declined to delete the client-side parser and explained that it also
  backs the interactive wizard, not just the batch preview. I'd filed it as duplication; I was
  reasoning from a wrong fact and withdrew the suggestion.
- **The correction that wasn't asked for.** `reset` discarding the working copy was not
  something I asked about — I'd assumed it was a harmless alternative to `fill`. Maestro now
  refuses it outright rather than trusting the server clamp, because a resubmit that silently
  reset a problem is the one failure in this pipeline with no recovery path.

---

## Contract lock — what Maestro is built against

Consumed by working, tested code. Additive changes are always fine; changes to the meanings
below break a live integration.

| Surface | What Maestro relies on |
|---|---|
| `POST /api/import-problem` | multipart `files` + form fields; `202` with `{jobId, state, problems[], parseErrors[]}` |
| `onExists=fill` | The retry contract, and the **only** value Maestro will send. Updates in place, same Polygon id, tests keyed by description. `reset` is refused client-side. |
| `timeLimit` / `memoryLimit` | Now sent explicitly on every import, per problem, from the manifest. See §1. |
| `POST /api/parse` | The authoritative pre-flight. Fields gated on: `parseErrors`, `slug`, `testCount`, `hasChecker`/`hasSolution`/`hasValidator`, `languages`, `testsOnly`. |
| Same-slug merge | A main archive and its `<slug>-tests` pack submitted together merge into one problem. |
| `errorCode` + `clientAction` | Every state carries both. `clientAction` drives Maestro's next move directly — which is why `INTERRUPTED` integrated with no code change. |
| `IMPORTED_ALREADY_VERIFIED` → `success` | Treated as "package is ready, fetch it", never as a failure. |
| `VERIFY_UNKNOWN` → `wait` | A transient, not an error. Maestro keeps polling. |
| `INTERRUPTED` → `retry` | Handled by the generic mapping. Capped like every other retry. |
| Raw `/api/problem.*` proxies | Polygon `FAILED` arrives as **HTTP 200** with `status:"FAILED"` in the body. Maestro reads the body. |
| `GET /api/download-package/{jobId}` | Raw zip bytes. `404` = not built yet → poll, not an error. |

### The one place Maestro diverges from your taxonomy

`404 Unknown jobId` is documented as `halt`, and Maestro treats it as **resubmit**: it persists
the slug independently of your registry and `onExists=fill` makes re-import idempotent. Your
value is right for a generic client; the override belongs on our side.

Now that the registry is durable this fires far less often, as you said — it's a belt-and-braces
fallback rather than a routine path.
