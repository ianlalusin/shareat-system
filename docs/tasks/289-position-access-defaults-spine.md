# T-289 — position access defaults: the spine

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-289`) for the commit, date and outcome —
> the roadmap is the maintained record. Written in plan mode (Opus specifies,
> Sonnet builds — CLAUDE.md, 2026-09-09). Cut from
> [`docs/plans/289-position-access-defaults-plan.md`](../plans/289-position-access-defaults-plan.md),
> which is the **authority** for this work and carries Ian's five decisions of 2026-09-12. This file
> cites the plan by section rather than restating it; where the two differ, **the plan wins and the
> difference is a spec defect to report, never to design around** (RULES §2, bible §3.4a).
>
> ⭐ **The three spec defects the spec-writer reported (C3, C10, and the `lib.ts` typecheck gap) were
> RULED by the planner the same day** — see plan §11 and the RULED paragraphs at §C3 and §C10, and
> file 18 in the list below. Nothing in this spec is left for the implementer to choose.
> **Status: APPROVED, 2026-09-12 — build.**

## Ian decided the shape. This builds the spine.

Plan §1, decision 1 — *"Position defaults sit on top of role matrix."* An administrator sets, per
**position** and per **store**, which capabilities every holder of that job gets *in addition to*
the role matrix. Each toggle writes one `position_capability_defaults` row and materialises ordinary
`person_grants` rows for every current holder, tagged `grant_source = 'position'` with a `source_ref`
back to the default.

This is bible row 120's pattern — *decide once, at the moment a human is present, and store the
answer* — applied to jobs. T-289 is the spine: the table, the provenance, the primitive and its call
sites. T-290 is the screen. T-291 is the person page.

## The goal, and the seam it cuts into — measured, not assumed

Three facts about today's code, each read at its line before this spec was written:

| Fact | Evidence |
|---|---|
| **Nothing reconciles anything when a job changes.** `setEmploymentPositions` is a plain delete-and-reinsert with no side effect; `createEmployment` and `endEmployment` likewise | `packages/domain/src/people/index.ts:192-210`, `:54-98`, `:166-189`; `employmentRepo.replaceEmploymentPositions` (`packages/db/src/repo/employment.ts:207-218`) deletes then inserts and returns `void` |
| **No retire path exists for a position at all.** `positions.is_active` (`packages/db/schema/employment.ts:117`) has exactly ONE reader — `listPositions`'s `eq(positions.isActive, true)` — and **zero writers anywhere in the repo**. `upsertStorePosition` only ever creates | `packages/db/src/repo/employment.ts:73`; `packages/domain/src/people/index.ts:213-240`; `grep -rn "isActive" packages/db/src/repo/employment.ts packages/domain/src/people/index.ts` returns exactly the two hits above |
| **`authorize()` has no idea positions exist, and must keep it that way.** Three axes, org → store scope → role-or-grant, and no fourth | `packages/auth/src/authorize.ts:70-148` (the whole function, 78 lines); plan §2 constraint 1-2, T-121:78-84, bible row 114 |

So: a position is never a parameter to a check. It is a **decision recorded once, as rows**, at the
five moments a human is present. Plan §0 and §4.

## Scope

Plan §6 ("in": §3, §4 minus the screens, classification + RLS registration, migration 0146, the
tests in §7). The screens are T-290 and T-291 and are **not** built here.

### Files this task may touch

Exactly the plan §9 T-289 row, plus this file. Nothing else. RULES §3.3 — *a spec names the exact
files you may touch; if you must go outside it, say so explicitly in your report.*

1. `packages/db/schema/position-capability-defaults.ts` — **new**
2. `packages/db/schema/access.ts` — `personGrants` gains one column, one check widened, one check added
3. `packages/db/schema/employment.ts` — **comment only**, beside `positions.isActive` (§C9)
4. `packages/db/migrations/0146_t289_position_capability_defaults.sql` — **new**
5. `packages/db/migrations/meta/_journal.json` — one appended entry
6. `packages/db/src/cutover/classification.ts` — one entry
7. `packages/db/src/rls/registry.ts` — one entry
8. `packages/db/src/repo/access.ts` — `GrantSource`, `GRANT_SOURCE_RANK`, `grantCapability`, `GrantRow`
9. `packages/db/src/repo/position-defaults.ts` — **new**
10. `packages/db/src/index.ts` — one `export * as positionDefaultsRepo` line (barrel registration; the plan's row implies it, `packages/db/src/index.ts:117,143` is the existing shape)
11. `packages/domain/src/people/position-defaults.ts` — **new**
12. `packages/domain/src/people/index.ts` — three reconcile calls, one re-export
13. `packages/domain/tests/integration/position-defaults.test.ts` — **new**
14. `tests/unit/position-defaults-offerable.test.ts` — **new**
15. `tests/unit/position-defaults-callers.test.ts` — **new**
16. `tests/unit/domain-actions-have-callers.test.ts` — three `EXEMPT` entries (§C12)
17. `docs/tasks/289-position-access-defaults-spine.md` — this file
18. `apps/erp/src/app/admin/users/lib.ts` — **exactly one new `case 'position':` arm** in
    `grantSourceLabel` (`:100-110`), returning the string `'Position default'`, so the exhaustive
    switch stays exhaustive under `strict` once `GrantSource` widens (plan §11.2). Nothing else in
    that file. ⚠️ This file is NOT held by T-283 (webapps-f7 confirmed `lib.ts` untouched,
    2026-09-12); T-291 later refines the arm into *"via Cashier at Lipa"*. If
    `apps/erp/tests/admin-users-lib.test.ts` asserts label exhaustiveness rather than the three
    existing strings, add the fourth expectation there and say so in the report.

**⛔ NOT in this list, and the most important line in it:** `packages/auth/src/authorize.ts`. Plan
§2 — *"An implementer who needs to touch it has found a spec defect and stops."* See Invariant 1.

**Not mine** (orchestrator's / planner's, plan §8): `PROJECT_BIBLE.md`, `docs/CAPABILITY-GAPS.md`,
`docs/DEFECTS-REGISTER.md`, `docs/CROSS-APP-MAP.md`, `docs/decisions/CAPABILITY-MATRIX.md`,
`docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`.

---

## Contract

### C1 — the new table, exactly as plan §3.1

`packages/db/schema/position-capability-defaults.ts`, transcribed into migration 0146 (ADR-012 §5
step 3: every rule Drizzle *can* express lives in the builder **and** in the SQL).

```
id             uuid pk default uuidv7()
org_id         uuid not null → organizations (restrict)
position_id    uuid not null → positions      (restrict)
store_id       uuid not null → stores         (restrict)
capability     text not null      -- a Capability value; NO CHECK constraint
set_by         uuid not null → persons (restrict)
set_at         timestamptz not null default now()
revoked_at     timestamptz
revoked_by     uuid → persons (restrict)
revoke_reason  text

