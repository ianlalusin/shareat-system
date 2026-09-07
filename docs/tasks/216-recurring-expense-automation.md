# T-216 — Recurring-expense automation

> **Status**: 🟡 **HALF BUILT 2026-09-06 — the template ships. The JOB is specified but not built:
> see [Part 2](#part-2--the-job-half-spec-written-2026-09-07-lane-d-ianla-0a) at the foot of this
> file, which is the live half of this task.**
>
> ✅ **Open question 2 was answered by Ian on 6–7 Sep: v2 DRAFTS, never auto-pays.** §3 argued that
> v2 should draft where v1 auto-pays, and warned that *"say no and it changes the shape of the job,
> not just a flag."* The answer is yes, so §3 stands in full and the job's shape is settled.
>
> ⚠️ **Everything below this banner is the 2026-09-06 record, kept as written.** Two things in it
> are now known to be wrong and are corrected in Part 2, not here: **§3 reason 4's receipt-gate
> argument** (T-130 relocated that gate onto the invoice) and **the Scope line saying the job
> "calls `createExpense` unchanged"** (it cannot — three NOT NULL columns a cron cannot supply).
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

---

# Part 2 — the JOB half. Spec written 2026-09-07 (lane D, `ianla-0a`).

> **Status**: 🟢 **UNBLOCKED, spec only — no code, no migration file yet.** Open question 2 was
> answered by Ian on 6–7 Sep: **v2 DRAFTS, never auto-pays.** Everything §3 argues stands.
>
> ⛔ **But §3's own mechanism does not survive contact with T-130, and that is what this part fixes.**
> The original spec says the job "calls `createExpense` unchanged" with `status: 'draft'`. It cannot.
> Verified at source, not inferred:
>
> | What the job needs | What the code requires | Where |
> |---|---|---|
> | to create an expense | `supplier_invoice_id` **NOT NULL**, gated twice in code + the `expenses_check_invoice_open_for_recording` trigger | `schema/expenses.ts`, `expenses/create.ts:113-121` |
> | " | `supplier_id` **NOT NULL**, refused unless it equals `invoice.supplierId` | `expenses/create.ts:141-147` |
> | " | `created_by` **NOT NULL** to `persons`; `Actor.personId` is not optional and no system actor exists | `schema/expenses.ts`, `packages/auth` |
> | the draft dated on the due date | `businessDate` is **ignored**, always forced from `supplierInvoices.invoiceDate` | `expenses/create.ts:60-64, 155` |
> | one payment | `payments[]` required, at least one, each with a `method` the template does not carry | `expenses/create.ts:100-102` |
>
> ⭐ `createExpense` is the **only** caller of `expensesRepo.insertExpense` in the tree. There is no
> second path in and no supplier-less door.
>
> ⚠️ **§3 reason 4 is stale and is corrected below.** It argues drafting is safe because *"the
> receipt gate cannot be satisfied by a machine"*. T-130 **relocated** that gate to
> `supplier_invoices.receiptFileId`, checked at verification — and made the invoice mandatory at
> **draft** time, not at post time. The safety argument is now stronger, not weaker, and it is
> restated in §J2.
>
> **Resolution — Option A, decided by the orchestrator on 2026-09-07:** the template names a
> supplier, and the job creates a **pending** supplier invoice and then the draft expense against
> it. `recordInvoice` writes **no journal entry** (verified: no `postEntry` in its body), so the job
> still moves no money and touches no ledger.

## J1. Goal

On the morning a fixed bill is due, its supplier invoice and its draft expense already exist,
pre-filled from the template — so the only thing left for a person is to attach the real bill,
correct the amount, and post it. Nothing is forgotten; nothing moves money unattended.

## J2. The safety argument, restated for Option A

1. **The machine creates the placeholder; the human supplies the evidence.** The invoice is
   `pending` and carries no `receiptFileId`. `approveExpense` still requires `verified`, and
   verification still requires the photo. ⭐ The gate holds exactly where T-130 put it — the job
   cannot reach past it, and it never had to.
2. **Nothing posts.** `recordInvoice` writes no journal entry; a `draft` expense writes none. The
   ledger is untouched until a person presses approve.
3. ⭐ **The job cannot do what its author could not.** It acts **as the template's creator**
   through the ordinary `recordInvoice` / `createExpense` domain functions, with their ordinary
   `authorize` gates — no bypass, no system principal. A creator who has since lost store scope, or
   the capability, produces a loud per-template failure instead of a silent privileged write. This
   is T-216 §8's rule (*"the automation must not become a way to pre-authorise spending"*) enforced
   rather than merely stated.
   ⚠️ Free, not costly: `manage_recurring_expenses` is manager-and-above, and `create_expense` /
   `record_supplier_invoice` are both staff-and-above — anyone who could create a template already
   holds both.
4. **The amount is still a guess, and still gets read by a human.** Unchanged from §3 reason 2.

## J3. Scope — the exact files

**Create**
- `packages/db/schema/recurring-expense-drafts.ts` — the new table (§J5.2)
- `packages/domain/src/recurring-expenses/job.ts` — `runRecurringExpenses`
- `scripts/recurring-expense-draft.ts` — the CLI, `scripts/budget-reissue.ts`'s pattern
- `docs/ops/shareat-recurring-expense-draft.service` + `.timer`
- `packages/db/migrations/0136_t216_recurring_expense_job.sql` — ⛔ **not written until the
  orchestrator says GO**; the DDL is §J5 below

**Modify**
- `packages/db/schema/recurring-expenses.ts` — add `supplier_id`
- `packages/db/schema/scheduler.ts` — `recurring_expenses` into `SCHEDULER_JOBS`, **and repair the
  `scheduler_runs_job_check` list, which omits `budget_reissue`** (DEF-217)
- `packages/db/src/repo/recurring-expenses.ts` — the drafts-table reads and writes
- `packages/db/src/cutover/classification.ts` + `packages/db/src/rls/registry.ts` — ⚠️ **required**:
  the build refuses a new table that is in neither
- `packages/domain/src/scheduler/index.ts` — `recurring_expenses` in `JobOutcome['job']`
- `apps/erp/src/app/expenses/recurring/page.tsx` + `lib.ts` — the banner changes; the supplier
  column and the unset-supplier warning
- `packages/domain/tests/integration/recurring-expenses-job.test.ts` — new file, the job cases
- `package.json` — the `recurring-expense-draft` script line
- `docs/ops/README.md` — the job's row and its arming step
- this document

**Barrel lines are written verbatim in the READY report and applied by the orchestrator**, never
edited here: `packages/db/src/index.ts`, `packages/db/schema/index.ts`,
`packages/domain/src/index.ts`.

## J4. Contract — the job

```ts
export async function runRecurringExpenses(
  options: { orgId?: string; trigger?: 'cron' | 'manual'; nowMs?: number } = {},
): Promise<SweepResult>;   // the same shape runBudgetReissue and runFindingObservation return
```

Daily. `period` is the Manila `YYYY-MM` the run happened **in** — the
`scheduler_runs_period_shape_check` convention every daily job here already uses, never a period
being closed. One `scheduler_runs` row per org per run, **including a run that drafts nothing**;
non-zero exit on failure.

For each org, for each `recurringExpensesRepo.listDue(tx, orgId, manilaToday())` — active,
`next_due_date <= today`, oldest first — **in its own transaction**
(`reference_postgres_batch_needs_savepoint`: one DB error aborts the transaction it happened in,
and a shared one would take the run's own `scheduler_runs` write down with it):

1. **Refuse, loudly, if the template cannot produce a draft.** No `supplier_id`, or no `created_by`,
   gives a `SchedulerFailure` naming the template and the missing field, and the run continues.
   ⚠️ Not `skipped`: a template that can never draft is a configuration fault, and `skipped` is
   where faults go to die quietly.
2. `recordInvoice` as the template's creator: `supplierId`, `storeId`, `invoiceDate` = **the due
   date**, `totalAmount` = `default_amount`, `invoiceNo` = `RECUR-<template id>-<due date>`, and
   `notes` naming the template. Status defaults to `pending`.
3. `createExpense` as the same actor, against that invoice: the template's `categoryId`, one
   payment (§J5.3), and `particulars` reading `"<template name> — drafted by the recurring-expense
   job for <due date>"`. `businessDate` is forced from the invoice, which is the due date, so the
   draft lands on the day it was due.
4. `insertDraftRecord` — the row that makes invariant 2 true.
5. `stampDrafted` — `last_drafted_expense_id`, `last_drafted_at`, and `next_due_date` advanced by
   `nextDueDate(dueDate, interval, anchorDay)`. ⛔ **Same transaction as 2 to 4**, per that repo
   function's own comment: a draft whose cursor did not advance drafts again tomorrow, for ever.
6. ⛔ **Catch up, never run away.** One draft per run per template, for the **oldest** missed date,
   advancing exactly one interval. A template three months overdue converges over three daily runs.
   Ported in spirit from v1's *"never pre-create"*.

## J5. Contract — the DDL (migration 0136, held for GO)

### J5.1 `recurring_expenses.supplier_id` — nullable, and refused at draft time

```sql
ALTER TABLE "recurring_expenses"
  ADD COLUMN "supplier_id" uuid REFERENCES "suppliers"("id") ON DELETE RESTRICT;
CREATE INDEX "recurring_expenses_supplier_idx" ON "recurring_expenses" ("supplier_id");
```

⚠️ **Nullable, deliberately.** Existing templates have no supplier and a `NOT NULL` would refuse
the migration. The rule lives where it can be *reported* instead: the job refuses such a template
per §J4.1, and `/expenses/recurring` shows which ones are unset — the same insist-on-screen shape
T-229 used for the TIN. **A newly created template must name one**, enforced in
`createRecurringTemplate`.

### J5.2 `recurring_expense_drafts` — idempotency as a database FACT

⛔ **Keying idempotency off the invoice number does not hold.** `supplier_invoices.invoice_no` is
documented in its own schema as *"read by the warn-only duplicate check, **never a unique
constraint**"* — verified, there is no unique index on it, so a duplicate `RECUR-...` number would
be created silently.

⚠️ And the period is not the key either: a **weekly** template has four or five due dates inside one
`YYYY-MM`, so a `<YYYY-MM>` key would draft a weekly bill once a month.

```sql
CREATE TABLE "recurring_expense_drafts" (
  "id"                    uuid PRIMARY KEY DEFAULT uuidv7(),
  "org_id"                uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "recurring_expense_id"  uuid NOT NULL REFERENCES "recurring_expenses"("id") ON DELETE CASCADE,
  "due_date"              date NOT NULL,
  "expense_id"            uuid REFERENCES "expenses"("id") ON DELETE SET NULL,
  "supplier_invoice_id"   uuid REFERENCES "supplier_invoices"("id") ON DELETE SET NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "recurring_expense_drafts_once_idx"
  ON "recurring_expense_drafts" ("recurring_expense_id", "due_date");
```

⭐ **The unique index is the invariant**, not the cursor. The cursor already stops the ordinary
second run; this stops the ones the cursor cannot see — two job processes racing, or a cursor moved
backwards by a template edit. `insertDraftRecord` is `ON CONFLICT DO NOTHING`; a zero-row return
means someone else already drafted that date, and the template is skipped without an error. Same
idiom as `budgetsRepo.insertReissued`.

⚠️ **Both document FKs are `ON DELETE SET NULL`** for 0132's reason: this table is reached from a
KEEP table but points at PURGE ones, and a `restrict` would let it block the 1 January purge.

**Cutover class `purge`** — it is provenance *about expenses*, and when the expenses go it has
nothing left to describe. **RLS `org_column`.**

### J5.3 The payment method — derived, no new column

The template already carries everything needed; `default_payment_method` is not required.

| `default_money_account_id` | `instrument` | method | why |
|---|---|---|---|
| null | — | `credit` | The bill exists and is owed; which account settles it is a later, separate act. This is the ordinary shape of a landlord's invoice |
| set | `cash` | `cash` | |
| set | `ewallet` or `bank` | `online`, carrying `moneyAccountId` | `routeExpense` requires the wallet for `online`, and we have it |

⚠️ The human editing the draft can change this before posting; nothing here is final.

### J5.4 `scheduler_runs_job_check` — all nine, and DEF-217 closed

```sql
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
  CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay',
                   'order_wastage_backstop','finding_observation','budget_reissue','recurring_expenses'));
```

⛔ **`budget_reissue` is in the live constraint (0131) but missing from `schema/scheduler.ts`'s own
`check()` list** — nine jobs in `SCHEDULER_JOBS`, eight in the check. Inert today, because
migrations build the database and the schema file does not; dangerous tomorrow, because the next
widening migration is written by copying that list. **DEF-217.** Both are corrected here.

⚠️ Hand-written from the schema, never `db:generate` — its snapshot chain has been dead since 0019
(0133's header). `when` strictly greater than 0135's `1797737507084`.

## J6. Invariants

1. The job never posts. No `postEntry`, no journal entry, no ledger row — asserted by counting
   `journal_entries` before and after.
2. A template drafts **at most once per due date**, enforced by
   `recurring_expense_drafts_once_idx`, not by the cursor alone.
3. The cursor advances exactly once per draft created, in the **same transaction** as the invoice,
   the expense and the drafts row.
4. An overdue template drafts **once**, for the oldest missed date, and advances one interval.
5. A template with no supplier, or no creator, drafts nothing and appears in the run's `failures`
   with the missing field named.
6. The job holds no privilege of its own: every write happens under the template creator's
   `authorize`, store-scoped (§J2.3).
7. A drafted expense is indistinguishable from a hand-drafted one to `approveExpense` — and
   therefore still cannot post until its invoice is `verified`.
8. A due date inside a **locked period still drafts.** ⛔ **This redlines the orchestrator's
   instruction, deliberately.** §3 reason 5 and the original test 9 both say the draft is created
   and simply cannot post; the *"pending record and alert, create nothing"* row in the v1-lessons
   table describes v1's **auto-pay** guard, which §3 retires. Verified in code: there is **no period
   guard on either create path** — a grep for `assertPeriodOpen|periodLock|fiscal_period` across
   `domain/src/expenses` and `domain/src/ap` returns nothing, and the lock lives at `postEntry`.
   Creating a draft in a closed month is therefore both harmless and unrefusable, and a job that
   refused it would leave the bill invisible until someone reopened the month.
9. One `scheduler_runs` row per org per run, including a run that drafts nothing.

## J7. Tests — written first, each failing for its own reason

`packages/domain/tests/integration/recurring-expenses-job.test.ts`, on `shareat_test_t216`.

| # | Case | Fails first because |
|---|---|---|
| 1 | A due template drafts one `pending` invoice and one `draft` expense; the `journal_entries` count is unchanged | `runRecurringExpenses` does not exist |
| 2 | The expense's `business_date` equals the **due date** | the invoice date is what carries it |
| 3 | The cursor advances by exactly one interval | nothing stamps it |
| 4 | Running twice in one day drafts once — and a second run with the cursor **moved back by hand** still drafts once | the unique index does not exist yet |
| 5 | A template overdue by three periods drafts once and advances one interval | catch-up not implemented |
| 6 | A paused template drafts nothing | the job does not filter on status |
| 7 | A template with `supplier_id` null drafts nothing and is reported in `failures`, named | no refusal path |
| 8 | The drafted expense **cannot** be approved while the invoice is `pending`; verify the invoice and it posts, and only then does the ledger move | nothing to approve |
| 9 | A due date in a **closed period** still drafts; the draft refuses to post until the period opens (§J6.8) | nothing to draft |
| 10 | A no-op run still writes one `scheduler_runs` row per org | the job is not registered |
| 11 | Each derivation in §J5.3 produces its method; a null account yields `credit` | no derivation exists |
| 12 | `scheduler_runs` accepts all nine job names and refuses a tenth | the CHECK is not widened |

Plus `npm run recurring-expense-draft` twice against `shareat_dev`, the second run a proven no-op
with the count printed, never a bare "ok".

**Smoketest for the QA lane (`ianla-87`), on 9008 at 390x844:** create a template with a supplier,
due today, then run the job. `/ap` shows a `pending` invoice named `RECUR-...`; `/expenses` shows
the draft; approving it is **refused** while the invoice is pending; verify the invoice with a
photo; post the expense; the ledger moves; `/expenses/recurring` shows next period's due date and
the old "the job does not exist" banner is gone. A template with no supplier shows the warning and
is named in the job's output. 0px overflow at 390px.

## J8. Out of scope

- **True auto-pay.** §3, unchanged.
- **Marking the drafted expense on `/expenses` and linking back to its template** (the original §7's
  second half). `apps/erp/src/app/expenses/**` is not in this lane; the join is available from
  `recurring_expense_drafts` whenever it is picked up.
- **The stale-draft detector** (open question 1) — still a follow-up.
- **Backfilling `supplier_id` on existing templates.** They are refused and reported until a human
  sets one.
- Anything owned by lane B or lane C.

## J9. Done when

- [ ] The job drafts a pending invoice and a draft expense for each due template, in one transaction
- [ ] The cursor advances only on success; two runs in a day draft once; a hand-moved cursor still drafts once
- [ ] A three-period-overdue template drafts once and converges over three runs
- [ ] A supplier-less or creator-less template is refused and named in `failures`
- [ ] The draft cannot post until the invoice is verified; the ledger is untouched until it does
- [ ] A closed period does not stop the draft (§J6.8)
- [ ] `scheduler_runs_job_check` admits all nine; `schema/scheduler.ts`'s list matches (DEF-217)
- [ ] Twelve integration tests green on `shareat_test_t216`, written first and seen to fail
- [ ] `npm run recurring-expense-draft` twice on `shareat_dev`, the second run a proven no-op
- [ ] Unit files in `docs/ops/` **and the handoff names the arming step as Ian's**
- [ ] Smoketested on 9008 by the QA lane, 0px overflow at 390px
- [ ] `npm run build` exit 0 with the dev server stopped (QA lane)
