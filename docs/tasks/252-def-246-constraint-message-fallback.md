# T-252 — DEF-246: sanitise the constraint-failure fallback, then count the hits

> **Status: SPEC, round 1 — written by lane webapps-00, in plan mode, 2026-09-10. Awaiting
> `APPROVED`. Nothing built yet.**

## 0. What this is, in one sentence

`errorMessage()` (`apps/erp/src/lib/constraint-messages.ts`) falls through to raw Postgres driver
text whenever no `CONSTRAINT_MESSAGES` key matches; sanitise that fallback so it can never render
driver text again, and build (but do not yet wire in) a recorder — reusing T-245's counter table —
so a future task can measure which unmapped constraints are actually hit before anyone writes 420
hand-written sentences for paths that may never fire.

See `docs/DEFECTS-REGISTER.md` DEF-246 and **PROJECT_BIBLE.md §13 row 189**.

## 1. Scope — files this task creates or modifies (once APPROVED)

**Modify**: `apps/erp/src/lib/constraint-messages.ts` — sanitise `errorMessage()`'s fallback; add
`parseConstraintName` and a separate, explicitly-invoked `recordConstraintRefusal` (§4).

**Create**: `packages/domain/src/shared/constraint-refusals.ts` (the recorder, §5),
`apps/erp/src/lib/constraint-messages.test.ts` (unit),
`packages/domain/tests/integration/constraint-refusals.test.ts` (integration).

**Not touched**: the 48 action files that currently produce a user-facing error message (§2 —
this is a caller-signature question, named as a finding rather than a sweep I start, per the
briefing). `packages/db/schema/prerequisite-refusals.ts`, `packages/db/src/repo/prerequisite-refusals.ts`
(reused as-is), any migration, `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`.

## 2. ⭐ Finding: DEF-246's "48 action files" is ~40 independent copies, not one call site

A repo-wide grep for `errorMessage(` under `apps/erp/src` matched 47 files. Reading them sorts
into three shapes, not one:

| Pattern | Count | Consequence |
|---|---|---|
| Imports `errorMessage` directly from `constraint-messages.ts` | 9 files — `payroll/actions.ts`, `payroll/separations/actions.ts`, `payroll/thirteenth-month/actions.ts`, `setup/actions.ts`, `settings/expense-categories/actions.ts`, `settings/organization/actions.ts`, `settings/sales-channels/actions.ts`, `settings/wastage-monitor/actions.ts`, `settings/attendance/actions.ts` | Fixing the shared function fixes these 9 with **zero caller edits** — same exported signature, same call shape. |
| Imports only the `CONSTRAINT_MESSAGES` map and re-implements its own loop + its own fallback | 2 files — `remittance/actions.ts`, `till/actions.ts` | Each also keeps its **own local, screen-specific `CONSTRAINT_MESSAGES`** (a deliberate pattern — see `inventory/locations/actions.ts:33`, `inventory/counts/actions.ts:43`: *"`constraint-messages.ts` is shared and not this task's to edit… each screen keeps its own"*). Fixing the shared file does **not** touch these two. |
| Defines its own independent `errorMessage`/`errorMessageOf`, no reference to `CONSTRAINT_MESSAGES` at all — a role-denial regex translator plus a bare `raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '')` (or no stripping at all, in `fixed-assets`/`expenses`) | ~36 files | **100% unaffected** by any change to `constraint-messages.ts`. |

**The third row includes `cash-requests/actions.ts`, `loans/actions.ts`, `ap/actions.ts`,
`money-transfers/actions.ts` — the exact four files DEF-246 itself names as motivating examples**
(`cash_requests_amount_positive_check`, `loans_principal_positive_check`,
`ap_payments_amount_positive_check`, `money_transfers_distinct_accounts_check`). Verified by
reading each file directly, not inferred from the grep alone.

**So sanitising the one shared `errorMessage()` — the only lever this task's scope permits — does
not by itself stop DEF-246's own named examples from leaking raw driver text.** This is the same
failure shape DEF-242 already named for this project generally: a fix that touches the shared
piece but leaves ~40 hand-copied neighbours untouched has moved the defect, not removed it.

