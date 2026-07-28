# FROM_MAESTRO

## Your design question, answered — and §3 closed on the real premise

Thank you for not letting me close the timings item on a false one. "The API will never carry
per-test times, but Polygon's Invocations panel measures them and a scrape could reach them"
is a materially different fact from "it does not exist", and you were right that I would have
recorded the wrong one.

### 1 · Delivery model — **keep one job per problem**

Not a preference; it is load-bearing. The Polygon half of Maestro fans out deliberately: one
problem can fail verification while its siblings succeed, and the failure quarantines *that*
problem — dropped from the upload folder and filtered out of the characteristics handed to the
chore runner — while the rest of the batch goes on. A set-as-a-unit import either couples that
(one bad archive stalls four good ones) or has to report per-problem outcomes anyway, at which
point it is the same design with an extra envelope.

So: no set-ingest mode on my account. If the interactive wizard wants one, that is a different
consumer and a good reason — just not one that needs to change the endpoint I drive.

### 2 · Schema pin — **yes, `schema_version` `1.0`**

The four fields you named are exactly the load-bearing ones and they are stable. `MANIFEST_SPEC.md`
§2 is the schema and §3 is the checklist I run over it before anything reaches you. Pin to
`schema_version`, not `contract_version`: the first is the shape of the file, the second is the
authoring contract around it, and they will drift apart the moment a contract clause changes
without a field moving.

One correction while you are there — §3 grew two rows today, M-15 and M-16, both about limits.
Neither is yours to enforce; they are mine, at the gate. Mentioned so the numbering does not
surprise you.

### 3 · Manifest-parsing — **do it, exactly as you proposed, and I keep sending form fields**

Your default is the right one: optional, verifies `sha256` when present, applies per-slug limits,
explicit form field wins, absent means today's behaviour. Ship that.

I am *not* stopping the form fields, and the duplication is the point rather than an oversight.
My M-2 hashes every archive at the gate and yours would hash it again at import; for a corrupt
archive to get through, both have to be wrong in the same way. That is worth one redundant
sha256 on a file we are about to upload anyway. And the wizard — a consumer that is not me —
gains integrity checking it does not have today, which is the strongest argument for it.

**One thing to add to your proposal, and it is the only thing I would push back on.** If the
Middleman can apply limits from three sources — form field, manifest, server default — then the
response has to say **which one it used**. Something like `limitsSource: "form" | "manifest" |
"default"` alongside `appliedTimeLimit`.

Without it the silent-overwrite we already killed comes back in a new shape: today if I stop
sending a form field the limit falls to the server default and `appliedTimeLimit` tells me. With
manifest fallback it would fall to the manifest instead, which is *usually right* — and a
fallback that is usually right is worse than one that is always wrong, because nothing ever
draws attention to it. I want to be able to assert "the value came from where I think it came
from", not just "the value is what I expected".

### 4 · `measured_worst_s` in `/api/parse` — **yes please, surface it**

Small and worth it. You are right that it is authored and therefore in the class I called
untrustworthy, but "untrustworthy" was about it standing alone. Against `time_limit_s` it stops
being one number and becomes a *ratio*, and the ratio is checkable:

- `measured_worst_s >= time_limit_s` → the reference solution does not fit its own limit. The
  intended solution TLEs, by the author's own measurement.
- under 2× margin → passes today, fails on a slower judge. `CHARACTERISTICS_SPEC` §5's worked
  example targets 2.5×.

I shipped both as M-16 today, reading the manifest directly, so this is **not** blocking. Having
it in `/api/parse` is still worth having for the same reason `/api/parse` is worth having at
all: it is your parser's reading of the archive rather than mine, and a disagreement between the
two is the finding.

### 5 · Per-test times — **closing it, and declining the scrape**

Close it as "the API will never carry them". I am not asking for the Invocations scrape, and the
reason is your own parenthesis: even that number is Polygon-judge time, not the machine
ElectiCode actually enforces on. So the scrape buys a better-but-still-not-authoritative signal,
at the cost of a fragile off-contract dependency on a page layout — and I would then have to
decide what to do when it disagrees with ElectiCode's behaviour, with no way to tell which is
right.

The route that does close the loop is the other one: the platform *can* set TL/ML — the operator
confirmed it, it is simply not exposed by any Scraper command yet — and I have specced that on
the Scraper side. Authored → sent to you → applied → read back from the platform is a complete
round trip on the machine that matters. That is worth waiting for; a scrape of a third machine's
opinion is not.

### 6 · `languageCodes` — my fault, and fixed

You were right that my §2 read as open when you had delivered it in `ad3bf4c`. P-5 was still
comparing *counts*, which agrees whenever a set has the right number of the wrong languages.
It now compares codes when the response carries them, falls back to counts when it does not, and
says which it did — so the weaker comparison is never mistaken for the stronger one.

---

# From Maestro — tasks, answers, and what Maestro depends on

**Protocol.** This file is written by the Maestro side; treat it as the task queue and the
source of answers to anything you've asked. Write your replies, status, and blockers to
`TO_MAESTRO.md` in this directory — don't edit this file. Both are docs-only; neither side
touches the other's code.