unique index  position_capability_defaults_active_unique
              on (position_id, store_id, capability) where revoked_at is null
check         position_capability_defaults_revoke_check
index         position_capability_defaults_store_id_idx   on (store_id)
index         position_capability_defaults_position_id_idx on (position_id)
```

1. **`capability` carries no CHECK**, for the reason `person_grants.grant_name` carries none —
   `packages/db/schema/access.ts:33-46`: *"a CHECK enumerating all capabilities here would recreate
   exactly the thing this table exists to avoid"*, and `packages/db` must not know `@shareat/auth`'s
   members (ADR-004 dependency direction). Say so in the schema comment.
2. **`position_capability_defaults_revoke_check` is copied VERBATIM** from
   `person_grants_revoke_check` (`packages/db/schema/access.ts:172-178`, migration
   `0140_t248_def237_grant_provenance_and_revoke_reason.sql:60-63`), extended to the third column:

   ```sql
   ("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
   OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL
       AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
   ```

   ⛔ The explicit `IS NOT NULL` before `btrim(...) <> ''` is **load-bearing, not decoration** — a
   CHECK passes when its expression is NULL, so the naive spelling admits a revoked row with a
   missing reason. 0140's own header (`:31-37`) explains it; copy, do not re-derive.
3. **`revoked_by` exists here although `person_grants` has none** — plan §3.1: this table is new, so
   the WHO column is decided now rather than left to a later migration. 0140's note that a WHO column
   is its own decision is honoured; this *is* that decision, **for this table only**. Do not add
   `revoked_by` to `person_grants` in this task.
4. **`store_id` is `not null` even for canonical positions** (plan decision 2). *"Same for every
   store"* is N rows, a copy, never a link.
5. **Store-invented positions reach only their own store.** The rule is
   `positions.store_id is null OR positions.store_id = <store_id>`. Drizzle cannot express a
   cross-table CHECK and neither can Postgres without a trigger, so it is **enforced in the domain**
   (§C8) and integration-tested (§T-int 11). **State this in the schema file's comment**, in the
   same shape `packages/db/schema/employment.ts:132-135` already uses for a rule the builder cannot
   say.

### C2 — `person_grants.grant_source` gains `'position'`

`person_grants_source_check` is **dropped and re-added** with the four values (plan §3.2.1). The
Drizzle `check()` at `packages/db/schema/access.ts:170` is extended to match.

```sql
ALTER TABLE "person_grants" DROP CONSTRAINT "person_grants_source_check";
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_source_check" CHECK (
  "grant_source" IS NULL OR "grant_source" IN ('elevation', 'position', 'owner', 'grant')
);
```

⛔ 0140 stays applied and unedited (RULES §1 rule 9) — 0146 moves the constraint forward, the exact
pattern 0143 used on 0003's functions.

### C3 — `person_grants.source_ref` — RULED by the planner, 2026-09-12

New column `source_ref uuid null → position_capability_defaults (restrict)`, index on it, plus this
CHECK (plan §3.2.2 as amended in plan §11.1):

```sql
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_position_source_ref_check" CHECK (
  ("grant_source" = 'position' AND "source_ref" IS NOT NULL)
  OR ("grant_source" IS DISTINCT FROM 'position'
      AND ("source_ref" IS NULL OR "grant_source" = 'grant'))
);
```

Read it as three admitted shapes and nothing else: a `'position'` row **always** carries a ref; a
`'grant'` row **may** carry one (the ref is history — it says how the row first came to exist, and is
kept when a hand-grant upgrades a position row, §C5 transition 1); every other source (`'elevation'`,
`'owner'`, **and `NULL`**) carries none. ⭐ `IS DISTINCT FROM` is what closes the null-blind gap the
spec-writer reported: a `NULL` source is *distinct from* `'position'`, so the right-hand branch
applies and demands a null ref — a pre-0140 row with a stray ref is **refused**, not admitted. The
migration still applies cleanly to existing rows because none has a ref (§T-int 13 proves it).

The design intent — a row upgraded to `'grant'` is immune to the position sweep — holds because the
sweep matches on `grant_source`, never on `source_ref` (§C7 step 3-4). Integration case 3 is
expected to **pass**.

### C4 — the provenance rank

`GRANT_SOURCE_RANK` (`packages/db/src/repo/access.ts:403-407`, **not** `:404-408`) becomes:

```ts
const GRANT_SOURCE_RANK: Readonly<Record<Exclude<GrantSource, never>, number>> = {
  elevation: 0,
  position: 1,
  grant: 2,
  owner: 2,
};
```

`grantSourceRank(null)` stays `0` (`access.ts:409-411`, unchanged). The existing invariant stands
verbatim: `grantCapability`'s idempotent branch rewrites `grant_source` **only when the incoming
rank is strictly higher** — a monotone upgrade, never a downgrade. Do not turn it into an overwrite;
that one invariant is the whole safety argument (`access.ts:390-402`).

### C5 — the four transitions, each a named test

Plan §3.3. Each is asserted at the row level in the integration file (§T-int) and at the branch
level in `tests/unit/position-defaults-offerable.test.ts`'s rank block (§T-unit 2).

| # | Stored | Incoming | Result | Named test |
|---|---|---|---|---|
| 1 | `'position'` | `'grant'` | `'grant'`; `source_ref` **kept** (§C3 admits it) | `it('a hand-grant over a position row upgrades provenance to grant and the sweep no longer sees it')` |
| 2 | `'grant'` / `'owner'` | `'position'` | **unchanged** | `it('a hand-grant is never demoted to position by a later reconcile')` |
| 3 | `'elevation'` or `null` | `'position'` | `'position'`, **and `source_ref` is written in the same UPDATE** | `it('an elevation row superseded by a position default becomes position, ref written')` |
| 4 | `'position'` | `'position'`, different `source_ref` | **unchanged** | `it('two positions justifying one capability leave one active row and one ref')` |

⛔ **Transition 3 must write `source_ref` in the same `UPDATE` as `grant_source`.** Writing
`grant_source = 'position'` alone leaves `source_ref` null and violates §C3's CHECK — the row is
refused and the whole transaction rolls back. This is the single easiest way to get this task wrong.

### C6 — `grantCapability`'s input shape

`packages/db/src/repo/access.ts:388` and `:433-461`. Make the pair **unrepresentable in TypeScript**
as well as in the database, so the four existing call sites keep compiling unchanged:

```ts
export type GrantSource = 'elevation' | 'position' | 'owner' | 'grant';

