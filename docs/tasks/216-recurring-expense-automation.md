# T-216 — Recurring-expense automation

> **Status**: 🟡 **HALF BUILT 2026-09-06 — the template ships, the JOB does not, and the job is
> the half that is blocked.**
>
> ⛔ **Open question 2 is unanswered and it must be answered before the job is built.** §3 argues
> that v2 should **draft** where v1 **auto-pays**, and the spec says so itself: *"say no and it
> changes the shape of the job, not just a flag — worth answering before build rather than after."*
> That is exactly why the job is not here. Building it against the wrong answer means rewriting it;
> registering a job nothing runs is DEF-044's shape, a cron claimed in data and absent in fact.
>
> **What shipped** — everything identical under either answer: `recurring_expenses` (migration
> `0132`, applied AND recorded on both databases), the recurrence arithmetic ported from v1 with
> **16 unit tests**, `recurringExpensesRepo`, create / edit / pause / resume / delete-if-unused,
> the `manage_recurring_expenses` capability, `/expenses/recurring`, and **16 integration tests**.
>
> ⭐ **The screen SAYS the job does not exist**, in a banner, in plain language. A feature that
> quietly does nothing is the defect class this project keeps hitting (DEF-190 and the eight before
> it); one that tells you it does nothing *yet* is a plan with a visible next step. Verified in the
> browser, not assumed.
>
> **What is NOT built and is waiting on the answer:** `runBudgetReissue`'s sibling
> `runRecurringExpenses`, `scripts/recurring-expenses.ts`, the `recurring_expenses` entry in
> `scheduler_runs_job_check` (deliberately untouched by `0132`), and integration cases 1–6, 9 and
> 10, which are all job cases.
>
> ⚠️ **`docs/ops/**` is out of this session's bounds** — another session and Ian own the droplet —
> so the systemd pair is not written here either. It would have nothing to arm yet regardless.
>
> ⭐ **A defect found by writing the cutover classification rather than by running the purge:**
> `last_drafted_expense_id` points at `expenses`, which is class PURGE, while this table is class
> KEEP. A `restrict` FK there would make a KEEP table **block the 1 January purge** of a PURGE one.
> It is `ON DELETE SET NULL`, and provenance of a deleted draft is worth nothing anyway.
>
> ⭐ **Pulled out of "deliberately deferred past January" by Ian on 2026-09-06** — *"do it now."*
> Same resolution as T-215: `ROADMAP.html` deferred it as *"automation over expenses, which are
> already in scope"* while the completion blueprint scheduled it in the Phase 6 bulk. **In scope,
> now.**
>
> ⛔ **The central decision is made up front and it is the opposite of v1's.** v1 **auto-pays**: a
> due recurring expense posts a real expense and moves real cash on a cron, guarded by a period
> lock. v2 **auto-drafts**: the job creates a draft expense and a human posts it. §3 argues this
> at length, because it is the one place this task diverges from proven practice and RULES §1.3
> requires the divergence be recorded rather than assumed.

## Why this exists, and what v1 already learned

**Studied at source:** `ERP-rebuild/src/lib/actions/recurring-expense.actions.ts` (892 lines),
`recurring-expense/recurrence.ts` (158) and its test, `payment-routing.ts` (78) and its test,
`system-rows.ts` (63) and its test, `recurring-expense.autopay-lock.test.ts` (202),
`payroll/recurring-rows.ts` (174), and `src/app/financial/recurring-expenses`.

**The goal it was built to achieve:** *the fixed monthly bills — rent, internet, utilities,
subscriptions — should not depend on somebody remembering them.* A branch that forgets rent does
not fail to pay rent; it pays it late, off-book, and the month closes wrong.

⭐ **This is one of the largest and most defect-scarred modules in v1** — nearly 1,700 lines
across implementation and tests, with four separate hardening rounds visible in its own comments.
Every one of those rounds is a requirement, and three of them are requirements *because* v1
auto-pays.

### What v1 learned the hard way — each one is a requirement here

