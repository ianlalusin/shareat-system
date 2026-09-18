# T-324 — a cash handover is capped per cashier account, plus an overage somebody declared

> ### **Status: SPEC — written 2026-09-18 by `system32-4f` (Opus orchestrator/planner). Reserves T-324.**
>
> **Closes:** `DEF-357` (the work) and `DEF-366` (a one-line fold-in in a file this task already opens).
> **Chosen by Ian, 2026-09-18** over three alternatives (DEF-373, T-320, DEF-372).
>
> ⭐⭐ **THIS SPEC HAS ALREADY BEEN THROUGH ONE ADVERSARIAL PASS AND CHANGED SHAPE BECAUSE OF IT.**
> The first draft put ONE cap on the SUM of the handover. An Opus reviewer showed with numbers that
> the default two-cashier-account store defeats it — one account's over-remittance is masked, centavo
> for centavo, by another's under-remittance — and that **every fixture in `remittance.test.ts` uses a
> single account, so the whole test suite was blind to it.** That is the DEF-109/111/115 shape.
> **Ian ruled: close it properly.** §3 is the result. Do not "simplify" it back to a single cap.

## 1. Why this exists

`createRemittance`'s `lines[].amount` is an unbounded human-entered figure. Every bound that exists
today, each verified in the file:

| Where | What it bounds | Verdict |
|---|---|---|
| `apps/erp/src/app/remittance/page.tsx:317-318` | `step="0.01"`, `min="0"` | browser only, and `min="0"` permits zero |
| `apps/erp/src/app/remittance/actions.ts:71` | `Number(l.amount) > 0` | drops non-positive lines; **no upper bound** |
| `packages/domain/src/remittance/index.ts:127` | `money(l.amount)` | format + `numeric(14,2)` range only |
| `packages/domain/src/money-transfers/index.ts:154-160` | `parseMoneyInput` + `> 0` | positivity only |
| `packages/domain/src/money-accounts/overdraft.ts:45-56` → `money-accounts/draw-verdict.ts:51` | `judgeDraw` | ⛔ **`if (drawn <= available) return OK`** — handing over the **full ledger balance** produces no verdict at all |
| `packages/db/schema/remittance.ts:120` (= `migrations/0030_t143_pooled_remittance.sql:45`) | `CHECK (amount > 0)` | lower bound only |

**Database-level: no upper-bound CHECK and no trigger on `remittances`, `remittance_lines`,
`remittance_allocations`, `remittance_variances` or `money_accounts` — all 134 `.sql` files in
`packages/db/migrations/` grepped.** The answer to *"what caps the handover"* is **none**.

⚠️ **The one signal that exists is thrown away.** `index.ts:185` takes only `transfer.id`, discarding
`CreateMoneyTransferResult.warning`, whose own comment at `money-transfers/index.ts:64-65` reads
*"Show it; never swallow it."* Do not treat `overdraftLimit` as a working bound on this path.

## 2. ⭐⭐ Why the design is not what DEF-357's disposition says

DEF-357 says: *"Do NOT cap at `owed` alone — with nothing verified, `settleable` is empty, `owed` is
zero, and a cap of zero refuses the entire remittance."*

**T-319 (`3601126`, 2026-09-17) made that unreachable.** `index.ts:149-160` refuses when
`settleable.length === 0`, and `settleable` is `reports.filter(r => r.remittable && Number(r.owed) >
0)` (`:136`). `runCreate` (`:85-237`) is straight-line — **no early return, no try/catch, no branch**
— so on every path reaching the transfer loop at `:184`, `settleable.length >= 1` and `totalOwed > 0`.
Sub-centavo drift was checked and is impossible: `journal_lines.debit/credit` are `numeric(14,2)`
(`schema/journal.ts:149-150`). T-319's own spec predicted this at `docs/tasks/319-*.md:59-63`.

### The objection that replaces it — and it is the whole design

