# T-170 — Supplier returns: the goods go back, and we hold a credit

> **Status:** SPEC, 2026-08-29. ⭐ **RESPECIFIED the same day** — Ian answered the open question
> this spec was built to raise, and the answer changed the posting (§2).
> **Depends on:** T-161, T-162, T-163, T-166 (deliveries), T-130 (AP — ⚠️ and this task **extends**
> its allocation, §5).
> **Decided:** bible **row 166**. **v1 read at source** — `supplier-return.actions.ts`,
> `INVENTORY_GAPS.md:120-135`. `docs/discovery/14` §G.
> **Sibling:** T-179 is the same shape pointing the other way — a customer returning to us.

## 1. Goal

*"We returned N units of X to supplier Y on date Z"* is a document with a stock effect, a
financial effect, and — the part v1 has no concept of — **a credit we can spend on the next
purchase**.

## 2. ⭐ Ian's answer, which is the specification

> *"Supplier returns must be recognized as store credit for us that we can use for next purchase —
> that's for external suppliers."*

**The question this spec previously raised is closed.** v1's return is deliberately
stock-and-audit-trail only, with an operator-checked `apAlreadyHandled` box as a nudge; v1 called it
*"a documentation gap, not data corruption."*

⛔ **Under perpetual inventory that compromise is not available.** Stock moves and the books do not,
which pushes `1310` away from the layer valuation and trips Phase 3's exit gate on the first return.

⭐ **And Ian's framing is stronger than "post the AP side," which is what I had recommended.** A
debit note buried inside an AP balance is invisible; **a credit is a thing you can see and spend.**
The difference matters operationally — *"can we use the credit on this week's order?"* is a question
somebody asks, and it needs an answer with a number.

## 3. The posting — two cases, and the system already knows which

The case is **derived from a fact** — does the receipt being returned against have a linked supplier
invoice? — never chosen by the user.

### 3a. Returning against an **uninvoiced** receipt — no credit arises

| Account | Dr | Cr |
|---|---:|---:|
| `2120` Goods received not invoiced | 3,100.00 | |
| `1310`/`1320`/`1330` Inventory | | 3,100.00 |

⭐ **Nothing is owed yet, so nothing can be credited.** We received goods, we sent some back, and the
supplier will simply bill us for less. This is T-163's receipt posting run backwards, and it is the
common case for a same-day rejection at the loading dock.

### 3b. Returning against an **invoiced** receipt — a real credit

| Account | Dr | Cr |
|---|---:|---:|
| `1240` Advances to suppliers *(party: supplier)* | 3,100.00 | |
| `1310`/`1320`/`1330` Inventory | | 3,100.00 |

⭐ **`1240` already exists** — a party-required control account whose seed comment names
`supplier_advance__{supplierId}` (`chart-of-accounts.ts:141`). **The credit is a per-supplier balance
on the balance sheet**, which is exactly what Ian described.

⛔ **Not a negative `2110`.** Netting the credit into AP would put a debit balance in a liability
control account, misstate the balance sheet, and hide the credit inside a number people read as
*"what we owe."* ⚠️ It would also break the reading of invariant 6's AP arm at the one moment it
matters.

### 3c. Spending it — the part that makes it a credit rather than a note

| | Account | Dr | Cr |
|---|---|---:|---:|
| **Against the next invoice** | `2110` AP *(party)* | 3,100.00 | |
| | `1240` Advances to suppliers *(party)* | | 3,100.00 |
| **Or refunded in cash** | `1110`/`1130` Cash | 3,100.00 | |
| | `1240` Advances to suppliers *(party)* | | 3,100.00 |

## 4. What v1 gets right and is kept

| Capability | Keep |
|---|---|
| Return quantity capped at **received − already returned** per line | ✅ |
| ⭐ **Negative-stock guard with NO override** | ✅ Stricter than the delivery over-receipt guard, deliberately: *"returns are rare; stricter than #5."* **Even an admin cannot return more than is on hand** |
| Traceable document with its own void path | ✅ |
| ⛔ `apAlreadyHandled` self-declaration flag | **Not ported.** A checkbox that declares an accounting fact is DEF-075's shape; once the posting is real there is nothing left for it to declare |
| ⭐ **Shipped server-side with zero UI for seven weeks** | ⚠️ A **process lesson**, not a capability — *"returned goods silently stayed on the books because no user could record one."* §9 is written against it |

## 5. ⚠️ Scope note: this task extends T-130, and says so rather than assuming

**A credit nobody can spend is not a credit.** T-130's payment allocation currently draws from cash
and bank only. This task adds `1240` as an allocation source, which is a change to a **spec-ready,
not-yet-built** module — cheap now, and a retrofit later.

⭐ **If T-130 is built before this task starts, that is the better order** and the allocation source
belongs in T-130 itself. **Report which way it went; do not silently build a second allocator.**

## 6. Scope

**Create:** `packages/db/schema/supplier-returns.ts` ·
`packages/db/migrations/<next>_t170_supplier_returns.sql` ·
`packages/domain/src/stock/supplier-returns.ts` ·
`packages/db/src/repo/supplier-returns.ts` ·
`apps/erp/src/app/inventory/returns/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/supplier-returns.test.ts`

**Modify:** `packages/domain/src/ap/index.ts` (allocation source, §5) · barrels ·
`classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` · `docs/POSTING-PATTERNS.md`
(three patterns) · `tests/worked-examples/fixtures.ts` · `repo/findings.ts` · `_journal.json` ·
`docs/ROADMAP.html`

## 7. Contract