type GrantBase = { personId: string; grantName: string; grantedBy: string | null };
export type GrantCapabilityInput =
  | (GrantBase & { grantSource: 'position'; sourceRef: string })
  | (GrantBase & { grantSource: Exclude<GrantSource, 'position'>; sourceRef?: never });

export async function grantCapability(tx: Tx, input: GrantCapabilityInput): Promise<{ id: string }>;
```

The four production call sites — `packages/auth/src/roles.ts:111`, `:576`, `:605`,
`packages/domain/src/organizations/index.ts:281` — pass no `sourceRef` and are **not edited**.
The insert branch writes `sourceRef: input.sourceRef ?? null`.

### C7 — `reconcilePositionGrants`, the ONLY primitive

`packages/domain/src/people/position-defaults.ts` (new). Plan §4.1. All steps inside the **caller's**
transaction — it never opens its own.

```ts
export interface ReconcileResult {
  readonly granted: readonly Capability[];
  readonly revoked: readonly Capability[];
  readonly skippedSelf: boolean;
}

export async function reconcilePositionGrants(
  tx: Tx,
  actor: Actor,
  input: { personId: string; storeId: string },
): Promise<ReconcileResult>;
```

1. **Skip self, first.** If `input.personId === actor.personId`, return
   `{ granted: [], revoked: [], skippedSelf: true }` and write nothing. Self-grant stays refused
   (bible §7 rule 5; `grantCapabilityAsActor`'s own check, `packages/auth/src/roles.ts:557-562`);
   the rest of the fan-out proceeds and **the caller reports it** (plan decision 4).
2. `wanted` — the **active** `position_capability_defaults` rows for `storeId` whose `position_id` is
   among the positions of this person's **open** employment at `storeId`. Empty when there is no open
   employment there. *Open* means `employments.ended_on is null` (the partial unique index
   `employments_open_person_store_unique`, `packages/db/schema/employment.ts:195-197`, guarantees at
   most one).
3. `held` — this person's **active** `person_grants` rows with `grant_source = 'position'` whose
   `source_ref` belongs to a default row of `storeId`, **active or revoked**. ⛔ Revoked defaults must
   be included in that lookup or a switched-off default's grant rows become unreachable orphans.
4. **Revoke** every row in `held` whose `source_ref` is not among `wanted`'s ids, via
   `accessRepo.revokeGrantById(tx, id, reason)` with
   `reason = "Position default no longer applies: <position name> at <store name>"`.
   ⚠️ Non-blank or `person_grants_revoke_check` refuses it.
5. **Grant** every capability in `wanted` this person does not already actively hold, via
   `accessRepo.grantCapability(tx, { …, grantSource: 'position', sourceRef: <default id>,
   grantedBy: actor.personId })`. Idempotent per §C4/§C5.
6. Return the two capability lists and `skippedSelf: false`.

**Why one active row and one ref is safe** — plan §4.1's closing paragraph, reproduced as the reason
nobody adds reference counting or a multi-ref column later: the toggle-off action revokes by ref and
*then* reconciles every affected holder in the same transaction, so a capability still justified by a
second position is re-granted as a **new** row before the transaction commits. The window is
invisible; "who could do this in March" reads both rows and sees continuity.

**Authority note — the one place a lower authority causes grant rows** (plan §4.1).
`reconcilePositionGrants` does **not** call `authorize()` itself. The *decision* was authorised at
toggle time by a `grant_capability` holder; a hire by an `enrol_staff` holder merely *applies* it.
Same relationship as `assignRole` writing elevation grants after one `manage_users` check
(`packages/auth/src/roles.ts:99-118`). Put this paragraph in the function's doc comment — it is the
line a reviewer will reach for.

### C8 — `setPositionDefault` and `retireStorePosition`

Both in `packages/domain/src/people/position-defaults.ts`. Plan §4.2.

```ts
export async function setPositionDefault(
  tx: Tx,
  actor: Actor,
  input: { positionId: string; storeId: string; capability: Capability; on: boolean; reason?: string },
): Promise<{ affected: number; skippedSelf: boolean }>;

