# T-264 — DEF-284: give the period lock a way to be armed, and an override only admins hold

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⚠️ **THREE SEPARABLE SLICES, AND SLICE 1 IS NOT ABOUT LOCKING AT ALL.** Slice 1
> fixes a failure happening today; slices 2 and 3 build the control Ian asked for. **Do not attempt
> all three in one change** — each has a different shape and a different risk.

## The situation, in one paragraph

The database already enforces the rule correctly. `fiscal_periods` exists with
`status in ('open','closed','locked')`, and the period-open trigger (migration `0003`, bible §16.1
invariant 7) refuses a posting into a closed period **by any path**. ⛔ **But `fiscalPeriods` is
read-only across the entire codebase** — `packages/db/src/repo/journal.ts` only ever `SELECT`s it.
There is no repo writer, no domain function, no server action, no screen and no job that creates a
period or closes one. **The wall is built and enforced, and nobody has been given a way to raise
it.** Anyone with posting rights can back-date into January in June.

⭐ **The symptom is already on screen and has been read as mundane.** `fixed-assets/page.tsx:85` and
`components/scheduler-status.tsx:78` both carry the stock failure *"no fiscal period covers …"* —
that is depreciation failing because **no period row exists at all**, not a date edge case.

## Ian's decision, 2026-09-10 — the WHAT, not open to revision

> A **lock with an override**, and the override is restricted to **`admin` and `super_admin` only**.
>
> The close happens on **the 15th of the following month**, because some sales channels remit up to
> the second week. ⭐ **That makes the 15th a PROMPT FOR A HUMAN, not a trigger** — *"did the
> remittance actually arrive"* is a judgement a timer cannot make. Do not schedule the close.

Both roles already exist: `person_roles_role_check` in migration `0014` is
`('super_admin', 'admin', 'manager', 'staff')`.

---

## ⛔ SPEC AMENDMENT, orchestrator, 2026-09-11 — **THIS TASK HAS A RATIFIED ADR AND THE SPEC DOES NOT CITE IT**

**`docs/decisions/ADR-006-period-close.md` — *"Period close: every period closes on the 15th; only
the year posts an entry"*, ✅ Accepted 2026-08-23, 290 lines, with Ian's own answers to five
questions recorded in its §7 — is not referenced anywhere in this spec, and not in DEF-284's
register row either.** Read it before slice 2 or slice 3. It is the governing decision for this
area and it pre-answers questions this spec leaves open.

### What ADR-006 already settles — do NOT let a lane re-decide these

| This spec's open question | ADR-006's ratified answer |
|---|---|
| *"Say what `locked` means here"* (Watch out) | §7.5: `closed` → `locked` is **automatic once the following year's close posts successfully**. `locked` records that a later year now depends on the period. Not a synonym for `closed` |
| Who may close | §7.4: **admin and manager**, enforced server-side. ⭐ **Already built and consistent** — `close_period` in `packages/auth/src/capabilities.ts:682` is `{super_admin: true, admin: true, manager: true, staff: false}`, and `authorize.ts:138` adds the extra condition that a *manager* must have org-wide store scope. Slice 2 should reuse this untouched |
| The 15th as the close date | §7.3, decided **2026-08-23**: *"Every period closes on the 15th of the following month."* ⭐ Ian's 2026-09-10 ruling is therefore a **re-affirmation of his own earlier decision, not a new one** — two independent arrivals at the same date, which strengthens it |

### ⛔ AND ONE GENUINE TENSION THAT IS IAN'S TO RESOLVE, NOT A LANE'S — SLICE 3 IS BLOCKED ON IT

**ADR-006 §7.1 and its "Reopening — NOT BUILT" section record Ian deciding *against* an override
path, in almost the words this task uses to describe one.**

> ADR-006, *Reopening — NOT BUILT*: "The research recommended a guarded reopen path (**admin-only,
> most-recent-only, mandatory reason**). **Ian decided against it entirely: a closed year is never
> reopened** (§7.1)." And §7.1: "An error found afterwards is **carried into the following year as a
> prior-period adjustment** — the mechanism `reverseEntry` already implements. **No reopen path is
> built, so none can be abused.**"

DEF-284, 2026-09-10: *"a LOCK WITH OVERRIDE, and the override is restricted to `admin` and
`super_admin` only"* — with, per slice 3, **a typed reason and an audit row**. That is admin-only
plus a mandatory reason: the shape ADR-006 records as declined.

⚠️ **State the distinction fairly, because it is real and it may be the whole answer:**

