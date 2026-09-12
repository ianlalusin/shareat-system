# T-264 slice 3 — plan: the fiscal-period override

> Status: **APPROVED by system32-85, building.** Written per the orchestrator's briefing
> protocol. Supersession order for source docs: SLICE 3 BUILD NOTE (2026-09-12, end of
> `docs/tasks/264-def-284-fiscal-period-lock.md`) wins over the slice 3 section above it, which
> wins over anything else. Bible §13 rows 193, 194, 195, 196 and ADR-006's supersession note are
> both read and incorporated.

## Observation 1 — captured BEFORE any migration touched this database (system32-85's addition 2)

Run against `shareat_test_lanea` while it was still at migration 0142 (verified at 0142 that
morning by system32-85), via a scratch vitest file created, run once, and deleted — never
committed, never part of the permanent suite. Real output, quoted verbatim:

```
T264-BASELINE-PERIOD-ID: 01a093b9-5f63-7bee-ab37-8f94efe1d3fa
T264-BASELINE-MESSAGE: postEntry: fiscal period 01a093b9-5f63-7bee-ab37-8f94efe1d3fa (2026-02-01..2026-02-28) is closed — cannot post an entry dated 2026-02-15
```

This is the **TypeScript pre-check's own message** (`post-entry.ts:118-122`), not the database
trigger's — confirming finding 4 from the build note: the app throws before the trigger is ever
reached, so the trigger's own message has never been observed via `postEntry` at all and can't be,
until the TS pre-check is taught to stand aside. Observation 2 (post-0143, no flag set) must
reproduce this identical sentence; observation 3 is the `authorize()` refusal, a different message
family entirely.

## Goal

An `admin` or `super_admin` may post **one authorised entry into a CLOSED fiscal period**,
through a transaction-local, per-call exemption that fails closed, with a typed reason and an
audit row. The period itself is never reopened; the exemption dies with the transaction.

What would have to be true for this to be wrong: the exemption would have to leak into an
ordinary posting (no `periodOverride` passed), or survive past the transaction that raised it, or
be checkable by anyone other than `admin`/`super_admin`, or leave a committed override with no
audit row, or leave an audit row for an override that didn't commit.

## Two items raised as QUESTION — ANSWERED by system32-85, recorded verbatim

1. **`locked` periods are NOT in scope for the exemption — ruled, not assumed.** The override
   applies only when `fiscal_periods.status = 'closed'`. system32-85's ruling, to be kept
   verbatim: *"`locked` means a later year's close has already CONSUMED this period's balances
   (ADR-006 §7.5). An entry landing there changes numbers a subsequent year-close entry was
   computed from and already posted — so the closing entry silently stops equalling what it
   closed. That is not a bigger version of a closed-period correction, it is a different and
   worse thing."* This is recorded as a decision system32-85 made (reading bible row 193 and
   DEF-284 precisely — both say **closed**, and row 195's rule that the permission list grows
   only by a named ruling, never by analogy), not one this lane assumed.
   ⛔ **Addition — the trigger must not collapse `locked` into a generic "not open" refusal.**
   `locked` is branched FIRST, with its own sentence saying the override does not reach locked
   periods at all — never the same message a plain "period is not open" gets. Three states,
   three distinguishable outcomes, all by message text alone:
     - `closed`, no flag set → refused (fail-closed proof, observation 2)
     - `closed`, flag set and authorized → passes
     - `locked`, flag set or not → refused, **and the message says the override does not apply to
       locked periods** — never the generic "(status = locked)" an admin holding the capability
       would misread as a bug.
   `apps/erp/src/lib/constraint-messages.ts` stays lane B's; the raised `RAISE EXCEPTION` text is
   ours to write, but no constraint-messages key is added — flagged in READY if the sentence
   seems to want one.
