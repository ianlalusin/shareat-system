# T-280 — DEF-311's surviving lesson: nothing compares the deployed config against the documented one

> **Status: READY 2026-09-12 — built by lane B (webapps-65), awaiting system32-85's own gate
> re-run before commit.** typecheck clean; `npm run test` (unit project) 100 files / 1377 passed,
> 1 pre-existing skip, including the 9 new tests (States 1-4 + message-content, all executed);
> State 0 left labelled as inspection-plus-incident, not execution, per the approval.

Source defect: `docs/DEFECTS-REGISTER.md` DEF-311, closing paragraph. The bucket misconfiguration
is FIXED. What is open is that all five `storage-smoke` checks went green against the wrong
bucket, and the correct value was documented in two places. Nothing compared the deployed value
against either.

## The answer to the briefing's question, first, per instruction

**Count: four clear instances, plus one weaker/borderline one — not one.** Swept `.env.example`,
`docs/ops/README.md`, `docs/reference/` (one file), `docs/decisions/` (thirteen files). `docs/
decisions/` contributed nothing — the only env-var hit there (`ADR-012:160`) is a migration
invocation instruction, not a claim about what a deployed value ought to be.

⭐ **Item 4, `APP_TIMEZONE`, is the headline, not an equal row in the table below.** It is a
*second, independent, already-executed* instance of this exact class — `docs/ops/README.md:131-132`
records that it was silently corrupted in production once already (DEF-203), the same shape as
DEF-311 but against a different variable, caught only because a person happened to notice. And its
blast radius is wider than the bucket's: every payroll period, attendance day and sales day
boundary derives from it (`.env.example:11-13`), where the bucket's exposure was gated behind
production holding at least one organisation. A reader who stops at the table below will see five
rows of equal weight; they are not equal.

| # | Value | Documented expectation | Cited | Checked? |
|---|---|---|---|---|
| 1 | `FIREBASE_STORAGE_BUCKET` | Must be exactly `shareat-hub-v2`; must NOT be `shareat-hub-v2.firebasestorage.app` or `...appspot.com` | `.env.example:55-60`, `docs/reference/private-bucket-storage-rules.md:62-63`, `docs/ops/README.md:75-96` | **Never.** `packages/core/src/env.ts:107` (`blankAsAbsent()`) and `packages/storage-firebase/src/index.ts:113` (`firebaseConfigFromEnv`) both accept ANY non-blank string. `storage-smoke.ts`'s five checks prove reachable+private+signed+deletable, never the name — confirmed by reading checks 1,2,4,5: none reads `cfg.bucket` for anything but passing it to the SDK. This is DEF-311 itself, and it is not hypothetical: production ran this exact wrong value for the deployment's entire life and all five checks passed, for real, every time. |
| 2 | `FIREBASE_STORAGE_BUCKET` ≠ `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | The two "must never hold the same value" | `.env.example:56,71-73` (also `packages/core/src/env.ts:95-96`, outside the swept doc set but corroborating) | **Never.** Same evidence as #1 — no code path compares the two variables. |
| 3 | `FIREBASE_PROJECT_ID` | Must equal `NEXT_PUBLIC_FIREBASE_PROJECT_ID` — "If the browser signs in against one project and the server verifies against another, every correct password is rejected as unverifiable." | `.env.example:46-47` | **Never.** `tests/unit/env.test.ts` validates each independently (presence, blankness, production-required) but asserts no relationship between their VALUES anywhere in the file. |
| 4 | `APP_TIMEZONE` | Must be `Asia/Manila` — "payroll periods, attendance days and sales days all derive from this" | `.env.example:11-13`; incident record at `docs/ops/README.md:131-132` (DEF-203: silently corrupted in production once already) | **Never**, as a value. `packages/core/src/env.ts:42` only supplies `Asia/Manila` as a *default* when unset (`z.string().trim().min(1).default(...)`) — an explicit wrong value (`UTC`, a typo) passes validation untouched. DEF-203's restoration was verified by a person reading the file, not by a gate. |
| 5 (borderline) | `DATABASE_URL` (production) | "the DO Managed Postgres PRIVATE/VPC connection string (`sslmode=require`)" | `.env.example:16-20` | **Never as a standing gate.** `serverSchema` (`packages/core/src/env.ts:44-50`) checks only the `postgres://`/`postgresql://` prefix. The one time `sslmode` mattered (DEF-203) it was a human's ad hoc `grep -c sslmode` disagreement during an unrelated incident, not a repeatable check. Weaker than 1-4: the doc phrasing is descriptive ("the DO Managed Postgres... string") rather than the imperative "must be" the other four use, and DO's connection string already carries `sslmode=require` by construction — so this is closer to "nothing would catch a hand-edited string that dropped it" than a live incident. Included for completeness, not as a design driver. |