- ADR-006 rejected **reopening** — flipping `status` from `closed` back to `open`, which makes the
  period generally postable again for everyone until someone closes it a second time.
- Slice 3 proposes a **transaction-local, per-posting exemption** — the period stays `closed`, one
  authorised entry is let through, and the GUC dies with the transaction.

These are genuinely different mechanisms with different blast radii, and ADR-006 did not evaluate
the second one. ⛔ **But they aim at the same outcome — an entry landing in a closed period — and
ADR-006's stated reason for never-reopen was that the prior-period adjustment is *the only* path.
An override is a second path.** Two ratified decisions cannot both be the rule here.

**✅ RESOLVED BY IAN, 2026-09-11 — SLICE 3 IS UNBLOCKED. The new decision wins.**

> Ian, asked directly whether the August ADR or the September ruling governs:
> ***“new one wins admin and super admin”***

Recorded in **`PROJECT_BIBLE.md` §13 row 193**, and `docs/decisions/ADR-006-period-close.md` now
carries a supersession note above its *Reopening — NOT BUILT* section so the next reader cannot
find the old conclusion without the new one.

⛔ **What is superseded is NARROW, and over-reading it is the risk now:**

| | |
|---|---|
| **Sanctioned** | A **transaction-local, per-posting exemption** for `admin` and `super_admin`. The period stays `closed`; one authorised entry passes; the flag dies with the transaction |
| **Still NOT built, and not asked about** | **Reopening** — flipping `status` from `closed` back to `open`. ADR-006's rejection of that stands. Do not build a reopen button, a status-revert action, or an admin screen that sets a closed period back to open |
| **Unchanged** | The prior-period adjustment via `reverseEntry` remains the DEFAULT correction path. The exemption is the exception, not the new normal |
| **Unchanged** | Reversals of entries in already-closed periods are legitimate and already handled by migration `0003` lines 202-208. Your override must not disturb or duplicate that path |

### The capability-vs-role question, DECIDED — orchestrator, since it is a HOW

Ian named **roles**; this codebase deliberately expresses these as **capability** questions
(`sales-days/create.ts:258` says so in terms). Both are satisfiable at once, so:

⭐ **Add a NEW capability — `override_period_lock` — granted to `super_admin` and `admin` only,
`false` for `manager` and `staff`.** Check that, not the role string.

- It preserves Ian's WHAT exactly: those two roles and no others.
- It keeps `packages/auth/src/capabilities.ts` the single readable answer to *“who may do what”*,
  rather than hiding one rule in a role comparison somewhere else.
- ⛔ **Do NOT reuse `close_period`.** That capability is granted to `manager` too
  (`capabilities.ts:682`, and ADR-006 §7.4 deliberately gives managers the close). Reusing it would
  silently hand the override to every manager — exactly the widening Ian did not authorise.
- ⚠️ A new capability is a schema-adjacent change: it touches the capability list and the matrix,
  and it may need a migration for existing grants. **Ask me before writing one.**

### Non-negotiables for slice 3, from bible row 193

- ⛔ **Reuse migration `0005`'s transaction-local GUC idiom**, `coalesce(current_setting('app.period_override', true), '') = 'on'`, so an **unset flag reads as NOT exempt** and any bug, crash or forgotten line fails **CLOSED**. Do not invent a second mechanism.
- ⛔ Set the flag **only after `authorize()` has confirmed the capability** — never from a caller-supplied parameter (bible §7.1, landmine 17).
- ⛔ **Do not implement the override in TypeScript around the trigger** (RULES §6 item 3 / bible §15.11). The database keeps enforcing the period rule; the app only decides who may raise the flag.
- ⛔ **Watch it fail first**: an override attempt by a `manager` must be REFUSED by the database, and that refusal must be observed before the exemption is wired — not reasoned about.
- ⭐ An override without an audit row is a hole with better manners. Record who, which period, which entry, and **why** as a typed reason. Check whether an existing audit table fits before adding one.

⭐ **Slices 1 and 2 were never blocked by this.** Slice 1 fixes a live failure; slice 2 is ADR-006's
own design and is reinforced, not contradicted, by it.

### ⚠️ One citation to correct while you are here

This spec and DEF-284 both cite **"bible §6.3"**. There is no §6.3. `docs/RULES.md` §6 item 3 says so
in terms: *"There is no 'bible §6.3'; a citation to it means this item — bible §15.11."* The rule
being invoked (the database enforces period rules; a second copy in the service layer drifts) is
correct and unchanged — only the pointer is wrong.