| v1's lesson, in its own words | Where |
|---|---|
| ⛔ **"A recurring/scheduled payment must never silently draw from the cashier till."** The till is the daily operating drawer; anything ambiguous resolves to **office cash**, and the cashier account is used only when deliberately chosen | `payment-routing.ts:5-8` |
| ⛔ **Five seeded payroll rows shipped ACTIVE and confirmable**, and confirming one would have posted a *second* real cash movement for a payroll already paid per staffer, or expensed a statutory contribution already withheld into a liability — **double-counting, twice over** | `system-rows.ts:9-33` |
| ⛔ Two independent signals identify a system row — the `isSystem` flag **and** the frozen `payroll__` id prefix — *"belt and braces: a row whose flag was stripped by a hand edit is still recognised by its id"* | `system-rows.ts:35-38` |
| ⛔ A due date inside a **locked period** must write a pending record and an alert and **post nothing** | `recurring-expense.autopay-lock.test.ts:146` |
| One predicate gates both the server action and the UI, deliberately import-free of `'use server'`, *"with no chance of drift"* | `system-rows.ts:3-5` |

⚠️ **Read that table again before choosing a design.** Three of the five exist only because a
machine was allowed to move money unattended. The fourth (the period lock) exists to stop it
moving money into a closed month. v1's own defect history is the strongest argument available for
§3's divergence.

### The four verbs

| v1 | Verb | Here |
|---|---|---|
| Template: store, category, amount, interval, next due | **Duplicate** | §2 |
| Six intervals, pure recurrence math, well tested | **Duplicate** | §2 — port the arithmetic and its tests directly; it is correct |
| Office-cash safe default | **Duplicate** | §4. ⭐ Ported **as a rule about which account a template may name**, not as a runtime fallback |
| System rows that must never be confirmed | **Delete — the whole category** | §5. v2's payroll posts its own statutory liabilities (T-189/T-190); there is no reason to also model them as recurring expenses. The correct fix for *"five rows nobody may confirm"* is not to gate them, it is **not to create them** |
| Period-lock guard on auto-pay | **Correct** | §3 — a draft cannot post into a locked period, so the guard moves to where posting happens and stops being this task's problem |
| **Auto-pay on a cron** | ⛔ **Correct** | §3 |

## Goal

A store's fixed bills appear as drafted expenses on the day they are due, pre-filled with
everything the template knows, waiting for one person to confirm what was actually paid. Nothing
is forgotten; nothing moves money unattended.

## Scope — files this task may create or modify

**Create**
- `packages/db/schema/recurring-expenses.ts`
- `packages/db/migrations/XXXX_recurring_expenses.sql` (generated; ⛔ never hand-written, ⛔ never
  hand-applied)
- `packages/domain/src/recurring-expenses/index.ts` + `recurrence.ts`
- `packages/db/src/repo/recurring-expenses.ts`
- `apps/erp/src/app/expenses/recurring/page.tsx`, `actions.ts`, `lib.ts`
- `packages/domain/tests/unit/recurrence.test.ts`
- `packages/domain/tests/integration/recurring-expenses.test.ts`
- `scripts/recurring-expenses.ts`
- `docs/ops/shareat-recurring-expenses.service` + `.timer`

**Modify**
- barrels (`schema/index.ts`, `repo/index.ts`, `domain/src/index.ts`)
- `packages/domain/src/scheduler/index.ts` — add `recurring_expenses` to `JobOutcome['job']`
- `apps/erp/src/components/nav.tsx`, `package.json`, `docs/ops/README.md`, `provision.sh`
- `packages/auth/src/capabilities.ts` — one capability

⛔ **`packages/domain/src/expenses/index.ts` is NOT in scope.** This task calls `createExpense`
unchanged. If drafting through it needs a change, that is a finding to report (RULES §3.4a).

⛔ **`PROJECT_BIBLE.md` is not in scope** (rule 14).

## Contract

### 1. What a template is

A **template**, not a document. It carries no journal entry, no status beyond active/paused, and
no money. It describes *what recurs, where, how often, and roughly how much*.

### 2. `recurring_expenses`