**Considered and excluded:** the `doadmin`/`shareat_app_prod` role-bypass topology in `docs/ops/
README.md:16-54` (`SYSTEM_DATABASE_URL` must resolve to a BYPASSRLS role, `DATABASE_URL` must
not) is real and undocumented-as-checked, but it is a claim about what a connection **does** when
used (a live `pg_roles.rolbypassrls` query), not a static string comparable to a documented
literal — a fundamentally different mechanism from items 1-5. Naming it here so it is not lost,
but it is not this task's shape and does not belong folded into a config-vs-docs string check.
The `ADR-002` Spaces backup bucket (`shareat-erp-backups`) was also checked and excluded: no env
var or code path in this repo reads a backup-bucket name at all, so there is nothing here to
compare against documentation.

## What this answer decides

Four-to-five, not one. **A one-off assertion bolted onto `storage-smoke.ts` would fix DEF-311's
literal instance and leave the class open** — items 3 and 4 would still silently pass with the
wrong value tomorrow. The right shape is a small, reusable primitive that compares an actual
deployed value against a documented one and produces a loud, specific failure — built once in
`scripts/lib/`, wired into `storage-smoke.ts` for item 1+2 today (the only instance actually in
this task's scope and the only one with a runnable script to attach it to), and left in a shape
the next lane can point at items 3 and 4 without re-deriving the pattern.

⛔ **Items 3, 4, and 5 are NOT built here.** `packages/core/src/env.ts`, `.env.example`, and
`docs/ops/README.md` are all outside this task's scope (system32-85 owns edits to the first via
report, and to the latter two directly per the briefing). **Update, post-approval: system32-85 has
already filed `DEF-315`** covering items 2, 3, 4 and the borderline 5, citing this spec's table as
the measured source, and recorded the excluded `rolbypassrls` topology so it is not folded in by
analogy later. No further reporting of these is needed from this task.

## Scope

Files created or modified:
- `scripts/lib/config-contract.ts` — new. The reusable primitive plus the one populated
  expectation this task needs.
- `scripts/storage-smoke.ts` — modified. A new pre-flight check, before the five existing
  numbered checks, using the primitive above.
- `tests/unit/storage-bucket-config-contract.test.ts` — new. Unit-tests the primitive directly,
  offline, no Firebase credentials.
- `docs/reference/private-bucket-storage-rules.md` — modified. §4's "Still all five green" needs
  updating once a sixth, unnumbered pre-flight check exists.
- `docs/tasks/280-def-311-config-vs-documented.md` — this file.

Not touched: `packages/core/src/env.ts`, `.env.example`, `docs/ops/README.md`,
`docs/DEFECTS-REGISTER.md`, `packages/storage-firebase/**`, `packages/db/**`,
`packages/domain/**`.

## Contract

### `scripts/lib/config-contract.ts`