export async function retireStorePosition(
  tx: Tx,
  actor: Actor,
  input: { positionId: string },
): Promise<{ affected: number; skippedSelf: boolean }>;
```

`setPositionDefault`, in this order:

1. `await authorize(tx, actor, 'grant_capability', {})` — **every** call, both directions.
   ⛔ No new capability: `grant_capability` already means *"may change who can do what"*
   (plan §2 constraint 6, T-154:167-176 — *it fits, so do not add one*).
2. The store belongs to `actor.orgId` — `accessRepo.storeBelongsToOrg`
   (`packages/db/src/repo/access.ts:309`). Refused with a comprehensible message otherwise.
3. The position is canonical (`store_id is null`) **or** belongs to this store — §C1.5. The message
   mirrors `resolvePositions`' existing one (`packages/domain/src/people/index.ts:296`):
   *"Position '<name>' belongs to a different store."*
4. The capability is offerable — §C9.
5. `on: true` — insert the default row idempotently against the active partial unique index (an
   already-active identical default returns the existing row, the shape `grantCapability` uses).
   `on: false` — revoke it, writing `revoked_by = actor.personId` and
   `revoke_reason = input.reason?.trim() || "Switched off by <actor display name>"`.
6. **Reconcile every person with an open employment at `storeId` holding `positionId`** — one
   `reconcilePositionGrants` call each, in this transaction. `affected` counts the people actually
   written; `skippedSelf` is true if the actor was one of them.

`retireStorePosition` sets `positions.is_active = false` (the column's first ever writer, §C9),
revokes that position's default rows with reason `"Position retired"`, and reconciles its holders.
⛔ **A canonical position cannot be retired** (T-154: a store may not edit or delete one of the
canonical six; `packages/db/schema/employment.ts:52-63`) — refuse with a message that says so.
Retiring only ever **narrows** (bible row 115: nothing anyone deletes may widen access).

### C9 — the six moments, five call sites, two files

| # | Moment | Call site | What |
|---|---|---|---|
| 1 | Toggle **on** | `setPositionDefault(..., on: true)` | insert the default, then reconcile the holder population |
| 2 | Toggle **off** | `setPositionDefault(..., on: false)` — *same function* | revoke the default, then reconcile the same population |
| 3 | **Hire** | `createEmployment` (`packages/domain/src/people/index.ts:54`), immediately after `replaceEmploymentPositions` (`:91-95`) and before `return employment` | `reconcilePositionGrants(tx, actor, { personId: input.personId, storeId: input.storeId })` |
| 4 | **Positions changed** | `setEmploymentPositions` (`:192`), after `replaceEmploymentPositions` (`:206-209`) | `reconcilePositionGrants(tx, actor, { personId: existing.personId, storeId: existing.storeId })` |
| 5 | **Employment ended** | `endEmployment` (`:166`), after `employmentRepo.closeEmployment` (`:188`) and before returning | reconcile — `wanted` is empty because the employment is no longer open, so every position row for **that store** is revoked; other stores untouched |
| 6 | **Position retired** | `retireStorePosition` | revoke the defaults, reconcile the holders |

⚠️ Six *moments*, **five** call sites of `reconcilePositionGrants` (moments 1 and 2 share one
function), in **two** files: `position-defaults.ts` and `people/index.ts`. The plan says both "the
five callers" (§4.2 heading) and six rows in its table; both are true of different things and this
row resolves it.

`packages/db/schema/employment.ts` gets **one comment only**, beside `positions.isActive:117`, naming
`retireStorePosition` as its writer so the next reader does not conclude the column is dead.

### C10 — what a position may never default ⚠️

`OFFERABLE_TO_POSITIONS` lives in `packages/domain/src/people/position-defaults.ts` (the only file in
this task's list where §4.3's *"enforced in the domain"* can be written), **derived, never
hand-listed**, with the same *"argue each new member"* note `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
carries (`packages/auth/src/capabilities.ts:792-801`; bible row 196):