**`owed` counts only verified days.** `repo/remittance.ts:99` computes `(sd.status = 'verified') as
remittable`; `index.ts:136` filters on it. The SQL returns a row for an unverified day **with its
full `owed`** — asserted at `remittance.test.ts:219-225` (`owed '10000.00'`, `remittable false`).
`page.tsx:281-287` renders that population on screen: *"N days holding ₱X cannot be remitted yet."*

**So cash from an `open`/`submitted` day is physically in the drawer and outside `settleable`.** A
bare cap would refuse a cashier handing over genuine takings. ⭐ **The declared overage is the release
valve for cash the ledger cannot yet attribute** — and it makes the overage a thing a person states
on purpose, which is the point of the whole task.

⚠️ **One honest limit on that sentence:** when *every* day is unverified, T-319's refusal fires first
(§3 sequences the cap after it) and the declaration is unreachable — the cashier is told to verify.
The valve opens only when at least one verified day still owes something. That is T-319's ruling and
is out of scope here.

A second, independent argument for the allowance: `allocateFifo` deliberately produces a signed
`variance` with the over case attributed to the last touched day (`allocate.ts:80`, `:88`), unit-tested
at `remittance-allocate.test.ts:43-47`. **A cap with no allowance makes the over case unreachable from
`createRemittance` while its unit test stays green** — the exact shape this repo keeps filing.

## 3. ⭐⭐ Contract — the cap is PER CASHIER ACCOUNT, and here is why

### 3.1 The hole a single pooled cap leaves open

`FOUNDATION_ACCOUNTS` (`schema/money-accounts.ts:83-88`) gives **every store two cashier accounts** —
`Cashier cash` (GL `1110`) and `Cashier online` (GL `1140`). `page.tsx:310-343` renders one amount
input per account; `index.ts:127` sums them into one `handedOver`. But `owed` is **pooled per DATE**:
`repo/remittance.ts:63-84` sums every `11xx` line whose `coalesce(ma.custodian, ca.custodian) =
'cashier'` into one `movement` figure per date.

**One pooled number against one pooled number. The worked case:**

> Store with Till (cash) and GCash (cashier e-wallet).
> `2026-01-02` **verified**: Till +₱5,000 cash sales, GCash +₱5,000 online → `owed = 10,000`.
> `2026-01-03` **open**: Till +₱20,000 cash. Till balance ₱25,000, GCash ₱5,000.
> Entered: **Till `10000.00`, GCash blank** (blank is dropped by `actions.ts:71`).
> `handedOver = 10,000`. A pooled cap: `10,000 > 10,000 + 0` is **false → ACCEPTED, nothing declared.**
> `judgeDraw`: `10,000 <= 25,000` → OK, no warning. `allocateFifo`: variance `0.00` → **no variance row.**
>
> **What happened: ₱5,000 of unverified-day cash left the till undeclared, and GCash's ₱5,000
> obligation is recorded as settled although nothing left GCash. The books look clean.**

That is DEF-357's exact shape surviving the fix, in the default configuration, with no float involved.
Nothing else catches it: `CASH_CUSTODY_KINDS` (`remittance/lib.ts:77-81`) has no per-account drift
finding, and `remittance_allocations` is keyed by DATE only (`schema/remittance.ts:140`).

⭐ **The code's own comment already argues for the per-account cap.** `actions.ts:63`: *"the till and
the wallet remit separately, because they are different places reconciling against different things."*

### 3.2 The two checks

Both fire **after** T-319's refusals (`index.ts:149-160`) and **before** `insertRemittance` (`:170`)
and the transfer loop (`:184`) — so **nothing is written when either fires.**

**Check 1 — per line, the one that closes §3.1.**
For each line: `line.amount ≤ movement(line.fromMoneyAccountId, settleableDates) + line.declaredOverage`

**Check 2 — pooled, retained.**
`handedOver ≤ totalOwed + Σ line.declaredOverage`