```ts
export interface ConfigExpectation {
  envVar: string;
  allowedValues: readonly string[];
  citations: readonly string[];
  consequence: string;
}

export interface ConfigContractResult {
  envVar: string;
  ok: boolean;
  actual: string;
  message: string;
}

/** Pure. Takes the ALREADY-RESOLVED value the app will actually use (e.g. `cfg.bucket`), never
 *  re-reads `process.env` itself, so it can never drift from what the caller is really doing. */
export function checkValueAgainstDocs(
  actual: string,
  expectation: ConfigExpectation,
): ConfigContractResult;

/** DEF-311. The one populated expectation this task wires up. */
export const STORAGE_BUCKET_EXPECTATION: ConfigExpectation = {
  envVar: 'FIREBASE_STORAGE_BUCKET',
  allowedValues: ['shareat-hub-v2'],
  citations: [
    '.env.example:55-60',
    'docs/reference/private-bucket-storage-rules.md:62-63',
  ],
  consequence:
    'DEF-311: every receipt, payment proof and export would be written to a bucket ' +
    'this project does not control — reachable and private, so every existing check would ' +
    'still pass.',
};

/** .env.example:56,71-73 — the two must never hold the same value. Pure, so the test can call it
 *  directly instead of only reading the equality condition inline in storage-smoke.ts. */
export function checkValuesDiffer(
  primary: { envVar: string; value: string },
  mustDiffer: { envVar: string; value: string | undefined },
  citation: string,
): ConfigContractResult;
```

Both `checkValueAgainstDocs` and `checkValuesDiffer` return a result rather than throwing —
`storage-smoke.ts` decides how to fail loudly (it already has `bad()`), and a pure return value is
what the unit test asserts against without needing to catch anything.

### `scripts/storage-smoke.ts`

New pre-flight block, inserted after `firebaseConfigFromEnv()` resolves `cfg` and before check 1
(checks 1-5 keep their current numbers — DEF-311's own register row already cites "check 3" by
number, and that citation must keep meaning what it says):

```ts
// PRE-FLIGHT — configuration vs documentation (DEF-311). Reachability proves nothing about
// whether this is the RIGHT bucket; v1's bucket is reachable and private too.
const bucketCheck = checkValueAgainstDocs(cfg.bucket, STORAGE_BUCKET_EXPECTATION);
if (!bucketCheck.ok) bad(bucketCheck.message);
ok(`FIREBASE_STORAGE_BUCKET matches documentation (${cfg.bucket})`);

const publicBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
const differCheck = checkValuesDiffer(
  { envVar: 'FIREBASE_STORAGE_BUCKET', value: cfg.bucket },
  { envVar: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', value: publicBucket },
  '.env.example:56,71-73',
);
if (!differCheck.ok) bad(differCheck.message);
ok('FIREBASE_STORAGE_BUCKET is not the public default bucket');
```

## Invariants, with citations

1. **A deployed `FIREBASE_STORAGE_BUCKET` that disagrees with `.env.example:55-60` and
   `docs/reference/private-bucket-storage-rules.md:62-63` fails `storage-smoke` before any network
   call, not after five green ones.** (DEF-311's closing paragraph.)
2. **A deployed `FIREBASE_STORAGE_BUCKET` equal to `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` fails
   `storage-smoke`.** (`.env.example:56,71-73`.)
3. **`checkValueAgainstDocs` never reads `process.env` itself** — it takes the resolved value as
   an argument, so the thing being checked and the thing the driver actually uses cannot diverge
   by construction.

## ⛔ What this check CANNOT see, named explicitly

- **It cannot see the Firebase console.** The bucket's actual Storage rules (deny-all vs.
  world-readable) live there and nowhere in this repo can read them. `storage-smoke` checks 1-5
  already cover reachability/privacy for whichever bucket is configured; this new check only adds
  "is it the RIGHT bucket," which checks 1-5 have never covered and cannot be made to cover from
  here.
- **It cannot see whether `.env.example` or the reference doc's own citation has drifted from
  Ian's actual intent.** `STORAGE_BUCKET_EXPECTATION.allowedValues` is a hand-maintained copy of
  what those two files say today. If a future PR changes the correct bucket name and edits both
  docs but not this constant, the check would enforce the STALE value and fail the correct one —
  a smaller, more visible version of DEF-311's own shape, but not eliminated by it. The mitigation
  is that a wrong constant here fails LOUDLY and immediately (a same-day `storage-smoke` run), not
  silently for the life of a deployment.
- **It cannot see production without being run there**, and this task will not run `npm run
  storage-smoke` against any real bucket without asking first, per the briefing's standing
  instruction. Live verification is deferred to that ask.