| Column | Notes |
|---|---|
| `id`, `org_id`, `store_id` | as usual |
| `name` | e.g. *"Lipa branch rent"* |
| `category_id` | FK → `expense_categories`, restrict |
| `default_amount` | `numeric(14,2)`, CHECK `> 0`. ⚠️ A **default**, not the amount — a utility bill differs every month, and the drafted expense is editable before posting |
| `default_money_account_id` | FK, **nullable**; §4 constrains it |
| `interval` | enum `weekly`/`bi_weekly`/`monthly`/`quarterly`/`annually` |
| `anchor_day` | `integer`, 1–31 for monthly-family, 0–6 for weekly-family |
| `next_due_date` | `date not null` — the job's only cursor |
| `status` | `active`/`paused` |
| `last_drafted_expense_id`, `last_drafted_at` | provenance, nullable |
| `created_by`, `created_at`, `updated_at` | |

**Constraints:**
- ⭐ CHECK: `anchor_day` in range **for its interval family** — one CHECK, both families. v1
  stores an out-of-range anchor happily and the recurrence math clamps at read time; put the rule
  where it cannot be bypassed.
- ⚠️ **A 31st anchor in February clamps to the month end, it is never refused.** Same rule T-189d
  already settled for the payroll payout date — reuse that decision rather than inventing a second
  one.
- `index (org_id, status, next_due_date)` — the job's query.

### 3. ⛔ The divergence: v2 drafts, v1 pays

**v1 auto-pays.** `confirmRecurringExpenseAction` has a scheduled twin that posts the expense and
moves cash on the due date, guarded by the period lock and the system-row predicate.

**v2 drafts.** The job calls `createExpense` with `status: 'draft'` and stops. A person opens
`/expenses/{id}`, checks the amount against the actual bill, and posts it — through the same
`approveExpense` gate every other expense goes through.

**Why, stated once and properly, because RULES §1.3 says practice wins unless the divergence is
recorded:**

1. ⭐ **v1's own defect history is the argument.** Three of the five hardening rounds in
   `system-rows.ts` and `payment-routing.ts` exist *only* because a machine could move money
   unattended. Auto-pay did not save labour; it moved the labour into writing guards.
2. ⛔ **The amount is usually a guess.** Rent is fixed; electricity, water and supplier retainers
   are not. Auto-paying a `default_amount` posts a number nobody has seen against a bill nobody
   has read, and correcting it later is a void plus a re-post.
3. ⭐ **v2 already has the right primitive and v1 did not.** T-196 shipped the draft expense
   specifically so a document can exist before it may post. Auto-pay was v1's answer to *"there is
   no such thing as a pending expense"* — v2 has one.
4. ⛔ **The receipt gate cannot be satisfied by a machine.** An expense needs its photo; a cron
   has none. v1 works around this for recurring rows; drafting makes the workaround unnecessary.
5. ⭐ **The period lock stops being this task's concern.** A draft posts nothing, so a due date in
   a closed month produces a draft that simply cannot be posted until the period opens — and it
   says so, in the one place that already knows how to say it.

⚠️ **What is genuinely lost, said plainly:** a bill still needs a human before money moves, so a
branch that ignores its drafts still pays late. **This is answered by a finding, not by auto-pay:**
a `recurringExpenseDraftStale` detector over drafts older than N days is the v2 idiom, is derived,
needs no new screen, and nags whoever can act — T-175's rule again. → **Open question 1.**

⭐ **And it is reversible.** If Ian wants true auto-pay later, it is one flag on the template plus
a post step in the job; every guard v1 learned is already documented above. Starting safe and
adding automation is recoverable. Starting automated and discovering a double-payment is not.

### 4. The money account — the safe default, ported as a constraint

v1 resolves an ambiguous cash split to **office cash** at runtime so a scheduled payment never
silently draws the cashier till.

⭐ **v2 makes it structural instead of a fallback.** A template's `default_money_account_id` may
name the cashier till **only if a person deliberately chose it**, and the domain refuses a
template whose default account is a till at creation time unless an explicit
`tillIsDeliberate: true` is passed and recorded. A runtime fallback answers *"what do we do with a
bad value?"*; a constraint answers *"how did a bad value get stored?"* — and only the second one
stops recurring.

⚠️ **Confirm the account-kind check against `money_accounts` at build time**, not from this spec:
`packages/db/schema/money-accounts.ts` is the authority for how a till is identified (T-153's
`1115` float and `instrument`), and this spec deliberately does not restate it.

### 5. ⛔ No system rows. At all.