---

## Slice 1 — something must CREATE fiscal periods

**Ship this first and alone. It is not about locking, and it is more urgent than this spec first
said.**

### ⛔ SEVERITY CORRECTION, orchestrator, 2026-09-11 — THIS IS NOT "DEPRECIATION FAILS"

This spec and DEF-284 both describe the symptom as depreciation failing. **Re-derived at source, the
blast radius is the entire ledger.**

- `journal_entries.period_id` is **`NOT NULL`** with an FK to `fiscal_periods`
  (`packages/db/schema/journal.ts:82`).
- `postEntry` — **the single entry point to the ledger** — resolves the period by date and throws
  when none covers it (`packages/domain/src/ledger/post-entry.ts:112-116`).
- The `journal_entries_period_open` trigger (migration `0003:226`) independently raises if the
  period is missing or not `open`.
- ⛔ **`scripts/bootstrap-org.ts` contains the string "period" ZERO times.** It seeds the chart of
  accounts and expense categories, and no fiscal period.
- ⛔ **Every single `insert into fiscal_periods` in this repository is in a test file or in
  `scripts/dev-seed-inventory.ts:132`.** There is no production writer of any kind.

**Therefore a freshly bootstrapped production organisation cannot post ANY journal entry — not a
sale, not an expense, not payroll, not depreciation.** The ledger refuses the first entry it is ever
offered. Depreciation is merely where this is *visible on a screen*, because that job records and
displays its own failures; everything else fails at the moment someone tries.

⭐ **And the pilot is the first organisation on production, with cutover on 1 January 2027.** The
cutover opening entry (`addOpeningFigure`, `cutover/opening.ts:71`) needs a covering period too, and
ADR-005 dates it `2027-01-01`. **So this is a cutover blocker, not a scheduler bug.**

⚠️ Why it has never been felt: `dev-seed-inventory.ts` hand-inserts periods, and every integration
test inserts its own. **The one path that has never had them is the one production will use.**

### The data-shape decision — MADE, with the reasoning, per this spec's own instruction

**Periods are CALENDAR MONTHS, created EXPLICITLY, a year at a time — seeded at org bootstrap, with
an admin action to generate the next year, and a findings check that warns before the runway runs
out.**

Why each half, and what would have to be true for it to be wrong:

| Option | Verdict |
|---|---|
| **Lazily, on demand — `postEntry` creates the month when it finds none** | ⛔ **REJECTED, and it is the trap.** It would make slice 2 and slice 3 pointless: back-dating into January in June would silently *create January as open* and post into it. **An auto-created period is an auto-opened one.** The whole task exists to stop exactly that |
| **A scheduled job creating next month ahead of time** | ⛔ Rejected as the primary mechanism. If the job fails, the ledger stops accepting entries and the failure is silent — DEF-044's shape, the thing this project keeps being bitten by |
| **Explicit, a year at a time, seeded at bootstrap** | ✅ **Chosen.** A fresh org works immediately; creation stays a deliberate act, so the control survives |
| **Plus a runway warning in the findings feed** | ✅ **Chosen, and it is what stops the time bomb.** Seeding a year without it just moves the outage twelve months out. The findings feed already exists and ADR-006 §8 already established the daily-checker pattern — this needs no new machinery |

- **Calendar months**, `starts_on` = the 1st, `ends_on` = the last day. Required by ADR-006 (every
  period closes on the 15th of the following month) and by `endOfPeriod(period)`, which the
  depreciation runner uses as its posting date. Adjacent months do not overlap, so the `EXCLUDE
  USING gist` no-overlap constraint is satisfied, and ADR-006's requirement that two periods may be
  open at once (December and January coexist until the 15th) still holds.
- ⚠️ **Seed enough to cover the cutover opening date**, not just "from today" — `addOpeningFigure`
  posts at `2027-01-01`.
- ⚠️ **`bootstrap-org.ts` should own the seeding**, because it is the one path a real org travels
  and it already seeds the chart of accounts. Existing orgs need a backfill; say how.
- ⚠️ The period must cover the dates depreciation posts to — a period that exists but does not span
  `endOfPeriod(period)` fails identically.

⛔ **This decision is cheap to reverse ONLY until rows exist.** Once an org has periods with entries
pointing at them, changing the shape means migrating live FKs. Say so if you disagree, before
building.

## Slice 2 — a way to CLOSE one