- **It says nothing about items 3, 4, and 5 above** (`FIREBASE_PROJECT_ID`, `APP_TIMEZONE`,
  `DATABASE_URL`/`sslmode`). Those are real, cited, and out of scope — reported, not silently
  worked around.

## Tests

All offline, in `tests/unit/storage-bucket-config-contract.test.ts`. No Firebase credentials, no
network. `checkValueAgainstDocs` is a pure function; every state below asserts its return value
directly.

⚠️ **Labelled per the approval, exactly: State 0 below is evidenced by INSPECTION and by a cited
INCIDENT, NOT by execution.** It is not run today. This project's rule is that only a planted
violation, actually run, proves a check was blind — an unlabelled citation standing in for a run
is the exact costume this cycle keeps finding, so this is named plainly rather than left implicit.

**State 0 — NOT EXECUTED. Evidenced by inspection of checks 1,2,4,5 (none reads `cfg.bucket` for
anything but passing it to the SDK — reachability and privacy are bucket-name-agnostic by
construction) plus DEF-311's own register row, which records that production actually ran
`FIREBASE_STORAGE_BUCKET=shareat-hub-v2.firebasestorage.app` for the deployment's entire life and
all five `storage-smoke` checks passed, every run.** That is the real "OLD check + planted wrong
value = GREEN" state, already executed once, for real, against real production — but not
re-executed by this task. Why not: there is no second real bucket to plant against safely, and the
briefing gates any live `storage-smoke` run behind asking system32-85 first. **This leg is weaker
evidence than States 1-4 below, and is reported as such rather than presented as a run.**

States 1-4 below ARE executed, not reasoned — `npm run test` is run and its literal output
(pass/fail per test name) is quoted in the READY report, not summarised.

- **State 1 — NEW check + the actual historical wrong value, EXECUTED:**
  `checkValueAgainstDocs('shareat-hub-v2.firebasestorage.app', STORAGE_BUCKET_EXPECTATION).ok`
  → asserted `false`.
- **State 2 — NEW check + the other documented-wrong variant, EXECUTED:**
  `checkValueAgainstDocs('shareat-hub-v2.appspot.com', STORAGE_BUCKET_EXPECTATION).ok` → asserted
  `false`.
- **State 3 — NEW check + the correct value, EXECUTED:**
  `checkValueAgainstDocs('shareat-hub-v2', STORAGE_BUCKET_EXPECTATION).ok` → asserted `true`.
- **State 4 — the differs-from-NEXT_PUBLIC guard, EXECUTED, plant and clear:** the equality
  condition `storage-smoke.ts` uses is extracted as its own small pure function (not left
  inline-only, so it is directly callable from the test rather than merely readable) and asserted
  three ways: fails when both variables hold the same string, passes when they differ, passes when
  the public one is unset.
- **Message content, EXECUTED:** a test asserts the failure message string from State 1 contains
  both citations (`.env.example:55-60` and `docs/reference/private-bucket-storage-rules.md:62-63`),
  so the loud failure actually points somewhere rather than merely existing.

## Out of scope

- `packages/core/src/env.ts`, `.env.example`, `docs/ops/README.md` — items 3/4/5 above live here;
  reported to system32-85, not edited.
- `docs/DEFECTS-REGISTER.md` — new rows for items 3/4/5 are system32-85's to file.
- Any live run of `npm run storage-smoke` against a real bucket — asked for separately if needed.
- `packages/storage-firebase/**`, `packages/db/**`, `packages/domain/**` — read for verification
  only.

## Done-when

typecheck clean · `npm run test` (unit project) green, including the new file, with States 1-4's
literal pass/fail output reported verbatim (not summarised) and State 0 labelled as
inspection-plus-incident, not execution · `storage-smoke.ts`'s new block read line-by-line against
checks 1-5 to confirm no renumbering broke DEF-311's "check 3" citation ·
`docs/reference/private-bucket-storage-rules.md` §4 updated to match the new check count ·
self-reviewed · this file's status line updated to READY.