2. **The override is unreachable through 3 real call paths — logged as DEF-302 by system32-85,
   confirmed independently, line numbers exact.** `commissary/transfer.ts:confirmReceipt`
   (:385→:503), `production/index.ts:runProductionPosting` (:444/:503→:547),
   `trade/returns.ts:recordInternalReturn` (:447→:485) each insert into `stock_movements` (no
   override mechanism, out of scope) before calling `postEntry` on the same `tx`. Reported as
   DEF-302, not fixed — system32-85's own words: *"Scoping `stock_movements` out was my decision
   and this is its real price... extending the exemption there means back-dating a movement into
   a closed month, which recomputes inventory layers and therefore COGS, and that is a decision
   for Ian about inventory, not a detail of a ledger task."* Nothing in this task touches 0063, adds
   a GUC to the movement trigger, or attempts to make the three flows work. The override is only
   reachable through pure-ledger paths (AP, AR, cash requests, channel-settlements, expenses,
   fixed-assets, liabilities, loans, money-transfers, owners, payroll, prepaid, sales-days/verify,
   till) — **and every integration test in this plan is written directly against `postEntry`
   (or a pure-ledger domain caller such as an AP payment), never through `confirmReceipt`,
   `runProductionPosting`, or `recordInternalReturn`**, so a DEF-302 rollback is never mistaken for
   a broken override in this task's own test suite.

## Scope — files

Exactly the list in the briefing:
- `packages/db/migrations/0143_t264_period_override.sql` (new)
- `packages/db/migrations/meta/_journal.json` (append idx 143, `when` 1798428707084, tag
  `0143_t264_period_override` — verified against the current file's last entry, idx 142,
  `when` 1798342307084; `1798342307084 + 86_400_000 × 1 = 1798428707084` ✓)
- `packages/db/schema/period-overrides.ts` (new)
- `packages/db/src/repo/fiscal-periods.ts` — add `insertPeriodOverride` (the audit-row writer;
  co-located with period logic, not `journal.ts`, so `journal.ts`'s edit stays the one narrow
  thing the briefing named)
- `packages/db/src/repo/journal.ts` — add `beginPeriodOverrideContext`, beside
  `beginReversalPostingContext` (:389-397), same shape
- `packages/db/src/rls/registry.ts` — register `period_overrides`
- `packages/db/src/cutover/classification.ts` — classify `period_overrides`
- `packages/domain/src/fiscal-periods/index.ts` — no functional change expected; re-read after
  the schema/repo additions in case the reason enum type wants a home here. If nothing to add,
  say so in the READY report rather than editing for the sake of it.
- `packages/domain/src/ledger/post-entry.ts` — the `periodOverride` field, the branch, the audit
  write
- `packages/domain/tests/integration/**` — new test file, `period-override.test.ts`
- `docs/plans/264-slice3-plan.md` — this file

### Not touched, per the briefing — reported instead

- `packages/db/schema/index.ts` needs `export * from './period-overrides';` added. **Reporting
  this now, in the SPEC message, so it isn't a surprise at READY.**
- `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md`,
  `tests/unit/capability-matrix.test.ts` — already done (finding 2), used as-is.
- `apps/erp/src/lib/constraint-messages.ts` — lane B's. If the trigger's raised message would
  read better through a mapped constraint, that goes in the report, not a new key here.

## The contract (DECIDED upstream, restated here for the tests to cite)

```ts
postEntry(tx, {
  ...,
  periodOverride?: {
    actor: Actor;              // @shareat/auth — postEntry has never taken an actor; this is the
                                // only place one enters, nested so every existing call site's
                                // object literal remains valid with no edits (see "byte-identical"
                                // below)
    reason: PeriodOverrideReason;  // typed enum, see proposal below
    note?: string | null;
  }
})
```

1. `periodOverride` absent → nothing changes. No `authorize` call, no GUC, no audit row, no new
   branch taken. Every existing caller's object literal is untouched and this is a purely additive
   optional field — **no existing caller needs editing**, and if BUILD finds one that does, that's
   a stop-and-report per the build note, not a chore.