⭐ **`fromMoneyAccountId` is already on every line** (`actions.ts:66`), so check 1 needs no new
plumbing to know which account it is bounding.

### 3.3 ⛔ Why check 1 uses MOVEMENT and not OWED — a deliberate, recorded asymmetry

`owed = movement − allocated`, and `remittance_allocations` **has no account dimension**, so prior
allocations cannot be split per account. Giving them one is a schema change to the allocation key and
is **out of scope**.

So check 1 bounds against **movement over the settleable dates**, which is `≥` that account's true
owed. **The bound is therefore LOOSER than truth, never tighter.** That is the safe direction: it
cannot refuse a legitimate handover, and check 2 still bounds the total exactly. ⛔ **State this in
the code comment.** A later reader who "tightens" check 1 to `owed` without giving allocations an
account dimension will start refusing correct remittances.

### 3.4 The new read — `cashierMovementByAccount`

A new function in `packages/db/src/repo/remittance.ts`, returning movement per cashier money account
restricted to the settleable dates. It reuses the `cashier_movement` CTE's own resolution
(`repo/remittance.ts:63-84`), which already has both halves:

- `jl.party_type = 'money_account'` → the account is **`ma.id`** (this is how `1140` wallet lines name themselves; `sales-days/routing.ts:265,284` posts one per wallet).
- otherwise → the account is the store's cashier money account whose **`gl_account_code = a.code`** (how `1110` lines resolve, via the `ca` values list).

⛔ **If that fallback matches more than one active cashier account for the store, the movement cannot
be attributed and the function must REFUSE, naming the accounts.** Do not pick one. Do not sum them.
A store with two tills on one GL code is a configuration this cap cannot police, and saying so is the
correct behaviour. *(Not reachable on today's data — `FOUNDATION_ACCOUNTS` gives one per code — which
is exactly why it must be written now rather than discovered later.)*

### 3.5 The declared overage

- **Per line, not per remittance.** It qualifies the amount it sits beside. A header field cannot
  close §3.1 — that is what the first draft got wrong.
- `RemittanceLineInput` gains `declaredOverage?: string`.
- Parse with **`parseMoneyInput`** (`packages/domain/src/shared/money-input.ts:19-26`), **not**
  `money()`. ⚠️ Trap 8: `index.ts:127` uses `money()` and yields a raw `TypeError: Invalid money
  string:` instead of a cashier-readable sentence. **Do not copy that precedent into new code.**
- Compare in **integer centavos**: `compare(a, b)` from `packages/core/src/money.ts:146` and `add`
  from `:78`. ⛔ **Never `Number(...)` for the comparison** — `docs/RULES.md` §1 rule 6, and §7 has a
  case that turns on one centavo. The existing `Number(...)` at `index.ts:136` and `:214` is
  precedent, not licence.
- Absent/empty ⇒ zero for the comparison, stored as **NULL**. `packages/core/src/money.ts:15-16`:
  *"a rate or amount of ZERO is a legitimate value, not 'unset'."* NULL = never asked (every row
  before `0154`); `0` = *"I declare no overage."*
- **Negative is refused.**
- ⛔ **Nothing bounds the declaration's size, and that is intended.** It converts a silent sweep into
  a deliberate act, and the resulting positive variance lands in `remittance_variances` for the
  office. It is a speed bump, not an approval gate. **Say so in the commit message** — DEF-357's
  disposition says *"explicitly recorded"*, and §6 is what makes "recorded" mean *read*.

### 3.6 ⛔ `allocateFifo` does not change

`packages/domain/src/remittance/allocate.ts` is untouched. This task decides whether the over case is
*reached*, never what it does.

### 3.7 DEF-366, folded in — and it ships UNTESTED, deliberately

