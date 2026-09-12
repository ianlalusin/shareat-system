# T-292 — DEF-315 items 3 and 2: the two settings worth more than the bucket

> **Status: READY 2026-09-12 — built by lane B (webapps-65), awaiting system32-85's own gate
> re-run before commit.** typecheck clean; `npm run test` (unit project) 103/103 files, 1400
> passed, 1 pre-existing skip, 0 failed — including 21 new/extended tests (3 offline synthetic for
> `checkValuesMatch`, 6 executed plant/control pairs against the real `loadServerEnv()`, plus the
> 12 pre-existing tests in `env.test.ts` that continue to pass unchanged, proving no regression).
> `.env.example` NOT edited — wording sent for review below. `deploy.yml:15`'s stale comment
> reported below, not touched.
> ⚠️ **Renumbered from T-289** by system32-85 (2026-09-12): `12ee067` landed T-289/290/291 first for
> an unrelated "position access defaults" plan. No file existed under the old number — nothing to
> rename. Every reference below uses **T-292**.
>
> ⛔ **Both findings below were independently verified at source by system32-85 and both correct a
> register row written the same afternoon** (DEF-315's own severity claim for `APP_TIMEZONE`). Three
> additions from the approval: (1) DEF-203 is now an OPEN QUESTION, not settled evidence — see
> Finding 1; (2) both duplication sites (`config-contract.ts`'s `checkValuesMatch` and `env.ts`'s
> inline copy) carry a comment naming the other and why they are not one shared function; (3)
> `.env.example`'s wording is proposed in this file but **not applied** — sent to system32-85 for
> review — and `deploy.yml:15`'s stale comment is reported as a defect row, not edited here.

Source: `docs/DEFECTS-REGISTER.md` DEF-315, items 3 (`APP_TIMEZONE`) and 2 (`FIREBASE_PROJECT_ID`),
in that order. Builds on T-280's `scripts/lib/config-contract.ts` (`9c33d80`).

## ⛔ Two things measured before designing, per instruction — and both change the design

### Finding 1 — `APP_TIMEZONE` is not merely unchecked. It is currently DECORATIVE.

DEF-315 item 3 says a wrong `APP_TIMEZONE` "shifts every business day boundary and every payroll
period quietly." **That consequence is not true today**, and it matters for what to build.

`packages/core/src/datetime.ts:19` — the module whose own header says *"The business timezone is
Asia/Manila, defined ONCE, imported everywhere"* — defines:

```ts
export const BUSINESS_TIMEZONE = 'Asia/Manila' as const;
```

A **hardcoded literal**, not a read of `env().APP_TIMEZONE`. Verified by an exhaustive,
whole-repo `grep` (`grep -rn "APP_TIMEZONE"`, every file type, `node_modules`/`.next`/`.git`
excluded) and by reading `datetime.ts` in full: the string `APP_TIMEZONE` appears in exactly seven
places in this entire repository — `.env.example`, `.env.local`, `.github/workflows/ci.yml`,
`packages/core/src/env.ts` (the schema, presence/default only), `docs/` (this task, the register,
`docs/ops/README.md`), and three test fixtures (`tests/unit/env.test.ts`,
`apps/erp/tests/firebase-auth-admin.test.ts`, `apps/erp/tests/setup-identity.test.ts`) that set it
as boilerplate because `env()`'s schema includes it, never because anything downstream reads the
resolved value. **`packages/core/src/datetime.ts` — the ONLY module that does business-day math —
is not in that list.** Also checked and ruled out: no `TZ=` environment wiring anywhere
(`grep -rn "process\.env\.TZ\b|\bTZ="` — one unrelated comment, no real wiring) that might route
`APP_TIMEZONE` into the Node process's own clock.

**So changing `APP_TIMEZONE` today does nothing.** `BUSINESS_TIMEZONE` and `APP_TIMEZONE` are two
independently-sourced values that happen to both say `Asia/Manila` today, with no code path
connecting them. This is wrong in a more interesting way than "unchecked": DEF-315's own row quotes
`.env.example:11-13` — *"payroll periods, attendance days and sales days all derive from this"* —
as the stated consequence, and **that sentence is false against the code.** Payroll and attendance
derive from `BUSINESS_TIMEZONE`, a hardcoded literal. So the documented expectation is not merely
unverified; **the documentation asserts a mechanism that does not exist.** Re-wiring `datetime.ts`
to actually consume `env().APP_TIMEZONE` is a real fix worth having — and is **out of scope here**:
`packages/core/src/datetime.ts` is not in this task's file list, and rewiring the one module every
business-day calculation in the app depends on is exactly the kind of change that needs its own
task and its own review, not a drive-by inside a config-contract task. **Reported, recommended as a
follow-on, not built.**

⚠️ **This puts DEF-203 in a new light, and it is an OPEN QUESTION — not chased here, per the
approval, but stated so the next reader does not assume the wiring is live.** DEF-203 recorded
`APP_TIMEZONE` being silently corrupted in production on 2026-09-06 and "restored" the same day.
Given `datetime.ts` does not read it today, either (a) the wiring existed on 2026-09-06 and was
removed sometime since without a row recording that removal, or (b) DEF-203's actual observed harm
was never business-day drift at all — the corruption glued `APP_TIMEZONE=Asia/ManilaDATABASE_URL=…`
into one line, which also made `DATABASE_URL` vanish from that env file, and a missing required
`DATABASE_URL` would refuse to boot loudly (bible §7 rule 9) before any date math ever ran. **Which
of the two is true is unresolved and is not this task's to settle.**

**What this changes about the design:** checking `env().APP_TIMEZONE` against the literal
`'Asia/Manila'` (T-280's `checkValueAgainstDocs` shape) would satisfy DEF-315's literal wording but
would be checking a value against a hand-copied constant that could itself go stale — exactly the
residual risk T-280's own file already names ("a hand-maintained copy of what the docs say TODAY").
**The stronger, more valuable check compares `env().APP_TIMEZONE` against `BUSINESS_TIMEZONE`
directly** — the REAL, currently-consumed source of truth, imported live, never hand-copied. That
check has zero staleness risk and is the one that would actually catch the two sources ever
diverging, which is the concrete shape of risk this investigation found. **`checkValueAgainstDocs`
is not used for `APP_TIMEZONE` at all in this design — a match-check against the real constant is
strictly better than a match-check against a literal, and building both would just be the weaker
one wearing a second hat.**

### Finding 2 — `FIREBASE_PROJECT_ID` and `NEXT_PUBLIC_FIREBASE_PROJECT_ID` never coexist in one process, in production, today.

DEF-315 item 2 says "nothing compares `FIREBASE_PROJECT_ID` to `NEXT_PUBLIC_FIREBASE_PROJECT_ID`."
True — and the reason is structural, not just an oversight, which decides how much this task can
actually close.

- `FIREBASE_PROJECT_ID` (server) is hand-maintained in `/srv/shareat-shared/.env.local` on the
  droplet and read by `loadServerEnv()` **at server runtime**.
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (client) is a GitHub Secret, read **only during the CI build
  step** (`.github/workflows/deploy.yml:70,80`) and inlined into the client bundle. Verified:
  `grep -n "secrets\.FIREBASE_PROJECT_ID\b" .github/workflows/deploy.yml` returns nothing — the
  server variable is never a GitHub Secret and never touches this workflow, despite an
  aspirational/stale comment at `deploy.yml:15` listing it alongside the `NEXT_PUBLIC_*` ones that
  actually are. `scripts/deploy-preflight.ts`'s own header already states this precisely: *"It does
  NOT cover... `FIREBASE_PROJECT_ID` (server)... None of those appear anywhere in `deploy.yml`."*
- Checked locally too, not assumed: `.env.local:34,51` has both KEYS present but **both blank**
  (`FIREBASE_PROJECT_ID=`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=`) — HANDOFF.md's own promise that
  Firebase values can stay blank until T-006, still in effect. So there is no environment on this
  machine, and no step in the current deploy pipeline, where both values are populated in the same
  `process.env` snapshot for a check to compare.

**What this changes about the design:** a check built inside `env.ts`/`.env.example`'s reach can
only ever compare the two values **when both happen to be visible in the same process** — which,
measured above, is never true in production today and is not true in local dev either until
someone configures real Firebase credentials on their own machine. **This task cannot close DEF-315
item 2's production risk** — that would need a NEW step with access to BOTH sources (e.g. a
deploy-time script with SSH access to the droplet's `.env.local`, comparing against the same
deploy's GitHub Secret), which is an ops/CI change outside `packages/core/src/env.ts` and
`.env.example`'s reach and outside this task's scope. **Reported as a candidate register row, not
built.** What IS worth building: a check that fires correctly whenever both values ARE visible
(protects local dev from the ordinary mistake of editing one and not the other, and costs nothing
when — as today — one side is absent), stated honestly as partial.

## The design question, answered

**Is `checkValueAgainstDocs` (exact value from a documented list) the right abstraction for either
of these two? No — for a sharper reason than "the shape doesn't fit."** Neither setting has a
literal to check against in the way the bucket did:

- `APP_TIMEZONE`'s real documented contract, once traced to its actual consumer, is *"matches
  `BUSINESS_TIMEZONE`"* — a relationship, not a literal.
- `FIREBASE_PROJECT_ID`'s documented contract is explicitly stated as a relationship
  (`.env.example:46-47`: *"This must match `NEXT_PUBLIC_FIREBASE_PROJECT_ID`"*) — never a fixed
  string.

**Both are `checkValuesDiffer`'s shape inverted: must MATCH, not must differ.** So this task adds
ONE new primitive, `checkValuesMatch`, to `scripts/lib/config-contract.ts` — not because the family
needs a third shape for symmetry, but because both real invariants here are relationships, and
`checkValueAgainstDocs` genuinely does not apply to either. `checkValueAgainstDocs` stays exactly
as scoped in T-280 (the bucket, and any FUTURE setting whose contract really is "equals this
literal") — not stretched, not touched.

## The value-provenance trap, answered

**`packages/core/src/env.ts` is the resolution layer, so — as the briefing named — "the resolved
value" and "the env var" are the same thing there.** That part carries over cleanly: whatever this
task checks inside `loadServerEnv()` operates on `parsed.data.*`, the exact value every caller of
`env()` receives, so there is no possibility of the checked value drifting from the used value —
if anything, this is a SIMPLER guarantee than T-280 had, because resolution and checking now happen
in the same function, not a separate script consuming a separate resolver.

**⛔ What does NOT carry over: T-280's assumption that the checking code can just IMPORT the
primitive.** `scripts/lib/config-contract.ts` lives under `scripts/`, and this project's own
directionality rule (bible §8 / RULES §1 rule 13 — *"packages never depend on apps"*, and by the
same logic never on scripts, which sit even further from the dependency root than apps) means
**`packages/core/src/env.ts` must never import from `scripts/lib/`.** T-280's consumer
(`storage-smoke.ts`) was itself a script — importing sideways within `scripts/` was fine. T-292's
consumer is a package. So:

- `checkValuesMatch` is still built and tested in `scripts/lib/config-contract.ts` (this task's
  given scope names that file, and it is the correct home for a primitive future SCRIPTS may use).
- `packages/core/src/env.ts`'s own enforcement is a small, **duplicated**, inline pair of
  comparisons — not an import. This is not a shortcut: three plain `if` conditions inside a
  function that already builds one error message is exactly the "three similar lines beat a
  premature abstraction" case, and forcing an import across a boundary that must not be crossed
  would be the wrong fix for a problem duplication solves cheaply and correctly.
- A `tests/unit/` guard proves the TWO surfaces agree in shape (the pure primitive's plant proof)
  and separately proves `loadServerEnv()`'s own inline checks fire correctly (executed against the
  real function, not reasoned about) — see Tests below.

## Scope

Only:
- `scripts/lib/config-contract.ts` — extend: add `checkValuesMatch`.
- `packages/core/src/env.ts` — extend: import `BUSINESS_TIMEZONE` from `./datetime` (same package,
  sibling file — not a directionality violation); add the two inline checks inside
  `loadServerEnv()`, folded into the existing "REFUSED TO START" banner error.
- `tests/unit/config-contract.test.ts` — new: offline plant proof for `checkValuesMatch`.
- `tests/unit/env.test.ts` — extend: executed proof that `loadServerEnv()`'s new checks fire.
- `docs/tasks/292-def-315-timezone-and-project-id-contracts.md` — this file.

⚠️ **`.env.example` is IN scope per the briefing but NOT edited by this task, per the approval**:
the wording drafted below is a factual claim about the system (that `APP_TIMEZONE` is currently
inert) and system32-85 wants to read it before it lands. Sent for review, not applied.

Not touched: `.env.example` (wording proposed, held for review — see below),
`packages/core/src/datetime.ts` (Finding 1's real fix — reported, not built),
`.github/workflows/deploy.yml` (Finding 2's real fix, AND its own stale comment at `:15` —
reported as a defect row with exact text, not edited here), `apps/erp/**`,
`packages/domain/src/stores/**`, `packages/db/src/repo/stores.ts` (`webapps-f7` live in all three),
`docs/plans/**`, `PROJECT_BIBLE.md`, `docs/CAPABILITY-GAPS.md`, `docs/CROSS-APP-MAP.md`,
`docs/decisions/CAPABILITY-MATRIX.md`, `docs/DEFECTS-REGISTER.md`, `docs/ops/README.md`, the
frozen T-279/T-280 files.

## Contract

### `scripts/lib/config-contract.ts` — one addition

```ts
/**
 * The inverse of `checkValuesDiffer`: two variables that MUST hold the same value. `mustMatch`'s
 * value may be undefined/blank — absence is treated as "nothing to compare," not a contradiction,
 * matching `checkValuesDiffer`'s existing convention for its own optional side. This is what makes
 * the check safe to run unconditionally: it is a no-op whenever one side is not visible, which —
 * measured, not assumed — is the common case for both of this task's two uses today.
 */
export function checkValuesMatch(
  primary: { envVar: string; value: string },
  mustMatch: { envVar: string; value: string | undefined },
  citation: string,
  consequence: string,
): ConfigContractResult;
```

### `packages/core/src/env.ts` — inline, not imported

```ts
import { BUSINESS_TIMEZONE } from './datetime';

// inside loadServerEnv(), after `parsed.success` is confirmed true:
const cfg = parsed.data;
const contractFailures: string[] = [];

if (cfg.APP_TIMEZONE !== BUSINESS_TIMEZONE) {
  contractFailures.push(
    `APP_TIMEZONE is "${cfg.APP_TIMEZONE}" but packages/core/src/datetime.ts:19's ` +
      `BUSINESS_TIMEZONE — the value every business-day calculation actually uses — is ` +
      `"${BUSINESS_TIMEZONE}". DEF-315: these must match or one of them is silently wrong.`,
  );
}

const nextPublicProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() || undefined;
if (cfg.FIREBASE_PROJECT_ID && nextPublicProjectId && cfg.FIREBASE_PROJECT_ID !== nextPublicProjectId) {
  contractFailures.push(
    `FIREBASE_PROJECT_ID is "${cfg.FIREBASE_PROJECT_ID}" but NEXT_PUBLIC_FIREBASE_PROJECT_ID is ` +
      `"${nextPublicProjectId}". .env.example:46-47: if the browser signs in against one project ` +
      'and the server verifies against another, every correct password is rejected as ' +
      'unverifiable.',
  );
}

if (contractFailures.length > 0) {
  throw new Error(/* same banner shape formatIssues() already produces, contractFailures joined */);
}
```

Both checks run **unconditionally, in every `NODE_ENV`** — not gated to production. Reasoning:
`APP_TIMEZONE`'s check can never legitimately fail in a correctly-configured environment, dev or
prod, since the default and the hardcoded constant already agree; making it universal catches a
typo in local dev as loudly as in production, which is strictly better than a prod-only carve-out
that exists elsewhere in this file for a different reason (Firebase credential PRESENCE being
optional pre-T-006, per HANDOFF.md — a different axis than value-correctness).

## Invariants, with citations

1. **`env().APP_TIMEZONE` equals `BUSINESS_TIMEZONE` (`packages/core/src/datetime.ts:19`), always.**
   Not equals a hand-copied literal — equals the real, live-imported constant.
2. **When both `FIREBASE_PROJECT_ID` and `NEXT_PUBLIC_FIREBASE_PROJECT_ID` are visible in the same
   process, they are equal.** (`.env.example:46-47`.) Silent when either is absent — that is the
   honest, measured scope of what this check can see (Finding 2).
3. **`checkValuesMatch` never treats an absent counterpart as a mismatch** — mirrors
   `checkValuesDiffer`'s own convention for the same reason: a variable this project explicitly
   allows to stay blank (HANDOFF.md §4, pre-T-006) must not be punished for being blank.

## ⛔ What this check CANNOT see, named explicitly

- **It does not make `APP_TIMEZONE` do anything.** The check proves the documented lever and the
  real lever agree; it does not connect the documented lever to any actual behavior. If someone
  changes `BUSINESS_TIMEZONE` in `datetime.ts` without updating `.env.example`/`.env.local`, this
  check now catches that (new value) — but the reverse story DEF-315 was filed about, "a wrong
  `APP_TIMEZONE` silently shifts business days," remains impossible until `datetime.ts` is rewired
  to actually read it. Recommended as a follow-on; not this task's to build.
- **It cannot see production's real `FIREBASE_PROJECT_ID`/`NEXT_PUBLIC_FIREBASE_PROJECT_ID` pairing
  at all**, ever, as currently deployed — Finding 2. A green run of this check proves nothing about
  whether the droplet's hand-set value matches the last deploy's GitHub Secret. Closing that gap
  needs a script with access to both sources, which does not exist today and is not built here.
- **It cannot see a `NEXT_PUBLIC_FIREBASE_PROJECT_ID` set only at CI build time** — Next.js inlines
  it into the client bundle; nothing about a later server process re-reading `process.env` can
  recover the value the browser actually received if the build-time and runtime environments
  differ, which is exactly Finding 2's shape.

## Tests

### Pass A — `checkValuesMatch`, offline, synthetic (`tests/unit/config-contract.test.ts`)

- Matching values → `ok: true`.
- Mismatched values → `ok: false`, message names both variables and the citation.
- `mustMatch.value` undefined → `ok: true` (absence is not a contradiction) — the control that
  proves this primitive is safe to call unconditionally.

### Pass B — `loadServerEnv()`'s own checks, executed against the real function (`tests/unit/env.test.ts`)

Using the same fixture-env pattern this file already establishes (`process.env = {...BASE}` in
`beforeEach`, `vi.resetModules()`):

- **Plant: `APP_TIMEZONE: 'UTC'`** (or any value ≠ `Asia/Manila`) → `loadEnv()` rejects, message
  contains `BUSINESS_TIMEZONE`.
- **Control: `APP_TIMEZONE: 'Asia/Manila'`** (the existing `BASE` already does this) →
  `loadEnv()` resolves — proves the plant above is the CHECK firing, not something else broken.
- **Plant: `FIREBASE_PROJECT_ID` and `NEXT_PUBLIC_FIREBASE_PROJECT_ID` both set, different values**
  → `loadEnv()` rejects, message names both.
- **Control: same two, EQUAL values** → resolves.
- **Control: `FIREBASE_PROJECT_ID` set, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` absent** (today's actual
  shape, measured in Finding 2) → resolves — the executed proof that this check is a genuine no-op
  in the environment it will actually run in, not merely reasoned to be one.

## `.env.example` wording (drafted here for approval, not yet applied)

`APP_TIMEZONE`'s comment gains one line: *"⚠️ Currently NOT read by `packages/core/src/
datetime.ts`'s `BUSINESS_TIMEZONE`, which is hardcoded to the same value — `env()` enforces that
the two never disagree, but changing this variable alone changes nothing yet (see [defect number
system32-85 assigns] for the re-wiring)."*

`FIREBASE_PROJECT_ID`'s comment gains one line: *"⚠️ `env()` compares this to
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` whenever both are visible in the same process — which, today, is
never true in production (the two are set by disconnected mechanisms; see [defect number] for the
gap) and only true in local dev once both are configured by hand."*

## Out of scope — reported as candidate register rows, not filed by this task

1. **Re-wire `packages/core/src/datetime.ts`'s `BUSINESS_TIMEZONE` to read `env().APP_TIMEZONE`**
   (or formally document that it is intentionally independent and why) — Finding 1. Touches the one
   module every business-day calculation depends on; needs its own task and review.
2. **A deploy-time (or droplet-side) check comparing the real `FIREBASE_PROJECT_ID` against the
   GitHub Secret used for the corresponding build** — Finding 2. An ops/CI change, not an
   `env.ts`/`.env.example` one.
3. **`.github/workflows/deploy.yml:15`'s comment is stale/misleading** — it lists `FIREBASE_PROJECT_ID`
   as a needed GitHub Secret alongside the `NEXT_PUBLIC_*` ones that actually are, when it is in
   fact never read from Secrets by this workflow. A one-line correction, not `env.ts`'s to make.

## Done-when

typecheck clean · `npm run test` (unit project) green, including Pass A's synthetic states and Pass
B's executed plant/control pairs for both checks, with real output reported · `env.ts` read
line-by-line to confirm the two new checks fold into the existing banner error rather than
replacing it · self-reviewed · this file's status line updated to READY · Findings 1 and 2 and the
three out-of-scope items reported to system32-85 as candidate register rows.