```
supplier_returns
  id, org_id, store_id
  supplier_id      uuid NOT NULL -> suppliers
  delivery_id      uuid NULL -> deliveries
  returned_on      date NOT NULL
  reason           text NOT NULL
  credit_basis     'grni' | 'supplier_advance' NOT NULL   -- DERIVED at post, §3
  status           'posted' | 'void' NOT NULL default 'posted'
  journal_entry_id uuid NOT NULL -> journal_entries
  voided_at, voided_by, void_reason, created_by, created_at

supplier_return_lines
  id, return_id -> supplier_returns (cascade)
  line_no, item_id, location_id
  quantity  numeric(14,3) NOT NULL check (quantity > 0)
  delivery_line_id uuid NULL -> delivery_lines
  movement_id uuid NOT NULL -> stock_movements
  unit_cost numeric(14,4) NOT NULL          -- the layer cost actually relieved
  unique (return_id, line_no)
```

```ts
recordReturn(input): Promise<SupplierReturn>            // one transaction: stock + layers + entry
voidReturn(id, reason): Promise<void>
returnableQuantity(deliveryLineId): Promise<Quantity>
supplierCreditBalance(supplierId): Promise<Money>       // ⭐ derived from 1240, never stored
```

## 8. Invariants

1. **No draft state.** A return is recorded when the goods physically leave. ⚠️ Deliberately unlike
   usage (T-168), where a floor worker records and a manager posts — a return is one act by one
   person.
2. **Quantity is capped at `received − already returned`** for a linked delivery line.
3. ⭐ **On-hand may not go negative, and there is NO override** — not even for an admin.
4. **Layers are relieved oldest-first** (T-162), and the relieved cost is what posts. ⚠️ **Not the
   original delivery's cost** — if that lot has been consumed, the return relieves what is actually
   there, and the difference is real, not an error to suppress.
5. ⭐ **`credit_basis` is DERIVED at post time** from whether the receipt carries a linked invoice —
   never a user choice, never a stored preference. A return spanning both cases splits into the two
   postings within one entry.
6. **The credit is a `1240` balance with the supplier as party.** ⛔ No `supplier_credits` table, no
   `credit_balance` column: it is a query over the ledger (DEF-075, ninth appearance refused).
7. **Allocation draws the credit down oldest-first** against open invoices, and cannot allocate more
   than the balance.
8. **A cash refund from the supplier draws `1240` down** and is not a new document type.
9. **Void reverses stock, layers and entry together**, and is refused once the credit has been
   allocated or refunded — ⭐ **unwind the allocation first.** *A void that leaves a spent credit
   dangling is the cross-module orphan v1's non-atomic cascade produced.*
10. **Period lock applies** to record, void, allocate and refund.
11. **A return may not name a supplier the linked delivery did not come from.**

## 9. Tests

1. Returning 10 of 30 against an **uninvoiced** receipt posts `Dr 2120 / Cr 1310` at the relieved
   FIFO cost, and **creates no `1240` balance** — asserted, because that is the case most likely to
   be implemented as a credit by mistake.
2. Returning against an **invoiced** receipt posts `Dr 1240 / Cr 1310` with the supplier as party.
3. A return spanning both cases posts both legs in **one** entry, and the entry balances.
4. Returning 31 of 30 is refused.
5. ⭐ Returning more than on-hand is refused **for an admin too** — asserted with an admin principal,
   because the no-override rule is the point.
6. Returning after part of the lot was consumed relieves the **remaining** layers at their cost,
   which differs from the original delivery cost. Asserted numerically.
7. ⭐ **The credit is spendable:** allocating it against a later invoice posts `Dr 2110 / Cr 1240`,
   and `supplierCreditBalance` returns zero afterwards. *Ian's actual requirement — "we can use it
   for next purchase" — and the test that proves it.*
8. Allocating more than the balance is refused.
9. A cash refund draws `1240` to zero.
10. Void reverses all three artefacts; `1310`, `1240` and on-hand return to prior values; the trial
    balance ties.
11. Void after the credit was allocated is refused, naming the allocation.
12. A return into a closed period is refused.
13. A return naming a different supplier than the linked delivery is refused.
14. ⭐ After every path above, `Σ 1310+1320+1330 = Σ` open-layer value — **the Phase 3 gate asserted
    on this path specifically**, because this is the path that would have broken it under v1's shape.
15. RLS: cross-store return refused.

## 10. Out of scope

⛔ **A separate supplier credit-note document with its own numbering.** The return **is** the
document; the credit is a balance. A second artefact would be ceremony this business does not have.
⛔ **`apAlreadyHandled`.** §4.
⛔ **Returns to a commissary.** A branch returning to its own commissary is **not a credit at all** —
it is T-173's transfer run backwards, and T-179 §4 owns it.
⛔ **Customer returns.** T-179.
⛔ **RMA / supplier-quality workflows.** Out of scope for the project.

## 11. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded (DEF-077).
- [ ] `docs/POSTING-PATTERNS.md` gains `supplier.return-grni`, `supplier.return-credit` and
      `supplier.credit-applied`, pinned by `fixtures.ts`. ⚠️ `npm run toc`.
- [ ] `supplierCreditAgeing` registered in `repo/findings.ts` — ⭐ **a credit nobody has spent is
      money sitting with a supplier**, and it is exactly the kind of balance that goes unnoticed
      until the relationship ends.
- [ ] §5's ordering decision reported: whether the `1240` allocation source landed here or in T-130.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] ⭐ **A live route exists and was used in the browser** — record a return, then spend the credit
      on a later invoice. §4's last row is why this line is here: this exact feature shipped in v1
      with no UI for seven weeks and returned goods stayed on the books the whole time.
- [ ] `CAPABILITY-MATRIX.md`: `record_supplier_return`, `void_supplier_return`,
      `apply_supplier_credit` — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