2. `periodOverride` present → `authorize(tx, periodOverride.actor, 'override_period_lock', {
   orgId: input.orgId })` runs **unconditionally**, before anything else in the branch — including
   when the resolved period turns out to already be `'open'`. **Ruled by system32-85, and for a
   stronger reason than the literal-contract one this plan first gave:** the app reads the
   period's status, but another transaction can close that very period before this one's insert
   commits — a race, not a hypothetical — so the app can never reliably know in advance whether
   the exemption will actually be consumed. Writing the row (and running `authorize()`) whenever
   the capability was invoked never under-records; conditioning it on a status read that can go
   stale before commit is the direction that loses evidence. Over-recording is the safe side for
   an audit trail. A refusal here throws `AuthorizationError` and nothing is written — ordinary
   `authorize()` behaviour, no special casing.
3. Only after `authorize` succeeds: `set_config('app.period_override', 'on', true)` — via
   `journalRepo.beginPeriodOverrideContext(tx)`, exact shape of `beginReversalPostingContext`.
4. The TS pre-check at `post-entry.ts:118-122` stands aside **only when `period.status ===
   'closed'` and `periodOverride` is present and authorized** — not for `'locked'` (ruled by
   system32-85, above), and not for any other non-open status (a period with no covering row at
   all stays refused exactly as today; that branch is unconditional and unrelated to
   periodOverride). `locked` gets its own error text distinguishing it from a plain closed refusal
   (an admin should never read "period is not open" and wonder whether their override should have
   worked). The database is still the authority: the trigger's own bypass condition is independent
   code, re-deriving nothing from the TypeScript decision.
5. The audit row is written in the same transaction, immediately after `postDraftEntry` returns
   (the entry now exists and is posted) — so a rollback leaves no row and a commit cannot fail to
   have one. This runs whenever the branch in point 2 ran, independent of whether the period
   turned out closed or open (see point 2's reasoning — the row records that the capability was
   invoked for this entry, which is accurate either way, not "the trigger was actually bypassed").
   ⛔ **What a row MEANS, stated so a future reader never over-reads it:** *"the override capability
   was invoked for this entry"* — **NOT** *"the period lock was bypassed."* Those two statements
   differ exactly when `period_status_at_post = 'open'` (see the new column below); a reader who
   assumes the second reading will miscount every audit they ever run against this table.

**Consequence of the idempotency short-circuit (existing code, untouched):** `runPostEntry`
checks the idempotency key first and returns before period resolution. A retried call carrying
`periodOverride` that hits the idempotency short-circuit does not authorize, set the GUC, or
write an audit row — same as any other retry doing nothing. Not a gap; this is the existing
"a retry must be a cheap, safe no-op" invariant (post-entry.ts:98-105) extended to this field
without change.

**GUC reset — deliberately NOT added, matching the existing precedent exactly.**
`beginReversalPostingContext` never resets `app.reversal_posting` back to `'off'`; it relies on
being transaction-local and the transaction ending shortly after. `beginPeriodOverrideContext`
follows the identical idiom, on the build note's own instruction not to invent a second mechanism.
Checked whether this is a live leak risk: no caller of `postEntry` currently invokes it twice
against the same explicit `tx` within one function (the 2-calls-per-file cases —
`commissary/transfer.ts`, `stock/supplier-returns.ts`, `prepaid/index.ts` — are two different
functions, each opening or receiving its own transaction from its own caller). Latent, not live;
recorded here rather than silently noticed and dropped.

## Schema — `period_overrides`

```ts
// packages/db/schema/period-overrides.ts
//
// A row means "the override capability was invoked for this entry" — NOT "the period lock was
// bypassed". Those differ exactly when period_status_at_post = 'open' (see below); filter on that
// column, never assume every row here represents a bypassed lock.
export const periodOverrides = pgTable('period_overrides', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  periodId: uuid('period_id').notNull().references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
  entryId: uuid('entry_id').notNull().references(() => journalEntries.id, { onDelete: 'cascade' }),
  actorPersonId: uuid('actor_person_id').notNull().references(() => persons.id, { onDelete: 'restrict' }),
  // Typed, CHECK-constrained (system32-85's ruling, below). ⛔ Adding a 5th member later is a
  // MIGRATION, not a one-line edit — it's a CHECK constraint, not a TS union alone.
  reason: text('reason', { enum: [...PERIOD_OVERRIDE_REASONS] }).notNull(),
  note: text('note'),
  // Captured from the period status this call already resolved, at the moment of write.
  // 'locked' can never appear here — a locked period is refused before any row is written.
  periodStatusAtPost: text('period_status_at_post', { enum: ['open', 'closed'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('period_overrides_reason_check', sql`${t.reason} in (...)`),
  check('period_overrides_other_needs_note_check',
    sql`${t.reason} <> 'other' or (${t.note} is not null and btrim(${t.note}) <> '')`),
  check('period_overrides_status_at_post_check', sql`${t.periodStatusAtPost} in ('open', 'closed')`),
]);
```