```ts
export const OFFERABLE_TO_POSITIONS: readonly Capability[] = CAPABILITIES.filter(
  (c) =>
    !SUPER_ADMIN_ONLY_CAPABILITIES.includes(c) &&
    CAPABILITY_SCOPE[c] !== 'platform' &&
    c !== 'close_period',
);
```

Measured today: `CAPABILITIES` = **96**, `SUPER_ADMIN_ONLY_CAPABILITIES` = **4**
(`approve_item`, `post_journal_entry`, `cross_org_access`, `view_franchise_sales`),
`CAPABILITY_SCOPE` platform = **2** (both already inside the 4), `close_period` = 1 →
**`OFFERABLE_TO_POSITIONS.length === 91`**. ⛔ The test asserts the **derivation**, not 91; the
number is here so a reviewer can tell at a glance whether the derivation ran.

`close_period` is excluded because its manager cell is conditional on org-wide store scope
(`packages/auth/src/authorize.ts:130-147`, `CONDITIONAL_CAPABILITIES` at
`packages/auth/src/capabilities.ts:790`) — *data about the person, not about the job*.

⭐ **RULED by the planner, 2026-09-12 (plan §11.3): two checks, exactly as the spec-writer resolved
it.** `OFFERABLE_TO_POSITIONS` is the formula above (three derived exclusions — what the screen may
*render as toggleable*), **and** `setPositionDefault` separately refuses any capability where
`CAPABILITY_MATRIX[c].staff === true` (**21** of the 96 today) with the message *"Every staff member
already holds '<c>' through the role matrix — a position default would be a row that changes
nothing."* The staff set is **not** folded into the derived constant, because T-290 must still
**render** those 21 rows as inherited (plan §4.3: *"Shown, not hidden"*), and a constant that
excluded them would leave the screen nothing to render. Unit test 3 (§T-unit) pins that the two stay
two.

### C11 — the closed importer list

`tests/unit/position-defaults-callers.test.ts` (new). Same technique as
`tests/unit/domain-actions-have-callers.test.ts`: `git ls-files -z --cached --others
--exclude-standard`, comments stripped with its `codeOnly` shape (CRLF normalised first — DEF-179),
**never a directory walk** (`apps/erp/.next` holds turbopack copies of the domain barrel and would
make every symbol look imported).

Assert: the set of files that import `reconcilePositionGrants` is **exactly**

```
packages/domain/src/people/position-defaults.ts   (its definition)
packages/domain/src/people/index.ts               (moments 3, 4, 5)
packages/domain/tests/integration/position-defaults.test.ts
tests/unit/position-defaults-callers.test.ts      (this file names it)
```

plus a floor assertion (`expect(files.length).toBeGreaterThan(2)`) so a scan that matches nothing
cannot pass silently. ⛔ `reconcilePositionGrants` is **not** exported from
`packages/domain/src/index.ts` — `people/index.ts` re-exports `setPositionDefault` and
`retireStorePosition` only. An `apps/` import of the primitive is the failure this test exists to
catch.

### C12 — `domain-actions-have-callers.test.ts`: three confessions, two of them temporary