`actions.ts:95` branches on `result.variance` to decide whether to promise *"recorded as an open
item"*; the field that says a row exists is `result.varianceId`, set at `index.ts:224` only when a row
was inserted (guard `:214`). **Change `result.variance` to `result.varianceId`. One line. No test.**

⭐ **Why no test, stated rather than glossed (bible §9):** the failing state is **unreachable**, and
this was checked three ways, not assumed. `allocate.ts:88` sets `varianceDayId = Number(variance) ===
0 ? null : (lastTouched ?? days.at(-1)?.salesDayId ?? null)`; with `variance !== 0` the chain ends at
`days.at(-1)?.salesDayId`, which is `r.businessDate` (`index.ts:163`) — **a date string, always
truthy** — and T-319 guarantees `days.length >= 1`. So `varianceId` is non-null whenever `variance`
is. A test would have to fabricate a state the app cannot reach, and DEF-366's own disposition forbids
the extraction that would make it reachable.

⛔ **Rest that justification on the DOMAIN refusal only.** An earlier draft credited
`page.tsx:295`; that is a client-side gate, and resting a skipped test on one contradicts
`docs/RULES.md` §1 rule 7. **The comment the builder leaves at `actions.ts:95` must say
domain-refusal, not form-gate.**

⛔ **Do NOT "fix" it by making `createRemittance` return a non-null `varianceId` where no row exists.**

## 4. The layer — and why not a trigger

`PROJECT_BIBLE.md:1624-1627` (§15.11) and `docs/RULES.md:111-118`: the *database-enforces-it* rule is
scoped to **CHECK constraints and triggers for balance, period and immutability**; §15.11 binds both
ways — **no layer may be the only one for a given risk.**

| Layer | What it carries |
|---|---|
| **Domain — `createRemittance`, primary** | both checks. They compare human figures against values derived from `journal_lines` + `remittance_allocations` across tables; a trigger doing that **re-implements the ledger inside a trigger.** `createRemittance` has exactly **one** production caller (`actions.ts:78`, grepped repo-wide) — one entry point, unlike tenancy |
| **Database — migration `0154`, second layer** | the *shape* of the declaration: `declared_overage >= 0`. It cannot express the cap |
| **Form — `page.tsx`, third** | the input and the words. ⛔ **Never alone** — `docs/RULES.md` §1 rule 7 |

### ⚠️ The residual risk, stated rather than hidden

`transaction()` is `getDb().transaction(fn)` (`packages/db/src/client.ts:83-85`) with **no isolation
level set — Postgres default READ COMMITTED.** `endDayReports` is a plain read and nothing locks the
store, the date or `remittance_allocations`. **Two concurrent remittances of ₱6,000 against one
₱10,000 day both read `owed = 10,000`, both pass, and ₱12,000 settles against ₱10,000 owed.**
`remittance_allocations_unique` is on `(remittanceId, businessDate)` (`schema/remittance.ts:150`), so
different remittances do not collide.

⭐ **Accepted for this task, not fixed:** one store, one closing, one person — contention is not the
real-world shape, and a `SELECT … FOR UPDATE` on the store row is a separate change with its own
deadlock surface. ⛔ **But it must be written down**, or the cap gets believed to be stronger than it
is. **File it as a defect row** (§9 item 8) rather than leaving it in this spec only.

## 5. Data

**No existing field carries this meaning.** `remittances` columns (`schema/remittance.ts:56-80`):
`id, org_id, store_id, remitted_on, reference, notes, accepted_by, status, reversed_on,
reverse_reason, created_by, created_at`. `notes` (`:67`) is free text.
`remittance_variances.amount` (`:188`) is the *outcome*, written after the fact, and
`remittance_variances_remittance_unique` (`:203`) permits exactly **one** variance row per
remittance — a design writing a second "declared" row fails at the database.

### ⛔ The alternative that must be named, because T-316 designed around it