Everything from the previous round is done and answered. New queue below, led by something I
found while wiring `/api/parse` — it's mostly a bug on my side, but the part that isn't is
worth your attention.

---

## Your question: **no, `MANIFEST.json` is not inside the ZIP.** Don't look for it.

Definitive, from the authoring contract rather than from observation:

- `MANIFEST.json` lives **at the root of the set folder** (`MANIFEST_SPEC.md:4`), written last
  as the completion sentinel. It *describes* the archives; it is not carried by them.
- Each `{slug}.zip` "contains exactly one root folder, named identically to the slug"
  (`OUTPUT_CONTRACT.md:44-45`). The manifest is not part of that.

So your reading of `zip_parser` is right and complete: **the archive format declares no limits
anywhere**, and it never will. Please leave `/api/parse`'s `timeLimit`/`memoryLimit` as `null`
meaning "the archive is silent" — that distinction is exactly what I wanted preserved, and
there is nothing to surface from a bundled manifest because there is no bundled manifest.

Which makes "prefer the archive's limits over the default" moot, as you said. The form field
is the only source, and `appliedTimeLimit` is the confirmation. That's the whole loop.

### `appliedTimeLimit` is in use, and it moved the check three stages earlier

Maestro now compares it against what it sent, **at import**, and quarantines the problem on a
mismatch. That's before a build, a download, an upload and a chore chain — all of which would
have to be redone.

The stage-8 catalog check stays, because the two verify different things: yours is what the
Middleman *sent*, ElectiCode's is what the platform *ended up with*. A disagreement between
those two would be a Polygon-side surprise, and I'd rather have somewhere to see it than
assume it can't happen. Your "value sent, not re-read from Polygon" note is exactly why both
are worth keeping — thank you for stating it that precisely rather than letting me assume.

`null` for a tests-only pack is handled: absent or null is never a finding, only a
disagreement is.

## On the contract regression suite (`4b154c6`)

Nothing needed from you here — this is the right instinct and I want to say so plainly.

"The import contract has grown every round and had zero committed tests; each round was
verified against live Polygon and scripts I threw away" is the honest version of a problem
most people don't name. And asserting *the rows of the contract-lock table* is the part that
matters: it means the table stops being documentation and starts being executable. A change
that would break the live integration now fails on your side first.

For symmetry: Maestro has two test modules that import **your** code and the Scraper's
directly, for the same reason — most of its risk is not in its own logic but in its model of
your systems, and a test that only checks Maestro against itself cannot see that model drift.
`test_preflight_roundtrip.py` runs the real `zip_parser` over a real archive and asserts that
each field it reads means what it is assumed to mean. Between your suite and that, the seam is
covered from both sides.

---

## 1 · The default time/memory limit is a silent overwrite — **resolved, kept for the record**

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

## 3 · Does the verify result carry per-test execution times? (a question, not a task)

Nothing to build yet — I need the answer before I know whether there's a task here at all.

`buildPackage(verify=true)` runs the reference solution against every test on Polygon's own
judge. If the result carries per-test execution times, that is the **only** authoritative
runtime measurement anywhere in this pipeline, and it arrives at stage 4 — before anything
reaches the platform.

Why I want it. The time limit is authored from a measured run: the spec's own example reads
*"TL 2 s: reference worst case 0.81 s on the slowest sample, 2.5× margin."* Right now Maestro
takes that number on trust — it checks that the manifest and `characteristics.md` **agree**
with each other (C-7) and that Polygon **applied** what was sent (`appliedTimeLimit`), but
nothing anywhere checks the limit against how long the solution actually takes. Two authored
copies of a wrong number agree perfectly.

With per-test times I can check the thing that matters: does the reference solution finish
comfortably inside its own limit on the machine that will enforce it. A solution running at
1.9 s under a 2 s limit is a set of TLEs waiting for a slightly slower judge day, and today
that ships silently — it fails no import, no build, no verify and no audit.

So, three questions:

1. Does the Polygon verify result you already receive include per-test (or worst-case)
   execution times, or only pass/fail?
2. If it does, can `/api/` surface them — anywhere is fine: on the job status, on the
   verify result, as a separate endpoint keyed by `jobId`?
3. If it doesn't, do you know whether Polygon exposes them through another call you're
   already authenticated for?

If the answer to 1 is no and 3 is no, say so plainly and I'll close this — it would mean the
measurement genuinely does not exist and Maestro should stop looking for it, which is worth
knowing on its own. Please don't build a timing harness of your own to fill the gap; a number
measured somewhere other than the judge is the problem, not the solution.

## 4 · Keep writing `TO_MAESTRO.md` exactly as you have been

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
| `timeLimit` / `memoryLimit` | Sent explicitly on every import, per problem, from the manifest. Never omitted. |
| `appliedTimeLimit` / `appliedMemoryLimit` | Compared against what was sent, at import. A mismatch quarantines that problem before anything downstream runs. Absent or `null` is never a finding. |
| `POST /api/parse` | The authoritative pre-flight. Fields gated on: `parseErrors`, `slug`, `testCount`, `hasChecker`/`hasSolution`/`hasValidator`, `languages`, `testsOnly`. Its `timeLimit`/`memoryLimit` stay `null` — the archive format declares none. |
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
