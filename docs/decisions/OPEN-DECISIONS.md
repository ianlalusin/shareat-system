# Open decisions — need Ian

Each item has a recommendation. Under auto mode, work proceeds on the **recommended**
option unless Ian says otherwise. Items 0 and 1 are the ones that get expensive to
change later; the rest can ride for a while.

---

## 0. ERPv2 vs the Frappe/ERPNext migration ✅ **RESOLVED — ERPNext retired**

**Ian, 2026-08-22:** *"I'm really ready to retire the ERPNext/Frappe migration, because it
basically is maintaining 2 DBs for 1 project with different form — for me it's really 2
separate projects. With ERPv2 it's like 1. I know the full front and backend. For ERPNext
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
across thousands of businesses and many years. ERPv2's correctness will not be. We buy
that assurance back deliberately — with the ten invariants (§16.1) enforced as database
constraints and CI tests, worked examples computed by hand, and continuous
reconciliation. **That test suite is not optional overhead; it is the thing standing in
for ERPNext's track record.** Skimping on it would forfeit the trade.

**Consequences:** Postgres is settled (item 1). ERPv2 is now the single destination, not
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

## 2. Is ERPv2 allowed to change behaviour, or is it parity-only? ✅ **DECIDED**

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

## 6. Account IDs: keep string codes like `cash__cashier`, or numeric?

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

## 8. Historical data: migrate everything, or from a cutoff?

- **Recommended: full migration of closed periods, then freeze them read-only.**
  Reporting continuity matters in an ERP.
- Known constraint from prior work: some attendance periods (2026-06, 2026-07) are
  **non-rebuildable** after a purge — those migrate as-is or not at all, and the gap
  must be recorded rather than silently produce zeroes.

---

## Already decided (not open) — see bible §13

Postgres + Drizzle · Firebase Auth retained as IdP, roles in Postgres · Firestore
two-lane mirror/inbox replacing the IndexedDB sync engine · clock terminal on the
client SDK · face templates permanently excluded · biometric mirror device-only ·
one `person` spine with server-issued sessions · attendance config added to the hot
set · ports 9008/5435 · attendance is Phase 2.
