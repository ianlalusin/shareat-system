# Open decisions — need Ian

Each item has a recommendation. Under auto mode, work proceeds on the **recommended**
option unless Ian says otherwise. Items 0 and 1 are the ones that get expensive to
change later; the rest can ride for a while.

---

## 0. Shareat System vs the Frappe/ERPNext migration ✅ **RESOLVED — ERPNext retired**

**Ian, 2026-08-22:** *"I'm really ready to retire the ERPNext/Frappe migration, because it
basically is maintaining 2 DBs for 1 project with different form — for me it's really 2
separate projects. With Shareat System it's like 1. I know the full front and backend. For ERPNext
I feel lost — though I know the advantage, it is correct and really correct, but I can't
work efficiently when I'm not familiar with it. It's like having the best gun but not
knowing how to aim it."*

**Assessment: this is a sound engineering decision, not a comfort preference.**
Operability by the person who actually maintains the system is a legitimate and
underrated selection criterion. A correct system nobody on the team can operate
confidently is worse in practice than a correct-enough system they know completely —
because in the second one, defects get found and fixed, and in the first they accumulate
behind a wall of unfamiliarity. The two-database, two-shapes situation was also real
cost with no offsetting benefit.

**What is genuinely given up, stated plainly:** ERPNext's correctness is battle-tested
across thousands of businesses and many years. Shareat System's correctness will not be. We buy
that assurance back deliberately — with the ten invariants (§16.1) enforced as database
constraints and CI tests, worked examples computed by hand, and continuous
reconciliation. **That test suite is not optional overhead; it is the thing standing in
for ERPNext's track record.** Skimping on it would forfeit the trade.

**Consequences:** Postgres is settled (item 1). Shareat System is now the single destination, not
a hedge — so it inherits the full weight of being the system of record, and the
cutover plan (§15.3, Phase 8) matters more, not less.

---

## 1. PostgreSQL or MariaDB? ✅ **RESOLVED — PostgreSQL**

MariaDB's one real advantage was sharing an engine with Frappe. With Frappe retired,
that advantage is gone entirely and the technical case governs:
materialised views (MariaDB has none), transactional DDL, row-level security. See
`ADR-001-database-engine.md`.

Reversible before Phase 1 if you re-commit to Frappe.

---

## 2. Is Shareat System allowed to change behaviour, or is it parity-only? ✅ **DECIDED**

**Ian, 2026-08-22:** *"the new repo will mirror how it works today but the data handling
might be different so long as it is durable, scalable and secured."*

Behaviour is **fixed** — mirror v1, a different number is a bug. Data handling is
**free** — Claude's call, subject to durable + scalable + secured. Written up as the
parity contract in bible §1.1. Bugs in §12 are the explicit exception.

Consequence worth stating: this explicitly **rules out porting Firestore's document
shapes**. v1's model was bent to fit a document store; copying it into SQL would import
the pathology without the platform that forced it.

## 3. Port all 149 routes, or trim?

- **Recommended: trim on the way in.** Discovery already identified safe drops:
  `/operation/staff-logs` (dead stub), `/admin/legacy-migration` (~9 files of one-time
  Firebase→self go-live tooling), 4 pure redirect stubs, and the dormant
  `requireOwnerOtApproval` flag. `/admin/configurations/ui-ux-sample` is the largest raw
  page in the app (1,398 LOC) but is an internal design tool — it should not shape v2 scoping.
- A full per-route keep/drop list gets built in Phase 1 and signed off before porting.

## 4. Inventory costing: weighted average or FIFO? — *leaning decided*

- **Recommended: weighted average** — matches the prior plan's recommendation and is
  simpler to reconcile. **This is a business/accounting call, not a technical one.**
  FIFO is materially more work and changes reported margins.

## 5. Single company with many stores, or true multi-company tenancy?

- **Recommended: single company, many stores — but keep an `organizations` table from
  day one.** Costs almost nothing now; retrofitting tenancy later is painful. Note there
  is a second entity in play (SEBN) in the ERPNext work, which may force this.

## 6. Account IDs: keep string codes like `cash__cashier`, or numeric? ✅ **RESOLVED — NUMERIC**

> Settled by T-102: the seeded chart uses four-digit numeric codes (`1110`, `2110`, …) with v1's
> string id carried on `legacy_code` for traceability. 92 accounts, live and in use.