**`sales_days.cash_collected`** — `numeric(14,2) NOT NULL DEFAULT '0'` (`schema/sales-days.ts:231`) —
is a cashier-entered figure for cash in the drawer on `open` and `submitted` days, i.e. *exactly* the
population §2 says the overage exists for. **T-316 §3.4 (`docs/tasks/316-*.md:261-270`) is an entire
design built on reading it.**

**It is rejected here, and the reason is the point:** `cash_collected` says how much cash the day
took. It does **not** say *"I am knowingly handing over more than this settles."* The two are
different statements, and only the second is a declaration. ⚠️ It is also `'0'` in every existing
fixture (`verifiedDay()`, `remittance.test.ts:169-178`) and was `0.00` on one of the two verified days
in the dev database when this spec was written — so a design reading it would silently degrade to no
allowance at all. **Named so the builder and the auditor do not have to re-derive it.**

### The column

- Table **`remittance_lines`**, column **`declared_overage`**, **`numeric(14, 2)`**, **nullable**.
  Money is `numeric` in the DB and integer centavos in code — **never a float**.
- `CHECK (declared_overage IS NULL OR declared_overage >= 0)`, mirroring
  `remittance_lines_amount_positive_check`.
- Migration **`0154`**, hand-authored per **ADR-012 §5**
  (`docs/decisions/ADR-012-hand-authored-migrations.md:128`) — `npm run db:generate` is retired and
  fails closed. Schema file edited in the same slice.
  ⛔ **The journal `when` is DERIVED AT BUILD TIME** from `meta/_journal.json`:
  `previous.when + 86_400_000 × (idx − previous.idx)` — the formula is at
  **`packages/db/migrations/README.md:43`**. ⛔ **Never copy a `when` out of a document, including
  this one.**
  ⛔ **`0152` and `0153` are APPLIED — never edit either.** `0149`/`0150`/`0151` are absent from disk
  **and** from the journal, which jumps idx 148 → 152 (`0151` was reserved by T-316 §4 and never
  written). **Do not reuse the gap.**
- `InsertRemittanceLine` / `InsertRemittanceInput` (`packages/db/src/repo/remittance.ts:124-132`,
  `insertLine` at `:142-153`) carry the field through.

## 6. Screen — and the wiring that a lane will otherwise miss

⛔⛔ **THE SINGLE MOST LIKELY WAY THIS TASK SHIPS BROKEN:** a form field that posts nothing, a domain
parameter nobody passes, and a cap that is always `+ 0` on the only screen — **while every integration
test passes, because they call the domain directly.** Name the wiring explicitly:

1. **`page.tsx`** — a second input inside the existing per-account row at `:310-343`, named
   **`lineOverage_${i}`**, beside `lineAmount_${i}` (`:314-322`). Same `step="0.01"`, `min="0"`.
2. **`actions.ts:64-71`** — the `.map((id, i) => ({...}))` gains
   `declaredOverage: str(formData, \`lineOverage_${i}\`) || null`. ⚠️ The `.filter()` at `:71` keys on
   `l.amount`; an overage on a line with no amount must not resurrect that line.
3. **`actions.ts:78-84`** — nothing to add at the call itself; `lines` already carries it.
4. **`actions.ts:89-97`** — the summary gains the declared total when non-zero. ⭐ **This is what
   gives NULL-vs-0 a reader** (§3.5): today the column would be written and never read back —
   `listRemittances` feeds `page.tsx:374-400`, which renders Date / Reference / State and not even
   the amount. A tri-state nothing reads is a bug waiting for whoever writes the first reader.
5. ⛔ **`page.tsx:299-303` must be REWRITTEN.** It describes **only the short case**, so the over case
   has no words on screen at all. This is bible row 214's mirror in its purest form — a line nobody
   touched, made false by a change made elsewhere.
6. The hint at `page.tsx:313` renders the account's **full ledger balance** (`Holds ${peso(a.balance)}`)
   — the very number the cashier is invited to type. It stays; the new words must make clear that
   **holding is not owing.**