All three new functions take `(tx, actor, …)`, so all three land in that guard's population
(`tests/unit/domain-actions-have-callers.test.ts:11-31`) and **the unit suite goes red at T-289
without these entries**. Reasons must open with `INTERNAL —` / `WRAPPER —` / `JOB —` / `UNWIRED —`
and be ≥ 60 characters (that file's own fourth `it`).

- `reconcilePositionGrants` — `INTERNAL — …` **permanent.** It is never reachable from a screen by
  design; §C11 is the test that keeps it that way, and the exemption reason must say so.
- `setPositionDefault` — `UNWIRED — … T-290 builds /admin/access-defaults; delete this row when it
  lands.` **Temporary.**
- `retireStorePosition` — `UNWIRED — … same screen, T-290; delete this row when it lands.`
  **Temporary.**

⛔ That file's third `it` fails an exemption whose export **does** have a caller — *"the whole point
of the exemption being a confession rather than a setting."* So **T-290 must delete the last two
rows**, and T-290's spec says so. Getting this wrong turns a green suite red one task later for
reasons nobody connects.

### C13 — migration 0146

`packages/db/migrations/0146_t289_position_capability_defaults.sql`, hand-authored per ADR-012 §5.
Header names T-289, this spec's section, and *why*; 0140's header is the model (ADR-012 §5 step 2).
Statements separated by `--> statement-breakpoint`. Order:

1. `CREATE TABLE "position_capability_defaults" (…)` with the inline `CONSTRAINT
   "position_capability_defaults_revoke_check" CHECK (…)` — the `expense_budgets` shape
   (`0131_t215_expense_budgets.sql:19-47`).
2. Four `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … ON DELETE RESTRICT` (org, position, store,
   set_by) plus one for `revoked_by`.
3. `CREATE UNIQUE INDEX … WHERE "revoked_at" IS NULL`, then the two plain indexes.
4. RLS **as the table is created, never retrofitted** (bible row 112), copied from
   `0131:70-80` including its two ⚠️ comments:
   `ENABLE ROW LEVEL SECURITY` → `FORCE ROW LEVEL SECURITY` → `CREATE POLICY
   "position_capability_defaults_org_isolation" … USING ("org_id" = app_current_org()) WITH CHECK
   ("org_id" = app_current_org())`. ⛔ `app_current_org()`, **never** a raw
   `current_setting(...)::uuid` (DEF-077).
5. `person_grants`: `DROP CONSTRAINT "person_grants_source_check"` → re-`ADD` with four values (§C2)
   → `ADD COLUMN "source_ref" uuid` → FK to `position_capability_defaults` `ON DELETE RESTRICT` →
   `CREATE INDEX "person_grants_source_ref_idx"` → `ADD CONSTRAINT
   "person_grants_position_source_ref_check"` (§C3).
   ⛔ **No backfill.** There are no defaults yet; the first toggle is the backfill (plan §6).
6. Journal (`meta/_journal.json`), appended after idx 145:

   ```json
   { "idx": 146, "version": "7", "when": 1798687907084,
     "tag": "0146_t289_position_capability_defaults", "breakpoints": true }
   ```

   `1798601507084 + 86_400_000 = 1798687907084` — the DEF-091 grid, ADR-012 §5 step 5. Never the
   wall clock; `migration-journal.test.ts` refuses one and the migrator silently skips what the test
   would have refused (DEF-039).
7. ⛔ **No `meta/*_snapshot.json`** (ADR-012 §5 step 7).

### C14 — classification and RLS registry, in the exact shapes those files use

`packages/db/src/cutover/classification.ts`, beside the T-154 block (`:250-270`), class **`keep`**,
reason in the `person_grants` register (`:119-125`): access configuration, not pilot activity —
purging it would silently strip capability from staff on day one, and strand every `person_grants`
row whose `source_ref` points at it (the FK is `RESTRICT`, so a purge would fail loudly anyway, which
is the argument, not the accident).

`packages/db/src/rls/registry.ts`, beside the T-154 block (`:708-731`):

```ts
position_capability_defaults: {
  scope: 'org_column',
  reason: '…',
},
```

⚠️ **`personKeyedAccess` is NOT set, and that is a decision.** This table is keyed on
(position, store), not on a person — `set_by`/`revoked_by` are audit columns, not the subject. The
DEF-183 guard exists for a table whose *subject* is a person (`registry.ts:33-52`); asserting it here
would make `packages/db/tests/integration/rls.test.ts`'s via-person check demand a `person_id` column
this table does not have. `org_column` with the standard isolation policy is the right and sufficient
answer, and the reason string must say why in one sentence.

Both files **fail the build when a table is unlisted** — that is the guard working
(`tests/unit/cutover-classification.test.ts`, `tests/unit/rls-registry.test.ts`; CLAUDE.md's
"Adding a table" row).

### C15 — the reads T-291 needs, provided here

`packages/db/src/repo/position-defaults.ts` also exports the read T-291 renders *"via Cashier at
Lipa"* from, because T-291's own file list cannot reach `packages/db`:

```ts
export interface PositionDefaultSource {
  id: string; positionId: string; positionName: string;
  storeId: string; storeName: string; revokedAt: Date | null;
}
export async function describeSources(tx: Tx, refIds: string[]): Promise<PositionDefaultSource[]>;
```

Returns `[]` for an empty input (never an `inArray` on an empty array — the shape
`listEmploymentPositionsFor` already uses, `packages/db/src/repo/employment.ts:253-255`).
`GrantRow` (`packages/db/src/repo/access.ts:367-376`) gains `sourceRef: string | null`, and
`grantsForPerson` (`:527-541`) selects it.

---

## Invariants

1. ⛔ **`packages/auth/src/authorize.ts` is NOT in the file list and must stay untouched.** A position
   never enters the check path and is never a parameter to `authorize()` (plan §2; T-121:78-84 —
   three axes, fixed, no fourth). **An implementer who finds they need to touch it has found a spec
   defect: stop and report** (RULES §2, bible §3.4a). `git diff --stat` proves it at Done.
2. ⛔ **Rows, never a bypass; append-and-revoke, never delete** (T-121:264-268). A default is revoked,
   not deleted. A grant is revoked, not deleted. `person_grants_active_person_grant_unique`
   (`packages/db/schema/access.ts:166-168`) means re-granting after a revocation inserts a **new**
   row, so each grant's window stays exact.
3. ⛔ **Nothing anyone switches off, retires or ends may WIDEN access** (bible row 115). Toggle-off,
   retire and end-employment only ever revoke.
4. ⛔ **Additive only.** A position default can never remove a capability the role matrix grants
   (Ian, decision 1). There is no deny axis in this task and adding one is out of scope.
5. ⛔ **Self is skipped, never refused-and-aborted** (decision 4). The fan-out proceeds for everyone
   else and the caller reports the skip. A version that throws on the actor's own row would let one
   administrator's own job block a whole store's defaults.
6. ⛔ **An explicit per-person grant survives everything here** (decision 5). Only
   `grant_source = 'position'` rows are ever swept.
7. ⛔ **No new capability.** `tests/unit/capability-matrix.test.ts:221,293-295` asserts 96 three
   times; all three stay at 96 and that file is not edited. If the count moved, this spec was
   violated.
8. ⚠️ **The accepted consequence, recorded so it is not rediscovered as a bug** (plan §3.3): an
   elevated manager in an adminless org (bible row 115) who also holds a floor position whose default
   covers one of their elevated capabilities has that row re-tagged `'position'` (transition 3). The
   admin-arrival sweep (`revokeElevationGrantsForOrg`, `packages/db/src/repo/access.ts:498-514`,
   `WHERE grant_source = 'elevation'`) then no longer catches it — **correct**, the position default
   independently justifies it. If that default is later switched off while the org is still
   adminless, the capability goes with it and the manager needs `elevateManager`'s explicit tick
   back. Pinned as integration case 12 so it is a decision, not a surprise.
9. ⚠️ **The reconcile runs in the CALLER's transaction, always.** It never calls `transaction()`
   itself (`tests/unit/auth-transaction-callers.test.ts`, `no-direct-transaction-in-erp.test.ts` and
   `withorgprincipal-chokepoint.test.ts` all exist because that boundary has been crossed before).
10. ⚠️ **Migrations 0001–0145 are applied and frozen** (RULES §1 rule 9). 0146 moves constraints
    forward; nothing earlier is edited.

---

## Tests — write first, watch the right one fail for the right reason

RULES §2: *tests before implementation, and confirm they fail for the right reason first. A test that
only ever passed proves nothing.*

### Unit — `tests/unit/position-defaults-offerable.test.ts`

1. `it('OFFERABLE_TO_POSITIONS is derived, not hand-listed — the three excluded sets, by construction')`
   — asserts each of `SUPER_ADMIN_ONLY_CAPABILITIES`, every `CAPABILITY_SCOPE === 'platform'`
   member and `close_period` is absent, and that **every other** member of `CAPABILITIES` is present.
   Plus a floor (`length > 50`) so an empty derivation cannot pass silently (DEF-179).
2. `it('GRANT_SOURCE_RANK orders elevation < position < grant = owner, and null ranks as elevation')`
   — the ordering pinned, plus the four transitions of §C5 asserted against the idempotent branch's
   rule (`incoming > stored` ⇒ rewrite). Row-level effects are integration.
3. `it('the staff-matrix set is 21 and is NOT removed from OFFERABLE_TO_POSITIONS')` — §C10's two
   checks are two checks, and this is what stops a later reader collapsing them into one.

### Unit — `tests/unit/position-defaults-callers.test.ts`

§C11. One `it` for the closed importer set, one for the floor.

### Integration — `packages/domain/tests/integration/position-defaults.test.ts`

⛔ Run **only** on the lane database, **never** `npm run test:integration` (RULES §2: two agents
against one `shareat_test` truncate each other's fixtures):

```
node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_lanec packages/domain/tests/integration/position-defaults.test.ts --repo C:\Users\ianla\webapps\shareat-system
```

(`~/.claude/skills/orchestrator/tools/it.mjs` is the same file. Argument order is
`<db> [files...] [--repo <path>]` — `it.mjs:4-27`. The lane DB must be migrated to 0146 first.)

**Fixture** — the `packages/domain/tests/integration/employment.test.ts:37-77` specimen, extended.
Copy its `asOrg` helper verbatim (`set local role`, `app.principal_kind = 'staff'`,
`app.org_id`) so RLS is live exactly as in production; raw `postgres` inserts for the fixture rows,
domain functions for everything under test; `uid()` for collision-free codes. Plan §7:

- one org; **two stores** A and B;
- canonical positions seeded (`seedCanonicalPositions`);
- **one store-invented position at store A** (`upsertStorePosition`);
- an **admin** (role `admin`, store scope on both stores);
- a **manager** holding `enrol_staff` at A only and **not** `grant_capability`;
- **four staff** with open employments, positions assigned per case.

The thirteen scenarios, each a named `it(...)`:

1. `it('a toggle on reaches every open-employment holder at that store and nobody at the other')`
2. `it('a toggle off revokes only position rows carrying that ref — a grant row for the same capability survives')`
3. `it('a hand-grant over a position row upgrades provenance to grant, keeps the ref, and survives the toggle off')` — passes under the ruled §C3 CHECK; if it fails on `person_grants_position_source_ref_check`, the CHECK was transcribed wrongly, not the test
4. `it('hiring into a position with defaults grants them — including when the hire is made by the enrol_staff manager who cannot grant capabilities')`
5. `it('Cashier→Cook swaps the sets; Cashier+Cook keeps the union')`
6. `it('two positions defaulting one capability: switching one off leaves it held via the other, as a new row')`
7. `it('ending the employment at A revokes A rows and leaves B untouched')`
8. `it('the same person in the same position at two stores has independent rows per store')`
9. `it('retiring the store-invented position revokes its rows; a canonical position cannot be retired')`
10. `it('an actor holding the position is skipped and reported, and everyone else is still written')`
11. `it('denials', …)` — **six**, each asserting `AuthorizationError` or `EmploymentError` by the
    shape `packages/auth/tests/integration/authorize.test.ts:347-353` uses
    (`await expect(asOrg(org, (tx) => …)).rejects.toThrow(AuthorizationError)`):
    no `grant_capability` · store outside the org · a store-A-invented position targeted at store B ·
    a `SUPER_ADMIN_ONLY` capability · a `platform`-scoped capability · `close_period` ·
    a staff-matrix capability. ⛔ Each refused **at the domain**, not merely absent from a screen.
12. `it('an elevated manager in an adminless org keeps the capability as a position row: admin arrival does not sweep it, switching the default off does revoke it')` — Invariant 8, pinned.
13. `it('migration 0146 applies to an empty database and to one holding pre-0146 person_grants rows')`
    — the `source_ref` CHECK must accept `null` alongside `null`/`'elevation'`/`'owner'`/`'grant'`
    sources. Proven on a **scratch** database (`shareat_scratch_t289`), created, migrated from zero,
    read out of `drizzle.__drizzle_migrations`, dropped — ADR-012 §5 step 8, never on a shared DB.

---

## Out of scope

- ⛔ **`packages/auth/src/authorize.ts`** — Invariant 1. Touching it is a stop-and-report.
- ⛔ **Both screens.** `/admin/access-defaults` is T-290; the person page is T-291. No file under
  `apps/` is in this task's list.
- ⛔ **Subtractive defaults** — needs a deny axis and a bible amendment (decision 1). Plan §6 sends it
  to `docs/CAPABILITY-GAPS.md`; the planner writes that row.
- ⛔ **Editing the role matrix at runtime** — T-121 rejects a database-driven permission engine.
- ⛔ **Defaults reaching store scope** — scope is its own axis; a job saying *where* you may act is
  exactly the conflation T-121 warns against.
- ⛔ **Org-level default rows that cascade into store rows** — override semantics rot. A copy is a
  decision; a link is a deferred one (decision 2).
- ⛔ **Backfilling existing employments** — there are no defaults yet; the first toggle is the
  backfill (plan §6).
- ⛔ **A `revoked_by` column on `person_grants`** — §C1.3. This table decides it for itself only.
- ⛔ **Position history on `employment_positions`** — the grants' own windows already answer "who
  could do X in March"; when a person held which job is Phase 4/5's question (plan §6).
- ⛔ **POS's own staff `role` field** — a `CROSS-APP-MAP` seam, the orchestrator's row.
- ⛔ **`PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/CAPABILITY-GAPS.md`,
  `docs/CROSS-APP-MAP.md`, `docs/decisions/CAPABILITY-MATRIX.md`, `docs/ROADMAP.html`** — plan §8's
  bookkeeping, reported to the orchestrator, not edited here. ⚠️ Whoever adds CAPABILITY-MATRIX.md's
  new §E must keep `tests/unit/capability-matrix.test.ts`'s document parser green: role cells are a
  closed enum (✅ / ✗ / conditional) and prose belongs in the notes column.

---

## Definition of done

Every line of RULES §2's "Definition of done", plus the four this task adds:

- `npm run typecheck -- --incremental false` clean. Adding `'position'` to `GrantSource` makes
  `grantSourceLabel`'s switch (`apps/erp/src/app/admin/users/lib.ts:100-110`) non-exhaustive under
  `strict: true`; file 18 in the list is the one-arm fix. Any **other** typecheck fallout outside the
  file list is a stop-and-report.
- Unit suite green, **including** the three `domain-actions-have-callers` entries of §C12 and the two
  new test files.
- The thirteen integration cases green on `shareat_test_lanec` via `it.mjs`, **plus** the full
  existing `packages/domain/tests/integration/employment.test.ts` and
  `packages/auth/tests/integration/authorize.test.ts` unaffected. ⛔ Full `npm run test:integration`
  **not** run (shared DB).
- **0146 applied to a scratch database from zero**, verified against `pg_constraint` /
  `information_schema` rather than trusted from the migrator's exit code (T-248's own standard), then
  the scratch DB dropped.
- ⭐ **`git diff --stat` output pasted in the report, showing `packages/auth/src/authorize.ts`
  absent from it** — Invariant 1, proven rather than claimed.
- ⭐ **`tests/unit/capability-matrix.test.ts` unchanged and its three `96` assertions still green** —
  Invariant 7. If the row count moved, the spec was violated.
- Self-reviewed line by line · report states real command output, numbers and exit codes, never a
  claim (RULES §2, *verify, do not claim*) · report ends with a `FOR IAN` block.
- ⛔ A smoketest on 9008 is **not** this task's — nothing under `apps/` changes here. It belongs to
  T-290.

---

### Model

Spec on Opus (plan mode). ⚠️ **Build is Sonnet-able**: one hand-authored migration following an exact
precedent (0131 for the table, 0140 for the checks), one new schema file, one new repo module, one
new domain module, five call-site insertions with no judgement in them, and thirteen integration
cases whose fixture and assertions are fully specified above. Every judgement call — the rank, the
skip-self, the offerable derivation, the two-checks resolution, the exemption confessions — is
resolved here in writing. ⛔ The three ⚠️ spec defects are **reported, never resolved by the
implementer**.

See `docs/plans/289-position-access-defaults-plan.md` (the authority);
`docs/decisions/ADR-012-hand-authored-migrations.md` §5;
`packages/db/migrations/0140_t248_def237_grant_provenance_and_revoke_reason.sql`;
`packages/db/migrations/0131_t215_expense_budgets.sql`;
`docs/tasks/248-def-237-revoke-elevated-grants-on-admin-arrival.md`;
`docs/tasks/154-positions-and-employments.md`; `docs/tasks/121-roles-and-access.md`;
`docs/decisions/CAPABILITY-MATRIX.md` §B, §C.2.