- **Recommended: surrogate PK + `legacy_code` as a UNIQUE column.** Keeps every ETL
  mapping and every existing reference working, without carrying string keys as
  primary keys forever.

## 7. Voiding: status flip, or explicit reversal journal entries? ✅ **DECIDED — reversal**

Now mandated by bible §16.1 invariant 4 (posted entries immutable). v1 already treats
void as terminal with corrections as new records, so this is closer to v1's existing
behaviour than it first appeared — it just needs to be uniform.

- **Rationale: explicit reversal entries.** Proper double-entry, fully auditable,
  and it makes closed periods safe — you never mutate posted history. The prior plan
  flagged that this must be **consistent across all modules**; v1 is not.
- Cost: more rows, and void UI must show the reversal link.

## 8. Historical data: migrate everything, or from a cutoff? ✅ **RESOLVED 2026-08-24 — NEITHER**

> **Bible row 106: no historical data is migrated, ever.** v2 always assumes a zero starting
> point. The books open with one balance-sheet entry of counted, present-day facts; 2026 stays
> entirely in v1 plus Ian's spreadsheet. T-115 (the detail load) is **cancelled**. The text below
> is kept as the reasoning that was superseded.

- **Recommended: full migration of closed periods, then freeze them read-only.**
  Reporting continuity matters in an ERP.
- Known constraint from prior work: some attendance periods (2026-06, 2026-07) are
  **non-rebuildable** after a purge — those migrate as-is or not at all, and the gap
  must be recorded rather than silently produce zeroes.

## 9. Opening INVENTORY at 1 Jan 2027 — zero, or counted value? ⏰ HAS A DEADLINE

**Context, confirmed by Ian 2026-08-24:** *"Inventory is linked to expense, that's where the value
goes by linking it — that is exactly why we need this v2 project, to simplify and correct it."*

v1 has **no inventory asset at all**. Stock is quantity-only; cost hits the P&L when a delivery is
manually linked to an expense document, so COGS is **purchase-basis** and count adjustments have
*"no direct GL effect"* by the blueprint's own words. v2 fixes this with perpetual inventory —
`DR Inventory / CR AP` on receipt, `DR COGS / CR Inventory` on consumption. The accounts are
already reserved: **1310–1340** and **5100–5400**. Design belongs to **Phase 3**, which gets a
research pass first (valuation method, when COGS posts, wastage, inter-store elimination).

**But the cutover cannot wait for Phase 3**, because whatever v2 does, 1 January 2027 needs an
opening inventory figure — or an explicit decision that it is zero.

| Option | |
|---|---|
| **(a) Open at ZERO** | Consistent with how 2026 was actually accounted: every item on the shelf at 31 Dec was **already expensed** under v1's purchase-basis model, so capitalising it now would count it twice unless the offset is handled. Simplest, and matches *"as if starting a new book"* |
| **(b) Open at COUNTED VALUE** ⭐ recommended | The offset goes to **3900 Opening Balance Equity**, which is exactly what 3900 is for — it absorbs opening positions without touching P&L. More correct balance sheet, and it is an explicit, stated change in accounting policy rather than a silent one |

**Why (b), despite (a) being simpler.** Under (a) the first months of 2027 consume stock that cost
nothing, so **January's gross margin is fictional** and then normalises. That distortion lands in
precisely the month everyone will be scrutinising the new system's numbers — the worst possible
moment to have to explain that the margin is not real. A restaurant typically holds one to three
weeks of COGS in stock, so this is not a rounding difference.

### ⏰ What it requires, and by when

**A valued physical count on 31 December 2026** — quantities × unit cost, per store. This is an
**operational commitment with a fixed date**, not a data-migration task: the count cannot be
reconstructed afterwards, because v1 never held a value to reconstruct from.

**It must be on the December calendar now.** Its absence is the kind of thing discovered on
2 January, when it is unfixable.

*(Choosing (a) is entirely legitimate — but it should be a decision, not an accident of nobody
having scheduled a count.)*

## 10. Fixed assets at cutover — DECIDED 2026-08-24, with one open sub-question

**Ian:** *"We'll do it in v2. We can even make an inventory audit on v2 so we enter existing
depreciable assets and book their current value, so v2 is clean again."*