**What this task does about it, within its permitted scope:**
1. Ships the sanitised fallback + recorder in the one file this task may touch — the 9 files
   that already route through it are fixed today with zero caller edits.
2. Names the remaining ~38 files here, for the **orchestrator to log** as a follow-up
   DEFECTS-REGISTER row — a mechanical slice-2-shaped task (swap each local duplicate's raw
   fallback for the shared, now-safe generic sentence; no redesign, since §4's contract does not
   change). This spec does not write to `DEFECTS-REGISTER.md` (out of scope).
3. **T-252 does not close DEF-246 for the money screens.** It closes the shared file and builds
   the counter. DEF-246 should stay open, narrowed to "the ~38-file sweep," until that follow-up
   lands — recorded in §10.

## 3. The hard question: `errorMessage()` has no orgId, and `prerequisite_refusals.org_id` is NOT NULL

`errorMessage(err: unknown): string` is synchronous, pure, and called deep in each of the 9
call sites' catch blocks purely for its return value (`back('/x', { error: errorMessage(err) })`).
None of those 9 call sites may be edited in this task, so any change must keep `errorMessage(err)`
callable exactly as today, with the same synchronous `string` return.

**Three shapes considered:**

1. **`errorMessage()` reaches for ambient request context itself** (calls `requireActor()`
   internally, fire-and-forgets the recording, keeps the return synchronous). Rejected: turns a
   "presentation-layer helper" into something that secretly depends on Next.js request context
   and writes to the database — surprising to any reader, untestable without a request context,
   and a fire-and-forget promise racing the containing server action's own lifecycle is exactly
   the silent-loss shape T-245 was built to stop guessing about. Reintroducing that risk to save
   one integration point is a bad trade.
2. **Make `errorMessage()` async, require `await` at every call site.** Rejected outright: without
   editing the 9 call sites (out of scope), `error: errorMessage(err)` silently becomes
   `error: "[object Promise]"` — a regression, not a fix.
3. **Keep `errorMessage()` synchronous and pure (sanitisation only); add a second, separately
   named, explicitly-invoked async export for recording, which no current caller invokes yet.**
   **Chosen.** This is the answer the briefing pre-authorised: *"If the honest answer is that
   instrumentation must live somewhere other than `errorMessage()` itself, say so — that is a
   finding, not a failure."*

**Consequence, stated plainly:** this task builds and fully tests the recorder, but **wiring it
into any real request path is a follow-up task** — it needs `orgId` threaded from the `actor`
every caller already holds, which is a caller edit, out of scope here (§9).

## 4. Contract — `apps/erp/src/lib/constraint-messages.ts`

```ts
/** Unchanged signature, unchanged for every existing caller. Sanitisation only — no side effects,
 *  no DB, no async. Falls through to a GENERIC but presentable sentence instead of raw driver
 *  text when no CONSTRAINT_MESSAGES key matches AND parseConstraintName finds a name. Anything
 *  else (a plain domain Error, a non-constraint driver error) keeps today's behaviour: strip a
 *  leading `Ctor: ` prefix and show the rest verbatim — bible row 189 is scoped to constraint
 *  failures, not to every error this function has ever seen. */
export function errorMessage(err: unknown): string;

/** Extracts a constraint/index name from raw Postgres driver text — the `constraint "name"`
 *  shape shared by CHECK and unique violations (constraint-messages.ts:56-57 already documents
 *  the constraint/index name parity this relies on). Returns null for anything else, so
 *  non-constraint errors are never affected. Exported so a future caller-sweep can decide
 *  whether to also call recordConstraintRefusal without re-deriving this parse. */
export function parseConstraintName(raw: string): string | null;

/** NEW. Not called by any existing caller in this task — see §3. A future caller threads its own
 *  `actor` into this once the caller-sweep lands. Thin wrapper around the domain module (§5);
 *  this file is presentation-layer and already imports domain functions the same way every
 *  action file does. */
export async function recordConstraintRefusal(input: {
  orgId: string;
  storeId: string | null;
  actorPersonId: string | null;
  constraintName: string;
}): Promise<void>;
```