## 7. Tests

### 7.1 ⛔ The row-count assertion — read this before writing a line

T-319's helper `nothingWrittenFor` (`remittance.test.ts:760-769`) asserts
`count(*) from money_transfers where store_id = …` equals `'0'`. ⛔ **That shape is IMPOSSIBLE on the
`float-remit` fixture**: `remittance.test.ts:567-576` creates a `money_transfers` row *before* any
remittance is attempted (`money-transfers/index.ts:208`, `:234` write `storeId: from.storeId`). A
correct implementation leaves **1**, not 0.

⛔⛔ **AND IT IS SEVEN TABLES, NOT FOUR — AN EARLIER DRAFT OF THIS SPEC UNDERCOUNTED, AND THE TWO IT
MISSED ARE THE ONES A MONEY INVARIANT ACTUALLY TURNS ON.** A successful `createRemittance` writes:

| # | Table | Written by |
|---|---|---|
| 1 | `remittances` | `insertRemittance` (`index.ts:170`) |
| 2 | `remittance_lines` | `insertLine` (`index.ts:194`) |
| 3 | `remittance_allocations` | the allocation loop |
| 4 | `remittance_variances` | *conditional* — guard at `index.ts:214` |
| 5 | `money_transfers` | `createMoneyTransfer` → `insertMoneyTransfer` (`money-transfers/index.ts:266`) |
| 6 | **`journal_entries`** | ⭐ `postEntry` (`money-transfers/index.ts:255`) |
| 7 | **`journal_lines`** | ⭐ same `postEntry` |

⭐ **6 and 7 are the point.** A refusal that left a posted journal entry behind would pass a
check that watched only the remittance tables, and the ledger is the thing this task exists to
protect. `money_transfers.journal_entry_id` (`money-transfers/index.ts:277`) is the link to follow.
*(Found by the T-324 tester, reading the call path rather than trusting the spec's count. This is
what a lane raising a QUESTION before writing code is for.)*

⭐ **So assert a DELTA, not a count**: snapshot all seven before the attempt, assert unchanged
after. Two further facts the helper hides:
- `nothingWrittenFor` is a closure **inside** the `describe` at `:758-882`. The new cases belong to
  the float-remit `describe` at `:517-634`. **It is not in scope there** — hoist or write a local one.
- **`remittance_variances` has no `store_id`** (`schema/remittance.ts:174-199`). "For that store"
  requires a join through `remittances`.

*(This paragraph exists because the first draft of this spec got it wrong and pre-committed the tester
to "if it fails naming X, the test is wrong." A tester who saw `{transfers: '1'}` would have relaxed
the assertion and shipped the nothing-is-written guarantee unproven.)*

### 7.2 The red that proves DEF-357 — run before a line of source exists

**File:** `packages/domain/tests/integration/remittance.test.ts`, fixture `fixture('float-remit')`,
beside the existing test at **`:562-600`**. `:566` puts ₱8,000 of takings in the till; `:567-576`
transfers ₱20,000 in; `:583` enters `amount: '8000.00'` while the drawer holds ₱28,000; `:594` asserts
the balance is still ₱20,000. **It passes on the coincidence of its own fixture**, exactly as DEF-357
says.

**The new case:** same fixture, **`amount: '28000.00'`, no overage declared** → **REJECTED**, with the
seven-table delta unchanged and the till still ₱28,000.

⭐ **The right reason it must fail today: the call RESOLVES instead of rejecting** — Vitest reports
*"promise resolved instead of rejecting"* against `.rejects.toThrow(/createRemittance:/)`. Today
`owed` is ₱8,000, `allocateFifo` allocates 8,000, returns `variance '20000.00'`, writes a variance
row, and **the drawer goes to ₱0.00.**