- `entry_id` NOT NULL, `ON DELETE CASCADE` — mirrors `journal_lines.entry_id`
  (`0003_journal_entries_and_lines.sql:82`, `ON DELETE cascade`). This is the property the build
  note's audit_log rejection was arguing FOR: "an override with no entry" must be structurally
  unrepresentable, which a `NOT NULL` real FK gives and a `jsonb` blob under `audit_log.entity_id`
  cannot.
- `period_id` NOT NULL, `ON DELETE RESTRICT` — mirrors `journal_entries.period_id`
  (`0003:79`, `ON DELETE restrict`).
- `actor_person_id` NOT NULL, `ON DELETE RESTRICT` — per the build note, explicitly (no
  system-actor case; a machine can never hold this capability).
- `reason` — typed enum via CHECK, `sessions_ended_reason_check` shape
  (`0018_t138_identity_sessions.sql:37`: `... in (...)`), NOT NULL (never optional — every override
  states why).
- `note` — nullable free text, required only when `reason = 'other'` (constraint above), same
  shape as `ar_write_offs_reason_not_blank_check` (`0049:123`).
- RLS: `ENABLE`/`FORCE ROW LEVEL SECURITY`, single `org_isolation` policy through
  `app_current_org()`, `USING` and `WITH CHECK` both — exact boilerplate of
  `0132_t216_recurring_expenses.sql:82-87`.
- Registry: `scope: 'org_column'` (has its own `org_id`).
- Classification: `class: 'purge'` — it CASCADEs off `journal_entries`, which is itself `purge`
  (`journal_entries: { class: 'purge', reason: 'Replaced wholesale by the 2027-01-01 opening
  entry' }`); same lineage as `journal_lines` ("purged first — children before parents"). An
  override record about a pilot-era entry that no longer exists after cutover is exactly
  `audit_log`'s own reasoning ("points at deleted ids... worse than no audit trail").

## `reason` enum — RULED by system32-85 (not Ian's to rule on; corrected from the SPEC draft)

**APPROVED as proposed**, verbatim:

| Member | One-line justification |
|---|---|
| `late_supplier_invoice` | A dated cost document (rent, utility, supplier bill) for the closed period is approved or arrives after close and accrual requires it land in the period it was actually incurred, not the current one. |
| `regulatory_correction` | An external filing (BIR, franchisor, audit) already references the closed period's figures; only a same-period correction keeps the books and the filed numbers in agreement — a prior-period adjustment in the new period would leave the two disagreeing on purpose. |
| `data_entry_error` | An entry posted correctly into the right period carried a wrong account, store, or amount, discovered after close; the fix belongs in the same period it was originally misrecorded to, so that period's own trial balance is the one that's right. |
| `other` | Escape hatch for a reason not enumerated above — `note` becomes mandatory (constraint above) precisely because an un-enumerated reason needs its own sentence, not a checkbox. Expected to be rare enough that each use is worth a look. |

Three named + one escape hatch, matching the `sessions_ended_reason_check` shape (4 members) and
the `inbox_quarantine_reason_check` shape (named members + free text) already in this schema.

⛔ **Two things system32-85 required in the schema file's own comment, not just here:**
1. Adding a fifth member later is a **migration**, because `reason` is a CHECK constraint, not a
   bare TS union — the next person reaching for "just add one more string" should see this before
   assuming it's a one-line change.
2. `data_entry_error` does **not** mean the whole correction routes through the override.
   Reversals of entries in already-closed periods are already legitimate and need no exemption at
   all (`0003:202-208` says so in terms) — only the RE-POST of the corrected entry needs
   `periodOverride`. The reversal half of a correction must never be wrapped in an override: that
   would apply a break-glass capability to a path that never needed one, and leave an audit row
   for something ordinary.