**Sanitised fallback wording**: a single line (no `\n` — the `/setup` screen's
`pre-session-message.ts`'s `looksLikeADump` treats any multi-line message as a dump regardless of
source, and a constraint sentence has no reason to differ), naming the record type in plain words
where derivable from the relation name, otherwise a safe generic ("That change isn't allowed —
please check the values you entered."). Exact copy is an implementation-time choice within this
contract.

## 5. Contract — `packages/domain/src/shared/constraint-refusals.ts` (new)

```ts
/** Mirrors packages/domain/src/attendance/credentials.ts's recordPrerequisiteRefusal in
 *  mechanism, byte for byte: an INDEPENDENT transaction via withOrgPrincipal — never the
 *  caller's own tx, T-245 proved why empirically (packages/db/src/rls/principal.ts:111) — with
 *  `set local lock_timeout = '2s'` as the same defence-in-depth against FK-lock contention, the
 *  write caught and logged on failure, never rethrown in place of the real refusal. Writes into
 *  the EXISTING prerequisite_refusals table (§6) — reuse, not a second counter — with
 *  domain: 'constraint' and reasonCode: constraintName. */
export async function recordConstraintRefusal(input: {
  orgId: string;
  storeId: string | null;
  actorPersonId: string | null;
  constraintName: string;
}): Promise<void>;
```

**Why `packages/domain/src/shared/`, not a new top-level directory:** it is already this
project's home for logic used by more than one domain and owned by none in particular (see
`straight-line.ts`'s own docstring on why shared code lives once rather than being hand-copied and
drifting). This is the first DB-touching module placed there; the directory's convention is
"shared by callers that would otherwise duplicate it," not "pure functions only," and this is
exactly that case.

## 6. Reuse, don't rebuild — the table

Per the orchestrator's pre-verified facts: `prerequisite_refusals.domain` and `.reasonCode` are
both plain `text` NOT NULL with no CHECK constraint (`packages/db/schema/prerequisite-refusals.ts:39,111`),
so `domain: 'constraint'` and `reasonCode: <constraint name>` need **no migration**. Call
`prerequisiteRefusalsRepo.record()` exactly as it exists — not touched by this task.

**Named tension, not hidden:** T-245's own classification rule (`docs/tasks/245-*.md` §1)
explicitly EXCLUDES "validation on the current request" from this table — *"fixed by typing a
[correct value] into the same form… same shape as `createSupplier`: a supplier needs a name."*
Most CHECK constraints (amount must be positive, dates must not overlap) are exactly that shape
by T-245's own test. Recording them under a table named `prerequisite_refusals` stretches the
name.

Resolved in favour of reuse anyway: (a) the orchestrator explicitly pre-verified the schema fact
that enables this, which reads as a deliberate instruction rather than an oversight to flag back;
(b) mechanically the table is exactly what's needed — org/store-scoped, append-only,
group-by-reason-code read model; (c) building a near-identical second table is the literal thing
"do not build a second one" forbids; (d) bible row 189's own double-signal framing — *"a hit means
there is no server-side validation on this field"* — is arguably a superset of
"prerequisite-shaped": both describe "nothing upstream stopped this," narrower in the table's own
doc comment than it needs to be. This spec does not edit that doc comment (schema file is out of
scope) but records the reasoning here for whoever reads a `domain: 'constraint'` row later and
checks it against §1's classification rule.

## 7. Invariants

1. `errorMessage(err)`'s signature and synchronous return are unchanged — the 9 existing callers
   need zero edits; their behaviour for already-mapped constraints and non-constraint errors is
   bit-for-bit identical to today.
2. No caller of `errorMessage()` can ever again receive raw multi-part Postgres driver text
   (`relation "…" violates … constraint "…"`) for a constraint failure — mapped or not.