### Settled

**No depreciation cron is built in v1.** v2 takes over on 1 January 2027, leaving only four v1
month-ends (Sep–Dec). Writing a production route and scheduler into a repo we deliberately froze,
for four uses, is poor value against real risk — and v2 should own scheduled depreciation properly
(`6700` and `1590` are already reserved). **July and August 2026 still get run manually** from
Inventory → Assets, as does each remaining month-end.

**Assets come across as a verified list, not as migrated history.** v1 holds 52 asset documents
carrying `accumulatedDepreciation` and `bookValue`, so the figures are available; the *decision* is
that they are re-entered against a physical check rather than trusted wholesale.

### ⚠️ The field that actually decides whether this works: REMAINING USEFUL LIFE

Whichever presentation is chosen below, **v2 cannot depreciate an asset forward without knowing how
much life is left.** A book value alone is a dead number — it tells you what the asset is worth and
nothing about what to charge next month. **This is the migration-critical field, and it is the one
easiest to overlook**, because the value is the figure everyone looks at.

### The open sub-question: what the opening entry looks like

| | |
|---|---|
| **(a) Cost + accumulated depreciation** — `1510` at original cost, `1590` at accumulated | Standard presentation. The data already exists in v1, so it costs **one extra line per asset** and nothing else. Keeps gross PPE visible, which matters for insurance, for disposal gain/loss, and for telling a nearly-new asset from a nearly-written-off one |
| **(b) Net book value only** — `1510` at book value, `1590` at zero ⭐ *Ian's stated preference* | Simpler, and consistent with the balance-forward choice made for AR/AP (row 105). Treats each asset as if bought at cutover for what it is now worth. Loses the gross/accumulated split permanently |

**Both are legitimate.** (a) preserves more for the same effort since v1 already stores both
figures; (b) is simpler and matches the principle Ian already chose elsewhere. **The choice matters
far less than carrying remaining life** — which is why that is called out above and not left inside
this table.

### The operational win Ian identified

A **physical asset verification** at cutover finds assets that are disposed, broken, or simply gone
but still sitting on the books accruing depreciation. That is real value beyond bookkeeping, and it
is exactly the kind of thing a migration is the natural excuse for.

> **Pair it with the inventory count (row 9).** Both are physical December counts across the same
> four stores. **One trip, one team, one exercise** — scheduled together, they cost barely more
> than either alone. Scheduled separately, the second one gets skipped.

## 11. Where the opening equity lands — 3100 Owner's capital, or 3300 Retained earnings?

**Raised 2026-08-24 by T-108's opening-balance fixture.** ADR-005 requires 3900 Opening Balance
Equity to net to exactly zero but does not say what clears it, so the implementer had to choose.

The mechanism is settled and correct: **two entries.** The first posts assets and liabilities with
the balancing figure parked in **3900**; the second clears 3900 into an equity account. That
two-step is what the research found (§7.1: *"the residual moved into Retained Earnings/Owner's
Equity only once verified"*) and it is what makes *"3900 nets to zero"* **provable** rather than
true by definition.

**What is open is only the destination.**

| | |
|---|---|
| **3100 Owner's capital** | Says *"this is money I put into the business."* |
| **3300 Retained earnings** ⭐ | Says *"this is profit the business kept."* |

**Recommended: 3300.** Ian's opening net assets at 1 January 2027 are overwhelmingly **accumulated
profit**, not fresh capital introduced on that date. Sending them to 3100 would overstate
contributed capital and understate accumulated earnings.

**It only matters if the distinction is ever wanted** — *"how much did I put in, versus how much
did the business make?"* If it is, the opening figure can split across both, and Ian is the only
one who knows the actual capital history. If it is not, either account balances the books
identically and this is cosmetic.

**Low urgency:** nothing is blocked, and the fixture currently uses 3100. Changing it is one line.

---

## Already decided (not open) — see bible §13

Postgres + Drizzle · Firebase Auth retained as IdP, roles in Postgres · Firestore
two-lane mirror/inbox replacing the IndexedDB sync engine · clock terminal on the
client SDK · face templates permanently excluded · biometric mirror device-only ·
one `person` spine with server-issued sessions · attendance config added to the hot
set · ports 9008/5435 · attendance is Phase 2.
