# T-259 — DEF-235: a preflight that fails closed on an empty or whitespace-padded secret

> **Status: RESERVED by the orchestrator, 2026-09-10. Unassigned. ⭐ IAN'S DECISION, 10 Sep:
> yes — add the preflight, fail closed.** Number reserved so no peer takes it. Nothing built.

## The failure this exists to stop, which has already happened once

A production deploy shipped with a **required value missing**. Nothing failed. The build succeeded,
the deploy succeeded, the workflow went green — and **the only signal was a person unable to sign
in.**

The mechanism, step by step:

1. A required secret was unset, so it arrived as an **empty string**, not as absent.
2. The build inlined that empty string into the artifact — which is what builds do.
3. Nothing asserted non-emptiness, because a value technically *was* present.
4. Green build → green deploy → broken app.

⛔ **Every existing safety net is INSIDE the app** — typecheck, unit, integration, build. This
failure lives in the gap between *"the build succeeded"* and *"the app works"*, and nothing
occupies that gap. It recurs on any deploy where a secret is rotated, mistyped, or pasted.

## Contract

- A preflight that runs **before** the build and **exits non-zero** if any required value is
  missing, empty, or `!== value.trim()`.
- ⚠️ **Trailing whitespace is the case that will actually bite.** A secret with a trailing newline
  is present, non-empty, and wrong — and copying from a console or a file brings one along. An
  emptiness check alone does NOT close this defect.
- The failure message **names the offending variable** and says which of the three it was (absent /
  empty / padded). A preflight that fails without naming the value moves the outage rather than
  preventing it.
- ⛔ **Never print the value**, only the variable name and the verdict.

## Watch out

- ⚠️ **Prove it fails.** Run it with a deliberately blanked required value and with one carrying a
  trailing `\n`, and watch it exit non-zero **before** trusting a green run. This project has
  shipped a guard that scanned nothing and reported success three times; a preflight that passes
  because it checked nothing is the same shape.
- ⚠️ `packages/core/src/env.ts` already has `blankAsAbsent()`, which turns blank into undefined for
  a set of variables. **Reuse the existing notion of "required" rather than inventing a second
  list** — two lists of required secrets will drift, and the drift is silent.
- ⚠️ `docs/ops` does not ship (DEF-194), so part of the deploy path is applied by hand on the
  droplet. Say plainly which half this preflight covers and which it does not.
- ⛔ **Never build on either droplet** (RULES §1 rule 11). Builds run in CI; the server receives a
  finished artifact.

## Out of scope

A post-deploy smoke check that hits the running app and confirms sign-in works. Ian considered it
and chose the preflight alone for now — it is the cheaper half and it catches the cause rather than
the symptom. Worth revisiting once this ships.

## Done when

- The preflight refuses a blanked value and a trailing-newline value, **watched failing**, and
  passes on a correct environment.
- It names the variable and the verdict, and never prints a value.
- It is wired into the deploy path ahead of the build.

See `docs/DEFECTS-REGISTER.md` DEF-235.