## Migration `0143` — shape (not yet written; BUILD writes it after APPROVED)

Two `CREATE OR REPLACE FUNCTION` statements replacing `journal_entries_check_period_open` and
`journal_lines_check_period_open` forward (0003 is applied, never edited — new migration, same
pattern as 0005 replacing 0003's `journal_lines_check_account_eligible` forward), each gaining —
**`locked` branched FIRST, per system32-85's addition, so it never shares a message with a plain
closed refusal:**

```sql
is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';
...
IF period_status = 'locked' THEN
  RAISE EXCEPTION 'cannot post into period % — it is locked (a later period''s close already '
    'depends on it) and the period-override capability does not apply to locked periods',
    NEW.period_id;  -- (journal_lines' version names the entry, not the period, matching today's phrasing)
ELSIF period_status <> 'open' THEN
  -- only 'closed' (and any future non-open, non-locked status) reaches here
  IF period_status = 'closed' AND is_override_context THEN
    -- fall through, allowed
  ELSE
    RAISE EXCEPTION ...;  -- identical wording to today: the fail-closed proof, observation 2
  END IF;
END IF;
```

Plus `CREATE TABLE period_overrides` with the constraints above, its RLS block, and the two
`ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` + policy statements. One file, one migration
slot (0143), per ADR-012 §5. Proved on a scratch database (`shareat_scratch_t264s3`), never a
shared one, per ADR-012 §5 step 8 — created and dropped, not left behind.

## Tests — watched failing first, in this order

All in `packages/domain/tests/integration/period-override.test.ts` unless noted, against
`shareat_test_lanea` via `it.mjs`. **Every case calls `postEntry` directly** (the same
`postEntryAsOrg`/`withOrgPrincipal` harness `post-entry.test.ts` already uses), never
`confirmReceipt`/`runProductionPosting`/`recordInternalReturn` — per DEF-302, a test on any of
those three would fail at the `stock_movements` trigger for a reason that has nothing to do with
this task, and would misreport as "the override doesn't work."

1. **Baseline (pre-exemption), observed for real**: insert a `closed` period, attempt an ordinary
   `postEntry` (no `periodOverride`) dated into it. Capture and assert the actual raised message
   (today's `journal_entries_check_period_open` text) — this is the "before" photograph, run
   against the CURRENT migrations before 0143 exists in this branch's history... in practice this
   observation is made once, by hand, against the pre-0143 database, and its output is quoted in
   the READY report; the automated test suite (which runs against the fully-migrated schema) can't
   reproduce a "before 0143" state on its own, so this one is a manual/logged observation, not a
   vitest case.
2. **After the exemption exists, NO flag set** — same setup, ordinary `postEntry`, no
   `periodOverride`, against the post-0143 schema. Must still throw, identically to today. This is
   the test proving `coalesce(..., '') = 'on'` fails CLOSED — the one the build note calls out as
   the database observation, distinct from #3.
3. **A `manager` attempting the override** — `periodOverride.actor` is a `manager`-role person,
   period is `closed`. Assert `AuthorizationError` from `authorize()`, and assert (via a spy or a
   raw-SQL check) that `set_config` was never reached / `period_overrides` gained no row. This is
   the TypeScript-layer observation and, per the build note, does NOT alone satisfy the
   non-negotiable — it's reported as its own case, not merged with #2.
4. **Admin override succeeds** — `admin` actor, closed period, valid `reason`. Assert: `postEntry`
   returns a created entry; the entry's rows exist in `journal_entries`/`journal_lines` with the
   closed period's id; exactly one `period_overrides` row exists with the right `org_id`,
   `period_id`, `entry_id`, `actor_person_id`, `reason`.
5. **super_admin override succeeds** — same as 4, `super_admin` role, to prove the matrix cell,
   not just the derived-set path.
6. **Elevated manager in an adminless org succeeds** — bible row 196: a `manager` holding the
   `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` fallback (org has no active admin) DOES pass. Proves
   row 196's ruling is actually live through this code path, not just through the capability
   matrix test.
7. **`locked` period is refused even with a valid override, WITH THE DISTINCT MESSAGE** —
   `super_admin` actor, valid reason, period status `locked`. Must throw, and the message must
   name `locked` and say the override does not apply to it — asserted as a DIFFERENT string from
   the plain "not open" refusal in test #2/#10, not merely "also throws." Proves system32-85's
   addition is actually built, not just documented: an admin reading this message can tell their
   capability was consulted and correctly refused to apply, rather than wondering if the feature
   is broken.
8. **What a row MEANS, pinned**: `periodOverride` on an ALREADY-OPEN period — `admin` actor, valid
   reason, period `open`. Per contract point 2/5 (system32-85's race-condition reasoning):
   `authorize()` still runs (assert it's called — a refusal here would still block), and a
   `period_overrides` row IS written with `period_status_at_post = 'open'` (unconditional on
   whether the trigger needed to stand aside). Entry posts normally. This pins the exact
   distinction the schema comment states: a row means "the capability was invoked," not "the lock
   was bypassed" — and this test is the proof that the two can diverge.
9. **`reason = 'other'` with no `note`** — rejected at the database (CHECK constraint), naming
   which constraint fired.
10. **Existing invariant 11 test (`post-entry.test.ts`, "'closed' period... rejected") stays
    green, unedited** — periodOverride is additive; this is the byte-identical case.
11. **Existing invariant 12 test ("'locked' period... rejected") stays green, unedited** — same
    reasoning, and doubles as a second proof of question 1 at the "no override attempted" level.
12. **`tests/unit/capability-matrix.test.ts` stays green, unedited** — expected, per the build
    note; will report the run rather than touch the file.
13. **Migration-journal and table-count assertions** — expected to move by one; updated and
    reported, not treated as a surprise.

## Out of scope (restated, not re-litigated)

No reopen path. `stock_movements_check_period_open` untouched. `apps/erp/src/lib/
constraint-messages.ts` untouched — lane B's this cycle.

⛔ **DEF-302, in plain words: the override does not work on three real flows, and it is not this
task's job to make it.** `commissary/transfer.ts:confirmReceipt`, `production/index.ts:
runProductionPosting`, and `trade/returns.ts:recordInternalReturn` each move stock and post a
journal entry in the same database transaction, and the stock movement is checked by a trigger
(migration 0063) that has no concept of this override at all. So if one of those three tries to
post into a closed period, the transaction dies at the stock movement — before the ledger entry,
before `authorize()`, before anything this task builds is even reached. An admin using the
override through one of those three screens would see a stock error, not a period error, and get
no benefit from holding the capability. Extending the exemption to `stock_movements` was
considered and rejected by system32-85: it would let a back-dated movement rewrite inventory
layers and therefore COGS for a closed month, which is an inventory decision for Ian, not a ledger
one. The override in this slice is real and correct for every pure-ledger posting path; it is
simply absent, by design, on these three.

## Done when

typecheck clean · unit green · integration green against `shareat_test_lanea` · self-reviewed line
by line · the three "watch it fail first" observations captured and quoted separately in the
READY report · every file outside this scope list named and justified · the `reason` enum (ruled
on by **system32-85**, not Ian — corrected from the SPEC draft, which wrongly deferred this to
Ian) built exactly as approved · `docs/tasks/264-*.md`'s own "done when" for slice 3 satisfied.
Smoketest/`npm run build` are out of reach for a lane restricted to `it.mjs` + typecheck/unit —
named as not-verified in the READY report per this lane's own grant, not silently skipped.

## Barrel handshake (system32-85's addition 3)

`packages/db/schema/period-overrides.ts` is created FIRST, before anything else in this scope
list, then a one-line "[A] QUESTION: schema file created" goes to system32-85 so they can add
`export * from './period-overrides';` to `packages/db/schema/index.ts` within the minute — not
added by this lane even though it is one line (the orchestrator skill's own red flag: "I'll just
do this one thing first"). Work continues on the migration without waiting idle for the barrel
line to land.