⛔ **If it fails naming `money_accounts_overdraft_limit`, `"would go to −"`, or `"is a till float"`,
the TEST is wrong, not the code:**
- `money-accounts/draw-verdict.ts:51` returns OK because `drawn (28,000) <= available (28,000)`.
- `index.ts:119`'s float refusal **cannot** fire, and for a stronger reason than "the fixture doesn't
  call `setTillFloat`": `money_accounts_float_target_shape_check`
  (`schema/money-accounts.ts:216-217`) requires `gl_account_code = '1115'` for a non-null
  `float_target`, and `f.till` is the foundation cashier-cash account on **`'1110'`**
  (`money-accounts/index.ts:56-59`). `float_target` **cannot** be non-null on it. **That is the
  checkable version — use it.**

**The full balance walks out with no warning and no refusal. That silence is the defect.**

### 7.3 ⛔ The red that proves §3.1 — the masking case, and it needs a NEW fixture

**Every existing fixture uses a single cashier account** (`remittance.test.ts:91-99` selects one), so
the whole suite is blind to §3.1. **A new fixture with two cashier accounts is mandatory** — without
it this task ships green and the hole it was widened to close stays open.

The case, from §3.1: verified day with Till +₱5,000 and a cashier-wallet +₱5,000 (`owed = 10,000`);
a later **unverified** day with Till +₱20,000. Enter **Till `10000.00`, wallet blank**.
- **Today, and under a pooled cap: ACCEPTED** — variance `0.00`, no variance row, ₱5,000 of
  unverified cash gone.
- **Under check 1: REFUSED** — the till's own movement over the settleable dates is ₱5,000, and
  ₱10,000 > ₱5,000 + ₱0.
- **With `declaredOverage: '5000.00'` on that line: ACCEPTED**, and the declaration is stored.

⚠️ The wallet leg needs `party_type = 'money_account'` with `party_id` = the wallet account
(`sales-days/routing.ts:265,284` is the shape to copy), or it will not resolve per-account.

### 7.4 The companion cases

- **Allowance works:** `float-remit`, `amount: '28000.00'` **with** `declaredOverage: '20000.00'` —
  accepted, one variance row, positive variance, drawer ₱0.00.
- **One centavo short:** `declaredOverage` one centavo under the excess — refused. ⭐ This is the case
  that fails if anyone compares with `Number(...)` instead of `compare()`.
- **Negative declaration:** `'-1.00'` — refused.
- ⛔ **Overage on a zero-amount line** does not resurrect the line (§6 item 2) — **SLICE B, NOT HERE.**
  This is a property of the form filter at `actions.ts:71`, which builds `lines[]` before the domain
  ever sees them. `createRemittance` takes `lines[]` directly and does no such filtering, and a
  zero amount is already refused downstream by `parseMoneyInput` + `> 0`
  (`money-transfers/index.ts:154-160`) regardless of any declared overage. **There is nothing to
  resurrect at the domain level, so a domain test for it would be a no-op asserting nothing.** It
  belongs with the screen. *(Raised by the T-324 tester, correctly, before writing it.)*
- **Ambiguous configuration:** two active cashier accounts sharing one `gl_account_code` → the read
  refuses and names them (§3.4).
- **The existing `:562-600` case stays green UNMODIFIED.** ⛔ If making it pass requires editing it,
  that is **BLOCKED**, not a fix.
- ⛔ **`remittance-allocate.test.ts` must need no edit.** If it does, `allocateFifo` changed (§3.6).

## 8. Out of scope

- `allocateFifo` / `allocate.ts`.
- An account dimension on `remittance_allocations` (§3.3).
- The `SELECT … FOR UPDATE` concurrency fix (§4) — **filed, not built.**
- The swallowed overdraft warning at `index.ts:185`.
- `index.ts:127`'s `money()` over `parseMoneyInput()` (DEF-272/277 family) — **new code uses
  `parseMoneyInput`; the existing line is not touched.**