- A surface for a holder of the **`close_period`** capability. ⚠️ That capability already exists and
  is authorised in two places (`findings/index.ts:184`, `sales-days/create.ts:266`) — **for other
  actions, never for closing a fiscal period.** Reuse it; do not invent a second name.
- `closed_at` and `closed_by` (→ `persons`) already exist on the table and are unwritten. Write them.
- ⚠️ **Closing is a human action prompted on the 15th, never scheduled.** See Ian's ruling above.
- ⭐ Consider what "ready to close" means and surface it — that is the useful half for the person
  deciding, and it is the reason the 15th exists.

## Slice 3 — the override, and it has a sanctioned pattern already

⛔ **DO NOT INVENT A MECHANISM. This schema already has one and it must be reused.**

Migration `0005` exempts reversal postings from a comparable rule using a **transaction-local GUC**:

```sql
is_reversal_context := coalesce(current_setting('app.reversal_posting', true), '') = 'on';
```

⭐ **Why that shape is the right one, and it is the whole reason it is safe:** `set_config(..., true)`
is transaction-local, so it cannot leak into the next request on a pooled connection; and the
`coalesce(..., '')` means **an unset GUC reads as NOT exempt**. A bug, a crash, or a forgotten line
can only ever fail *closed*. Build `app.period_override` the same way.

- The GUC is set **only after `authorize()` has confirmed the role** — never from a caller-supplied
  parameter (bible §7.1, landmine 17: *"who approved this" is a value the caller chose*).
- ⛔ **Do NOT implement the override in TypeScript around the trigger.** RULES §6 item 3 and bible
  §6.3: the database enforces period rules; a second copy in the service layer is a second source of
  truth and the two will drift. The trigger gets the exemption; the app decides who may set the flag.
- ⭐ **An override without an audit row is a hole with better manners.** Record who overrode, which
  period, which entry, and **why** — a typed reason, not a boolean. Check whether an existing audit
  table fits before adding one.

---

## Watch out

- ⚠️ **`close_period` is a CAPABILITY, and Ian named ROLES.** Decide deliberately whether the
  override checks the role directly or a new capability granted to those roles, and say which. This
  codebase deliberately expresses these as capability questions — `sales-days/create.ts:258` says so
  in terms: *"Deliberately expressed as a CAPABILITY question, not a role check."* ⛔ Do not
  contradict that without stating why.
