# T-308 — nothing notices when production is running something older than `main`

> **STATUS: NUMBER RESERVED, SPEC NOT YET WRITTEN.** Allocated 2026-09-13 by the orchestrator
> (`system32-85`) after **Ian authorised building the guard**, in the same answer in which he
> authorised re-enabling `CI`. **Do not implement from this file** — write the spec first, in the
> format of `docs/tasks/2xx-*.md`, and have it approved. The analysis below is lane C's and is
> complete enough that the spec is a writing job, not a thinking job.

## The assertion — and it is deliberately NOT "CI is enabled"

⛔ **Assert DEPLOYED-REVISION LAG: production is running a commit older than `origin/main`, and
nobody said so.** That is the observable every silent failure in this project has actually shared:

| Defect | What happened | Caught by a lag check? |
|---|---|---|
| DEF-326 | The deployed build lacked the npm script its unit invoked | ✅ |
| DEF-327 | Migrate aborted **before** the symlink swap; host served the old release, 20 h | ✅ |
| DEF-330 | The manual recipe applies nothing and prints success | ✅ |
| DEF-336 | `CI` disabled by hand; every push inert, 9 h | ✅ |

⭐ **A "every commit has a CI run" assertion catches one of those four.** A lag assertion catches
all four **plus causes nobody has enumerated** — and in this project the enumeration is the thing
that keeps failing.

## ⛔ Why a workflow-state check is the wrong assertion — the counterexample is this defect

Throughout DEF-336, `gh` reported **`Deploy: active`**. But `deploy.yml:22-26` gates `Deploy` on
`workflow_run` of `CI`, and `CI` was disabled — so **`Deploy` was structurally dead while reporting
active.** A state check would have returned green on the worst possible day.

⚠️ **That is DEF-332's `systemctl list-timers` trap on a different provider.** Keep the state check
as a **detail line inside** the guard, so a symptom is reported with its cause; never as the
assertion itself.

## Placement — no substrate is invulnerable, and that is not the target

Bible **§15.11** already rules that *no layer may be the only one for a given risk* (DEF-210 is what
one layer looks like). So the job is not to find an invulnerable home; it is to pick a substrate
that fails **independently** and then **name the residual**.

| Candidate | Verdict |
|---|---|
| `Deploy`'s first step | ⛔ **Eliminated, not ranked.** `workflow_run`-gated on `CI`, so it is silent in exactly the scenario it detects. **Circular.** |
| A scheduled GitHub workflow | ⚠️ The guarded thing wearing a hat — same provider, same disablement, and GitHub has a named automatic sibling state, `disabled_inactivity`. There are zero `schedule:` triggers in the repo today |
| **A droplet timer** | ⭐ **Recommended primary.** Different machine, scheduler, provider and credential — the only genuinely independent substrate. `provision.sh` already installs units and eight jobs already report to `scheduler_runs` |
| A wrap-up ritual line | ⭐ **Recommended backstop**, not primary — it depends on a person |

⛔ **The residual, stated rather than hidden:** if the timer is never enabled **and** nobody runs the
wrap-up, both layers are silent. **That is DEF-332's own failure mode.** It is accepted as strictly
better than one layer that has already failed — but it must be written into DEF-336's row, not
discovered later.

⚠️ Lane C explicitly **did not** count "`scheduler_runs` staleness would catch a dead timer" as
mitigation: nothing currently reads that table for staleness.

## The enabling step — worth doing even if the guard is never built

**Production does not publish which commit it is running.** `deploy.yml:47` already resolves the
sha and never writes it anywhere; `apps/erp/src/app/api/health/route.ts` reports status,
configuration and database but **no version**. So *"which commit is production on?"* is today
answerable only by SSH plus inference from a directory timestamp — **a question asked repeatedly
during DEF-326 and DEF-327.**

⚠️ **Ian's decision inside this, flagged and not taken:** the cheapest place to publish the sha is
`/api/health`, which is **unauthenticated** — low sensitivity for a private product, but a real
disclosure. The private alternative is a file on the box, read over the existing deploy SSH path.
**Put this to him in plain language before building either.**

## ⛔ Why this is NOT bundled into T-307

They share a sentence — *nothing checks that CI is what we think it is* — and no substrate.

- **T-307** is static, pure-data, fast-unit-suite, no network, **shippable today**.
- **T-308** is runtime, out-of-band, needs a credential and a placement ruling from Ian.

**Bundling makes the decided cheap thing wait on the undecided one.** The precedent is in the
register: DEF-334's *"NOT to be bundled into T-299 — an isolation-strategy change, not a budget
tweak."*

⭐ **The pairing to remember: T-307 asserts CI's configuration is correct; T-308 asserts CI ran at
all.** A correct config that never executes is DEF-336; a running CI with a wrong env block is
DEF-328.

## Why it is worth its cost, in one line

**DEF-245's standing disposition makes `ci.yml` the only real integration gate** — quoted three
times in the 2026-09-13 handoff. **DEF-336 proved that sole gate can vanish leaving no trace.**
A sole gate that can silently vanish is not a gate, it is a habit.