v1 seeds five payroll rows into `recurringExpenses` and then builds two independent mechanisms to
stop anyone confirming them.

**v2 does not create them.** Payroll posts its own salaries expense and its own statutory
liabilities (T-189, T-190, T-193). A statutory remittance **debits a liability**; it is not an
OPEX expense, and modelling it as a recurring expense is what made v1's rows dangerous.

⭐ Write this into the schema header as a refusal with its reason, so nobody re-adds them later
seeing an empty-looking gap. **The absence is the feature.**

⚠️ **Not covered by that argument:** rent, utilities, internet, subscriptions, equipment leases —
all genuinely recurring, all genuinely expenses, all in scope.

### 6. The job

`runRecurringExpenses`, existing scheduler shape, `scripts/recurring-expenses.ts`,
`npm run recurring-expenses`, a systemd pair in `docs/ops/`, **daily**.

For each active template with `next_due_date <= today`:
1. `createExpense(... status: 'draft')` with the template's category, store, default amount and
   default account, memo naming the template.
2. Stamp `last_drafted_expense_id` / `last_drafted_at`, advance `next_due_date` by the interval.
3. ⛔ **Both in one transaction.** A draft created without the cursor advancing drafts again
   tomorrow, forever.
4. ⛔ **Idempotent, and not merely by the cursor.** Also refuse when a draft already exists for
   that template and due date. ⚠️ Per `reference_postgres_batch_needs_savepoint`, wrap each
   template in a savepoint — one failure must not abort the run's own `scheduler_runs` write.
5. ⭐ **Catch up, never run away.** A template three months overdue drafts **once**, for the
   oldest missed date, and advances one interval. Three drafts on one morning is noise; three
   consecutive daily runs converge honestly. Port v1's *"never pre-create"* restraint in spirit.

One `scheduler_runs` row per run including a no-op; non-zero exit on failure.

⚠️ **The timer needs arming on the droplet by Ian** — `provision.sh` is the only thing that
installs unit files. Say so in the handoff; three jobs have shipped unarmed already.

### 7. Screens

**`/expenses/recurring`** — the templates: name, store, category, interval, default amount, next
due, status, last drafted (linking to the expense). Create, edit, pause, resume, delete-if-never-
drafted. Inline; no detail page.

**`/expenses`** — a drafted-from-template expense is marked as such and links back to its
template. ⭐ Cheap, and it is what makes an unexpected draft explicable rather than alarming.

### 8. Capability

`manage_recurring_expenses`, **store**-scoped, `super_admin`/`admin`/`manager` true, `staff`
false. ⛔ It governs the **template** only. Posting the drafted expense still needs
`approve_expense`, unchanged — the automation must not become a way to pre-authorise spending.

## Invariants

1. The job never posts. It only drafts.
2. A template's cursor advances exactly once per draft created, in the same transaction.
3. A template drafts at most once per run and at most once per due date.
4. An overdue template drafts once, not once per missed period.
5. No system/payroll template exists, ever.
6. A template defaulting to the cashier till is unrepresentable unless deliberately chosen.
7. `anchor_day` out of range for its interval is refused by the database.
8. A drafted expense is indistinguishable from a hand-drafted one to `approveExpense`.

## Tests

**Unit** (`recurrence.test.ts`) — port v1's cases and add its edge: anchor 31 across February, a
leap year, month-end clamping in all three monthly-family intervals, weekly anchors 0–6.

**Integration** (`recurring-expenses.test.ts`):
1. A due template drafts one expense with `status = 'draft'`, and the ledger is untouched.
2. The cursor advances by exactly one interval.
3. Running twice in one day drafts once.
4. A template overdue by three periods drafts once and advances one interval.
5. A paused template drafts nothing.
6. The drafted expense posts through `approveExpense` normally and hits the ledger only then.
7. A template naming a cashier till without the deliberate flag is refused.
8. `anchor_day = 32` is refused by the database.
9. A due date in a **closed period** still drafts; the draft refuses to post until the period
   opens. ⭐ This is §3 reason 5 made executable.
10. The job writes a `scheduler_runs` row on a no-op run.

Plus `npm run recurring-expenses` twice against `shareat_dev`, second run a proven no-op.