- ⚠️ **Reversals of entries in closed periods are legitimate and already handled** (migration `0003`
  lines 202-208: *"reversals of entries in already-closed periods are the primary real-world use of
  a reversal"*). Your override must not disturb that path or duplicate it.
- ⚠️ `status` has **three** values — `open`, `closed`, `locked`. Say what `locked` means here and
  whether this task touches it. Do not silently treat it as a synonym for `closed`.
- ⛔ Any schema change is a **hand-authored migration** (RULES rule 9, ADR-012 §5, `npm run
  db:generate` is retired and fails closed). One migration slot per lane per cycle.

## Out of scope

- **T-263** — the `lastCompletedPeriod()` timezone fix. Different defect, do not fold it in.
- Moving the month-end timer. Ops change, Ian's, and it is sequenced after T-263.

## Done when — per slice, and each ships on its own

- The slice's decision is stated in writing before code, with what would have to be true for it to
  be wrong.
- typecheck clean · unit green · **integration green against real Postgres** · smoketested in the
  running app on 9008 · `npm run build` succeeds with the dev server stopped · self-reviewed.
- ⛔ **Slice 3 must be watched failing first**: an override attempt by a `manager` must be REFUSED by
  the database, and the refusal must be observed before the exemption is wired, not reasoned about.
- The report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-284, DEF-249, DEF-260; `PROJECT_BIBLE.md` §16.1 invariant 7,
§7.1, §12 landmine 17; migrations `0000` (table), `0003` (the trigger), `0005` (the exemption
pattern), `0014` (the roles).

---

# ⭐ SLICE 3 BUILD NOTE — orchestrator, 2026-09-12. READ THIS BEFORE THE SLICE 3 SECTION ABOVE.

Slices 1 (`5706a06`) and 2 (`6a9ed65`) are shipped. This note resolves every open decision slice 3
had left, and records three things found by grepping the enforcement surface that neither this spec
nor DEF-284 mentions. **Where this note and the slice 3 section above disagree, this note wins.**

## ⛔ FINDING 1 — the period rule is enforced in FOUR places, not the one the spec implies

`git grep check_period_open` over `packages/db/migrations/`:

| # | Where | What it guards | In scope for the override? |
|---|---|---|---|
| 1 | `journal_entries_check_period_open` — `0003:214` | INSERT/UPDATE on `journal_entries` | ✅ **YES** |
| 2 | `journal_lines_check_period_open` — `0003:246` | INSERT/UPDATE on `journal_lines` | ✅ **YES** |
| 3 | `stock_movements_check_period_open` — `0063:111` | INSERT on `stock_movements` | ⛔ **NO — see below** |
| 4 | **A TypeScript pre-check** — `post-entry.ts:118-123` | throws before the DB is ever reached | ⚠️ **Must be taught the override, or it is dead on arrival** |

⛔ **Amending only #1 produces an override that appears to work and does not.** The entry header is
let through and the first line is refused by #2, so the transaction still rolls back — with a
*different* error message, which is the worst possible failure because it reads like a new bug.
**Amend #1 and #2 in the same migration, or neither.**

⚠️ **#4 is the subtle one and it is the reason to read `post-entry.ts` before writing SQL.**
`postEntry` resolves the period and throws *"fiscal period … is closed"* in TypeScript *before* any
insert. A migration that perfectly exempts both triggers changes nothing observable, because the
override never reaches them. ⛔ **This is NOT the "do not implement the override in TypeScript"
rule being relaxed** — that rule forbids the app being the *authority* on the period rule. #4 is a
friendly early error, not the authority. **Teach it to stand aside when the override is active and
let the database make the final call; do not delete it for everyone else.**

### ⛔ Why `stock_movements` is deliberately OUT of scope — and the one thing to verify, not assume

Ian's ruling is about **one journal entry** being let through. A stock movement is not a journal
entry, extending the exemption there is a decision nobody has made, and #3 already permits a
movement where no period row exists at all — a different rule with a different rationale
(`0063:106-109`). **Do not touch #3.**

⚠️ **But VERIFY rather than assume the two never travel together** — this is the slice's named
question, and it is worth more than the code:

> **Does any path that calls `postEntry` also insert into `stock_movements` in the SAME
> transaction?** If one does, an override on that path half-succeeds: the ledger entry passes and
> the stock movement is refused. **Report the answer either way. Do not fix it — report it.**

## ⛔ FINDING 2 — the capability is ALREADY WIRED. Do not add it.

`override_period_lock` was pre-wired by the orchestrator (the capability matrix is the
orchestrator's row): `capabilities.ts` in all four places, the row in
`docs/decisions/CAPABILITY-MATRIX.md`, and the pin in `tests/unit/capability-matrix.test.ts`
(95 → 96). **Typecheck clean, 212/212 green at the time of writing.** Use it; do not edit those files.

- `super_admin: true, admin: true, manager: false, staff: false` — scope `'org'`.
- ⛔ **No `authorize.ts` extra condition.** Unlike `close_period`, it is never granted to a manager
  in the baseline, so there is no store-scope conflict to resolve. Do not add one.

⭐ **Ian's ruling, 2026-09-12 (bible row 196), that you must not "fix":** because the matrix cell is
admin-yes/manager-no, the capability **automatically enrols into
`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`** — the derived fallback set. So in an organisation with no
active administrator, an elevated manager **does** hold the override. The orchestrator escalated
this as an apparent contradiction of row 193's *"admin and super_admin only"*; **Ian ruled it
correct and intended**: such an org has nobody else who could ever authorise a late entry, and the
grant is revoked the moment an administrator arrives (row 188). ⛔ **Do not add a carve-out** — the
pin's own comments record that a hand-maintained exception to a derived set is what drifts.

## The contract — DECIDED, because it is a HOW

⛔ **The override is EXPLICIT and PER-CALL. It is never implied by holding the capability.** An
admin who holds it posts into open periods normally, all day, with no exemption anywhere near the
transaction. The exemption exists only when the caller asks for it *and* passes authorize.

```
postEntry(tx, actor, { …, periodOverride: { reason: <typed>, note?: string } })
```

1. `periodOverride` absent → **nothing changes**. No GUC, no audit row, no new code path. This is
   the case that must stay byte-identical, and it is ~100% of postings.
2. `periodOverride` present → `authorize(actor, 'override_period_lock')` **first**. A refusal here
   is an ordinary authorization failure and nothing is written.
3. Only after that: `set_config('app.period_override', 'on', true)`.
4. The TS pre-check (#4) stands aside; the **database** decides.
5. The audit row is written **in the same transaction**, so an override that rolls back leaves no
   record of having happened — and one that commits cannot fail to have one.

⛔ **`reason` is a TYPED enum, never free text and never a boolean** (the spec's own requirement).
`note` is the optional free-text elaboration beside it, not a replacement for it. **Propose the enum
members in your SPEC and I will rule on them** — do not invent them in the implementation.

## The audit table — DECIDED: a new table, not `audit_log`

`audit_log` exists (`packages/db/schema/audit-log.ts`) and was checked first, as the spec requires.
It does not fit, for reasons that are about shape, not taste:

- `entity_id` is a single `NOT NULL uuid`. An override is about a **period AND an entry**; one of
  the two would have to be demoted into `jsonb`.
- A **typed** reason needs a CHECK constraint. A reason living in `jsonb` cannot be constrained,
  which makes "typed" a comment rather than a rule.
- An FK to `journal_entries` makes *an override with no entry* unrepresentable. `audit_log` cannot
  express that, so the strongest guarantee available would be given up for a table reuse.

**Build `period_overrides`** with: `org_id`, `period_id` → `fiscal_periods`, `entry_id` →
`journal_entries`, `actor_person_id` → `persons` (**NOT NULL** — unlike `audit_log` there is no
system-actor case here; a machine can never hold this capability), the typed `reason`, optional
`note`, `created_at`. ⛔ **ADR-012 §5 step 4 applies in full**: `ENABLE ROW LEVEL SECURITY` with
policies through `app_current_org()` (never raw `current_setting` — DEF-077), registered in
`packages/db/src/rls/registry.ts` **and** classified in `packages/db/src/cutover/classification.ts`.
The build stops you until both are done.

## Migration slot — ALLOCATED, use exactly this

| | |
|---|---|
| File | `packages/db/migrations/0143_t264_period_override.sql` |
| idx | `143` |
| `when` | **`1798428707084`** — `1798342307084 + 86_400_000 × 1`, per ADR-012 §5 step 5 |
| tag | `0143_t264_period_override` |

⛔ Hand-authored. `npm run db:generate` is retired and fails closed (RULES §1 rule 9). Prove it on a
**scratch** database (`shareat_scratch_<x>`), never on a shared one — ADR-012 §5 step 8. Do not add
a `meta/*_snapshot.json` (step 7).

## ⛔ Watch it fail first — what "observed" means here, precisely

The spec requires a refusal to be **watched, not reasoned about**. That is three distinct
observations, and two of them are easy to conflate:

1. **Before the exemption exists** — post into a closed period and watch trigger #1 raise. Capture
   the real message. This is the baseline.
2. **After the exemption exists, with NO flag set** — the same posting must still be refused,
   identically. This is what proves the `coalesce(…, '') = 'on'` idiom fails CLOSED.
3. **A `manager` attempting the override** — refused at `authorize()`, before any GUC is set.
   ⚠️ **This is a TypeScript refusal, and on its own it does NOT satisfy the non-negotiable.**
   Observation 2 is the database one. Report all three separately; do not merge them into one
   "the override is refused for non-admins" assertion.

## Expected reds — predicted by name, so you report them instead of fixing them

- ⚠️ Anything asserting the **count** of tables, RLS-registered tables, or migrations will move by
  one. That is correct; update the count and say so in your report.
- ⛔ **`packages/auth/tests/super-admin-capability-set.test.ts` must stay GREEN and untouched.** Its
  `PINNED` list is super-admin-ONLY capabilities; `override_period_lock` is admin-yes, so it is
  correctly absent. **If that test goes red, something is wrong with your change** — it is the one
  pin whose header says *"⛔ Do not update this to make the test pass."* Report it, do not edit it.
- ⚠️ A test asserting `postEntry`'s signature or its closed-period error text may move. Adding an
  **optional** field must not change any existing caller; if an existing caller needs editing,
  stop and report — that means the field was not optional in practice.

## Out of scope for slice 3 — named, so the boundary is not a judgement call

- ⛔ **A reopen path** — flipping `status` from `closed` back to `open`. Bible row 193 is explicit
  that this remains unbuilt and was not what Ian was asked. No reopen button, no status-revert
  action, no admin screen that sets a closed period back to open.
- ⛔ `stock_movements_check_period_open` (finding 1, #3).
- ⛔ `apps/erp/src/lib/constraint-messages.ts` — **lane B owns it this cycle (T-271/DEF-301).** If
  your refusal would read better with a friendly sentence, say so in your report; do not add a key.
  DEF-301 is precisely that adding one silently matches nothing.
- ⛔ The `errorMessage` / `CONSTRAINT_MESSAGES` map generally, for the same reason.