- The 34 repo-wide `bible §6.3` citations, two of them in files this task opens.
- `docs/GLOSSARY.md` — it has **no entry** for `owed`, `remittable`, `settleable`, `variance`,
  `float` or `overdraft`, all six verified absent. **Report it; do not write it here.**
- `PROJECT_BIBLE.md` — ⛔ a spec listing the bible in its scope is a defect in the spec
  (`docs/RULES.md` §1 rule 14).

## 9. Done when

Everything in bible §9, and specifically:

1. §7.2 **and** §7.3 fail for the reasons named, **before** any source exists, with real output quoted.
2. They pass afterwards; `remittance.test.ts:562-600` green **without having been edited**.
3. `npm run typecheck` clean · unit green · integration green **on the lane DB** · `npm run build`
   with 9008 free.
4. `callers.mjs`: every new export reached from non-test source.
5. **Smoketested at `http://localhost:9008/remittance`** — the per-account overage field rendered, an
   over-cap handover **refused on screen with the numbers in the message**, and the same handover
   accepted once the overage is declared. ⛔ §9.4 is unmet if the screen was not driven.
6. `DEF-357` and `DEF-366` marked; `docs/ROADMAP.html` given its row.
7. The DEF-366 skip (§3.7) and the unbounded declaration (§3.5) restated in the commit message.
8. **Two new defect rows filed:** the READ COMMITTED concurrency gap (§4) and the missing glossary
   entries (§8).

## 10. Traps — every one verified in the file today

1. ⛔ **DEF-366's own citation is stale** — it cites `index.ts:176-186`; T-319 moved the variance
   write to **`:213-225`**, guard **`:214`**. Its `actions.ts:89-97` citation is correct.
2. ⛔ **Stale citations, correctly attributed** *(an earlier draft of this spec got this wrong and
   sent a reader to the wrong document — row 208 is about exactly that)*:
   **T-316** cites `index.ts:143` → now **`:180`**. Its `index.ts:105-107` still lands in the float
   block and survives. **T-319's own spec** cites `index.ts:178` → **`:214`** (at `319-*.md:33`,
   `:96`) and `index.ts:146-166` → **`:184-201`** (at `:83`). T-316 never cited either.
3. ⛔ **`bible §6.3` does not exist** — cited at `index.ts:366` and `actions.ts:31`, both files this
   task opens. `docs/RULES.md:118`: it means **§15.11**.
4. ⚠️ **`remittable` means the opposite of what it looks like** — not *"may be remitted"* but
   `sd.status = 'verified'` on that date (`repo/remittance.ts:99`). **A non-`remittable` day can hold
   real cash.** This is the whole of §2.
5. ⚠️ **`variance` is SIGNED**: negative = short, **positive = OVER** (`allocate.ts:36-40`;
   `schema/remittance.ts:186-188`; rendered `page.tsx:154`). `varianceDayId` says **where**, never
   **who**.
6. ⚠️ **`overdraft.ts` and `draw-verdict.ts` live under `packages/domain/src/money-accounts/`** — not
   `money-transfers/`, where an earlier draft of this spec put them.
7. ⚠️ **`verifiedDay()`** (`remittance.test.ts:169-178`) inserts `total_sales '0'` and leaves
   `cash_collected` at its default `'0'` (`schema/sales-days.ts:231`). **Any design reading
   `cash_collected` reads zero in every existing fixture.**
8. ⚠️ **`money()` throws a raw `TypeError: Invalid money string:`** (`core/money.ts:47-48`) — not a
   cashier-readable sentence. Use `parseMoneyInput`.
9. ⚠️ **`remittance_variances_remittance_unique`** — one variance row per remittance, forever.
10. ⚠️ **The comment at `remittance.test.ts:591-593`** claims the test *"guards the property that makes
    that safe either way."* It guards that a **correct** amount does not sweep the float; it does not
    guard that an **incorrect** one cannot. **That sentence is why DEF-357 survived.** The tester
    corrects it when the new case lands beside it.