**Smoketest on 9008:** create a template due today → run the job → the draft appears on
`/expenses` marked as recurring and linked to its template → edit the amount to the real bill →
post it → the ledger moves → the template shows next month's due date. 0px overflow at 390px.

## Out of scope — with reasons

- **True auto-pay.** §3. One flag and one step away if Ian wants it.
- **Recurring anything but expenses.** v1's payroll rows are refused by §5; recurring *income* has
  no v1 precedent.
- **Attaching a receipt at draft time.** A machine has no receipt.
- **Supplier-invoice matching.** T-130's territory.
- **The stale-draft detector.** → Open question 1.

## Open questions — for Ian

1. **A finding for drafts nobody has posted?** Recommendation: **yes**, as a follow-up —
   `recurringExpenseDraftStale`, soft severity. It is what makes §3's divergence safe rather than
   merely safer.
2. **Confirm the divergence.** v1 auto-pays; this drafts. Recommendation is §3 and the argument is
   v1's own defect history. ⚠️ **Say no and it changes the shape of the job**, not just a flag —
   worth answering before build rather than after.
3. **Which bills are actually recurring today, and at which stores?** Neither the roadmap nor the
   capability register has ever named them. Seeding the real list is a ten-minute conversation
   that decides whether this is five templates or fifty.

## What the template half actually produced

**16 unit tests** on the recurrence arithmetic (`packages/domain/src/recurring-expenses/recurrence.test.ts`)
— v1's cases plus the ones its own tests do not cover: a leap February, **2100 (not a leap year, the
century rule a naive `%4` gets wrong)**, a 31st anchor that clamps in February and then *returns to
the 31st in March* rather than sticking at 28, and the fortnightly case where aligning to the anchor
weekday before stepping would make the template stand still.

⚠️ **Two deliberate changes in the port, both stated in the module header.** v1 parses local
midnight and formats with `toLocaleDateString('en-CA')` — the two cancel out, so v1 is not wrong,
it is *load-bearing on the server's timezone being the one it was written on*, which bible §6 bans
for exactly this class of surprise. And v1 expands a whole date RANGE because its auto-pay runner
scans a window; a cursor-based job only ever needs *"what comes after this one"*.

**16 integration tests**, covering everything that is the same under either answer to Open
question 2: the cursor derivation (**created on the 3rd with a 5th anchor is due THIS month**),
clamping, the till rule in both directions, the database's own refusals (`anchor_day = 32`, a
weekly template anchored on day 15, a zero amount), the staff denial, pause/resume, and the two
edit rules.

⭐ **Two rules that came out of building rather than from the spec:**
- **Resuming a long-paused template moves its cursor FORWARD from today.** Otherwise it wakes with
  a due date months behind and drafts its way forward — noise on the morning somebody switched it
  back on, and the opposite of what *resume* means.
- **An OFFICE account never sets `till_is_deliberate`, whatever the form sent.** Otherwise the flag
  would claim a considered decision about an account nobody had to think about, and the one place
  it means something would stop meaning anything.

**Smoketest on 9008, 390×844 — 10 of 10:** the nav entry; **the banner saying the job is not
built**; a cashier till **refused** without the tick (*"Cashier cash is a CASHIER account — the till
is the daily operating drawer…"*); accepted with it, and called out on the row; the derived first
due date said back on save (*"Template saved. First due 2026-10-05."*); pause; 0px overflow.

## Done when

- [ ] Templates can be created, edited, paused, resumed and deleted-if-unused
- [ ] The daily job drafts due expenses and advances cursors in one transaction
- [ ] Two runs in a day draft once; a three-period-overdue template drafts once
- [ ] A drafted expense posts through the normal gate and only then touches the ledger
- [ ] A cashier-till default is refused unless deliberate; a bad anchor is refused by the database
- [ ] No payroll/system template exists, and the schema header says why
- [ ] Unit tests ported from v1's recurrence cases; ten integration tests green, written first
- [ ] The job run twice against `shareat_dev`, second run a proven no-op
- [ ] Unit files in `docs/ops/` **and the handoff names the arming step as Ian's**
- [ ] Live-smoketested on 9008, 0px overflow at 390px
- [ ] `npm run build` exit 0 with the dev server stopped
