# T-306 — CI is burning cost on documentation-only pushes

> **Status: SPEC, awaiting APPROVED.** From Ian directly, via the orchestrator's measurement:
> `.github/workflows/ci.yml` has no path filter, so a one-line register edit costs the same ~11
> minutes as a real code push. 511 minutes over four days, ~3,000/month — private-repo allowance
> territory. Turning CI off was genuinely on the table; this task exists to make that unnecessary.

## The trap that makes the obvious fix wrong

A `paths-ignore: [docs/**]` on the whole job would be a **bug**, not a fix:
`tests/unit/toc-freshness.test.ts` genuinely tests documentation (asserts `PROJECT_BIBLE.md`'s table
of contents is current), so a docs-only push CAN legitimately fail a real gate. Skipping the whole
job on a documentation change would hide exactly that failure — a check that stops running is worse
than one that never existed, because it's credited as still protecting something.

**The correct shape**: typecheck and unit run on every push, unconditionally. Only the two
Postgres/build-dependent steps — the integration suite and the build — are skipped, and only when
the change is provably nothing they could have anything to say about.

## Answers to the four questions

**1. How "docs-only" is decided, and does it fail open?**

A new `changes` job runs first, computing `docs_only` via `git diff --name-only` between the push's
own before/after SHAs (or the PR's base/head SHAs). **It fails open at every branch, by
construction — `docs_only` is only ever set to `true` after a successful diff whose every file
matches the documentation allowlist; every other path sets it to `false` and stops:**

- **First push to a branch** (`github.event.before` is the all-zero SHA): no base to diff against
  → `false`.
- **`workflow_dispatch` or any event this script doesn't recognise**: neither `before` nor a PR
  payload exists → the `BEFORE` variable is empty → `false`. (Not a current trigger of this
  workflow, but the check doesn't assume the trigger list stays fixed.)
- **Force-push**: the old tip can be unreachable even after a full-history checkout, since it may no
  longer be an ancestor of anything the remote still serves. `git diff` then exits non-zero, which is
  caught explicitly (`if ! CHANGED=$(git diff ...)`) → `false`. This is not hypothetical — I could not
  find a way to make `git diff` return a *wrong but successful* answer for an unreachable commit; it
  either succeeds with the right list or fails loudly, which is exactly the property fail-open needs.
- **Merge commit**: ordinary two-SHA diff, no special case needed — before/after are still a single
  well-defined pair and the diff lists everything the merge changed.
- **Empty diff** (e.g. an empty merge): vacuously `true` — there is no code for the skipped steps to
  say anything about.

**2. Does it need a third-party action?**

No — plain `git diff --name-only $BEFORE $AFTER`, no dependency. Argued both ways: `dorny/paths-filter`
gives nicer glob/negation syntax and is a well-known, widely-used action, but it is still a **new
pinned third-party dependency on the workflow that gates production deploy** — exactly the kind of
addition to avoid on that specific file. The actual logic needed here (diff two SHAs, classify each
path with a shell `case`) is about 15 lines and squarely inside "boring and standard beats clever and
bespoke" — a project convention, not a preference invented for this task. Went with git diff.

**3. What counts as documentation — decided deliberately, not by globbing `docs/`.**

- **`docs/ops/**` is EXCLUDED**, even though `docs/ops/access-revocation.md` is itself a `.md`
  file. Checked the directory's actual contents rather than assuming: it also holds `provision.sh`
  and eleven systemd `.service`/`.timer` unit files that get installed on the production host. That's
  operational infrastructure sharing a directory with prose, not documentation — the whole directory
  is treated as code for this check.
- **`docs/production-caller-baseline.txt` is EXCLUDED** — confirmed by reading
  `tests/unit/production-caller-ratchet.test.ts:44` that it's a generated artefact the unit suite
  diffs against (`node scripts/production-caller-census.mjs --names > ...`), not hand-written prose.
  Unit always runs regardless of this classification, so the exclusion doesn't change whether a bad
  baseline edit gets caught — it's here on principle, so a generated data file is never called
  "documentation."
- **Everything else under `docs/**`, plus any `*.md` anywhere in the repo** (package READMEs, ADRs,
  the root `PROJECT_BIBLE.md`/`HANDOFF.md`/`AGENTS.md`/`CLAUDE.md`/`README.md`), counts as
  documentation. `docs/ROADMAP.html` is included too — not `.md`, but still the status board's
  generated prose, not code, and nothing in typecheck/integration/build reads it.

Verified the classifier against six scenarios locally (pure docs, docs + `ROADMAP.html`, a
`docs/ops/*.md` file alone, the baseline file alone, docs mixed with a real code file, and nested
`.md` files under `docs/decisions/` and `packages/db/migrations/`) — all six classified as intended.
This is shell-logic verification, not a workflow run — see the caveat below.

**4. Is the 56-run day a separate problem?**

Partly, and it's not one a workflow file can fully fix. `concurrency: cancel-in-progress: true`
already existed before this task — a rapid second push does cancel the first, but the cancelled run
still burns whatever minutes it used before the cancellation lands, so a burst of pushes still costs
something even today. The orchestrator is already changing their own behaviour (batching docs
commits into fewer pushes) rather than relying on the workflow alone, which is the right split: this
task makes *each* run cheap when it's docs-only; it can't make people push less often. One thing this
task does help with regardless: several of the 56 runs were the orchestrator's own docs-only pushes —
each of those now costs ~2-3 minutes instead of ~11 even if a rapid follow-up push doesn't cancel it
in time, which directly shrinks the cost of exactly the pattern that produced the 56-run day.

## ⚠️ What cannot be verified from here

A GitHub Actions workflow only proves itself on a real run — there is no local runner for this repo
and I'm not simulating one. Everything above (the classifier, the fail-open branches) was verified as
shell logic against constructed file lists and against the actual contents of `docs/ops/` and the
baseline file; the YAML itself was checked for valid syntax (`js-yaml`, temporary, not installed as a
dependency) and I traced `needs:`/`if:` wiring by reading the parsed structure. None of that is the
same as watching it fire on a real push.

**Prediction for the first push after this lands, so you can check it against reality rather than
assume it worked:**
- If that push is a normal docs-only commit (e.g. a register row): the `changes` job runs alone
  first (fast, well under a minute — a full-history checkout plus one `git diff`), then `verify`
  starts, runs Install/Typecheck/Unit as always, and the four skipped steps show as **skipped** (not
  passed, not absent) in the run's step list. Total run time roughly **2-4 minutes** (install +
  typecheck + unit + the Postgres service container's own startup/health-check overhead, which still
  happens — this fix doesn't avoid starting the service, only skips the steps that use it).
- If it's a mixed or code push: every step runs exactly as before, same ~11 minutes, `docs_only`
  showing `false` in the `changes` job's log.
- If either of those does NOT match — the `changes` job errors, or a docs-only push still runs
  integration, or a code push gets skipped — that's this task failing its own bar and should be
  reported back, not quietly accepted.

## Scope — the exact files this task creates or modifies

- `.github/workflows/ci.yml` — the new `changes` job, `needs: changes` on `verify`, and `if:`
  conditions on the four steps named above. Nothing else in the file changes.
- `docs/tasks/306-ci-cost-on-docs-only-pushes.md` — this file.

## Contract

1. Typecheck and Unit tests run unconditionally, on every push and PR, regardless of what changed.
2. Only "Provision restricted test role", "Apply migrations", "Integration tests", and "Build" are
   conditional, and only on the `changes` job's `docs_only` output.
3. The condition is `!= 'true'` (run unless positively docs-only), never `== 'false'` — a job output
   that came back empty, malformed, or as some other string still runs everything, matching the
   fail-open requirement literally in the step conditions too, not only in the classifier script.
4. `deploy.yml`, the register, the bible, and anything under `packages/`/`apps/` are untouched.

## Invariants

1. ⛔ No `paths-ignore`/`paths` filter at the trigger level (`on: push:`) — that would skip the
   entire job, including typecheck and unit, exactly the trap this task exists to avoid.
2. ⛔ No third-party action added to this workflow.
3. ⛔ The `changes` job's checkout must keep `fetch-depth: 0` — removing it (e.g. to "speed up" this
   new job) reintroduces the shallow-clone failure this design deliberately handles.
4. ⛔ `docs/ops/**` and `docs/production-caller-baseline.txt` stay excluded from the documentation
   allowlist even if someone later reaches for a blanket `docs/**` glob to simplify the script.

## Tests

Cannot run this workflow locally (stated above, not implied otherwise). What was actually checked:

1. YAML syntax and job/step wiring (`js-yaml`, ad hoc, not installed as a project dependency).
2. The classifier shell logic, run standalone against six constructed file lists (pure docs, docs +
   `ROADMAP.html`, a `docs/ops/*.md` file, the baseline file, mixed docs+code, nested `.md` files) —
   all six matched the intended classification.
3. `npm run typecheck` and `npm run test` — confirm this change (a workflow file plus a new doc)
   doesn't affect the application build, since neither is consumed by either.
4. The real test is the first push after this lands — see the prediction above.

## Known trade-off, written down rather than left for someone to discover later

The `changes` job's `fetch-depth: 0` checkout runs on **every** push, including code pushes that
gain nothing from a full-history clone — the cost is paid to enable the diff regardless of which way
it comes out. Estimated 10-30 seconds on this repo, noise against the ~8 minutes a docs push saves,
but it's a cost added to every run to save on some, not free. If the first few real runs show it's
material, the narrower fix is fetching only the two commits being diffed (`git fetch --depth=1
origin $BEFORE $AFTER` or similar) instead of full history — not done here since the simple version
was correct on the first attempt and this hasn't been shown to matter yet.

## Out of scope

- ⛔ Reducing push frequency — behavioural, not a workflow fix; the orchestrator is already
  addressing it by batching commits (Q4).
- ⛔ Splitting `verify` into two separate jobs (one with the Postgres service, one without) to also
  save the service container's startup/health-check overhead on docs-only runs — a further
  optimisation beyond what was asked, left for later if that overhead turns out to matter once real
  numbers exist.
- ⛔ `deploy.yml`, `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md`, anything under `packages/`/`apps/`.

## Done when

- `.github/workflows/ci.yml` has the `changes` job, `verify` depends on it, and the four steps carry
  the `if:` condition.
- typecheck and unit run real and green, confirming this change doesn't touch application code.
- Self-reviewed line by line.
- The prediction above is on record, so the first real push can be checked against it.
- Report ends with a `FOR IAN` block.

See `.github/workflows/ci.yml`; `tests/unit/toc-freshness.test.ts`;
`tests/unit/production-caller-ratchet.test.ts`; `docs/ops/`.