3. Non-constraint errors are unaffected — sanitisation is scoped to the constraint-violation
   shape only (§4).
4. `recordConstraintRefusal` follows T-245's proven shape exactly: independent transaction via
   `withOrgPrincipal`; a recording failure is logged and swallowed, never surfacing in place of
   the real constraint-violation message.
5. No separately-accumulated counter — reads are `count(*)`/`max()` over `prerequisite_refusals`
   via the existing `countByReason`, never a stored running total (bible §4.2 rule 7).
6. `recordConstraintRefusal` is additive: exported and fully tested, but not called from any
   existing action file in this task — invariant, not a bug (§3).

## 8. Tests (written before implementation, confirmed to fail for the right reason first)

**Unit** (`apps/erp/src/lib/constraint-messages.test.ts`, no DB):
- `parseConstraintName` against real captured shapes: a check violation, a unique violation, a
  plain `Error` with no constraint text (→ `null`), a connection error (→ `null`).
- `errorMessage`: every one of the 9 currently-mapped constraint keys still returns its exact
  mapped sentence (regression set, proving the map-lookup path is untouched); an unmapped
  constraint returns the generic single-line sentence and never contains the raw
  `relation "…"` text; a non-constraint `Error` behaves exactly as today (existing
  `raw.replace` prefix-strip, byte for byte).

**Integration** (`packages/domain/tests/integration/constraint-refusals.test.ts`, against
`shareat_test_t216b`, run via `node C:/Users/ianla/.claude/skills/orchestrator/tools/it.mjs
shareat_test_t216b packages/domain/tests/integration/constraint-refusals.test.ts` — never
`npm run test:integration`):
- **Durability case**, T-245's own red-first sequence: call `recordConstraintRefusal` inside a
  transaction that the caller then rolls back; query `prerequisite_refusals` in a **brand-new**
  transaction opened after the rollback completes; assert the row survived. Capture it failing
  first against a deliberately-naive same-`tx` version (paste that red output into READY, per
  T-245 §6) — proving the lesson was re-applied, not just cited.
- Two calls with different `constraintName` values produce two independently-queryable
  `count(*)` buckets via `countByReason`, `domain: 'constraint'`.
- RLS manual probe, T-245 §6's method (DEF-218 means no automated test can prove this): as
  `shareat_app` with no `app.org_id` set — refused; with `app.org_id` set — succeeds, and a
  different org's `app.org_id` cannot see the row. Both outputs go in READY verbatim.

## 9. Out of scope

- Editing any of the 48 action files, including the 2 (`remittance`, `till`) that duplicate the
  `CONSTRAINT_MESSAGES` loop and the ~36 that never reference it at all. Named in §2 as the
  follow-up the orchestrator should log.
- Wiring `recordConstraintRefusal` into any real request path (needs the same caller edits, §3).
- "Finishing the map" — bible row 189 names this the low-value half explicitly.
- Any change to `prerequisite_refusals`' schema, its repo, or its docstring.
- A read-back UI — `/admin/prerequisite-refusals` already exists (T-245) and already reads
  `countByReason(tx, orgId)` with no `domain` filter, so `domain: 'constraint'` rows appear there
  automatically once any are written. No new screen.

## 10. Done when

Unit tests green (sanitisation, including the 9-mapped-sentence regression set) · integration
durability + discrimination cases green against `shareat_test_t216b` with the required red-first
capture pasted into READY · manual RLS probe run and both outputs pasted into READY · typecheck
clean · self-reviewed line by line · smoketested on 9008 (trigger an unmapped constraint through
one of the 9 already-wired screens — e.g. `settings/sales-channels` — see the generic sentence,
not raw SQL; confirm a row lands in `prerequisite_refusals` only once `recordConstraintRefusal` is
called from a test harness, since no production caller invokes it yet — named explicitly at
smoketest time rather than silently skipped, same pattern T-245 §11 used for its own nav
dependency) · **orchestrator logs**: the §2 ~38-file follow-up finding as a new
`DEFECTS-REGISTER.md` row, `docs/ROADMAP.html` if applicable.
