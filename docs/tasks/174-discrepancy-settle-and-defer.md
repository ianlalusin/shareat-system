# T-174 — What happens to the goods that never arrived

> **Status:** ⭐ **BUILT, 2026-08-30** — migration `0071`, `packages/db/schema/trade-discrepancies.ts`, `packages/db/src/repo/trade-discrepancies.ts`, `packages/domain/src/commissary/discrepancy.ts`, the day-open block in `sales-days/create.ts`, and 21 + 6 green integration tests. ⛔ **Building it found DEF-098** — `1340` could never clear, because T-173 debited it at cost and credited it at the transfer rate. ⚠️ **Two of this spec's own rules changed at build time — §10.** The screen is not built (port 9008).
> **Depends on:** T-173 (which leaves the gap in `1340`), T-164 (wastage/variance postings),
> T-123 (sales day — for the day-open block).
> **v1 read at source** — `branch-order-fulfilment.actions.ts:347-590`,
> `branch-sales-settle.actions.ts`. `docs/discovery/14` §O rows 18–21.

## 1. Goal

A dispatched-versus-received gap gets a decision from a human, with a posting behind it — and an
order cannot sit unresolved forever, because an unresolved one blocks the commissary from opening a
new sales day.

## 2. ⭐ Why "settle" survives when the machinery around it does not

T-173 §3 deletes v1's `pending_variance` two-phase commit and its three repair tools, because they
existed to survive a *transaction* failing halfway across two Firestore stores. **That problem is
gone.**

> ⚠️ **But settle is not only that.** A quantity dispute is a real business event: the branch says
> 90 kg arrived, the commissary says it sent 100. That needs a human decision and a posting, and it
> does not go away because the database got better.

⭐ **Keep the capability; delete the plumbing it was bolted to.** v1's settle was reached through a
failure path; v2's is reached through the front door.

## 3. The three dispositions, and each is a different account

T-173 leaves the shortfall sitting in `1340 Inventory in transit` on the commissary's books. It is a
real asset — goods that left and did not arrive — until someone says what happened to them.

| Disposition | Posting | When |
|---|---|---|
| **Audit only** | ⛔ **Nothing.** The gap stays in `1340` with a note | A recount is coming, or the rest of the shipment is | 
| **Loss** | `Dr 5300` Wastage and spoilage · `Cr 1340` | Goods genuinely lost, damaged or spoiled in transit |
| **Charge** | `Dr 1230` Advances to employees *(party: person)* · `Cr 1340` | Recovered from a named staffer, at the transfer value |
| **Late receipt** | The T-173 entry, for the balance | The rest turns up |

⭐ **`5300` and not `5400`.** A count variance is a *correction* to the books; goods that visibly
left one building and did not reach another are a *loss*. Different facts, different accounts —
the same distinction T-164 §2 already draws.

⚠️ **The charge posts to `1230`, not to a P&L account.** It is a receivable from the staffer, drawn
down by a payroll deduction (Phase 5). If Phase 5's advance module is not built, **the charge
disposition is refused with a named error** — never silently downgraded to a loss.

## 4. Scope

**Create:** `packages/db/schema/trade-discrepancies.ts` ·
`packages/db/migrations/<next>_t174_discrepancies.sql` ·
`packages/domain/src/commissary/discrepancy.ts` ·
`packages/db/src/repo/trade-discrepancies.ts` ·
`apps/erp/src/app/commissary/discrepancies/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/commissary-discrepancy.test.ts`

**Modify:** `packages/domain/src/sales-days/index.ts` (the day-open block) ·
`docs/POSTING-PATTERNS.md` (two patterns) · `tests/worked-examples/fixtures.ts` ·
`repo/findings.ts` · `CAPABILITY-MATRIX.md` · barrels · `_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
trade_discrepancies
  id, org_id
  trade_order_id -> trade_orders
  trade_order_line_id -> trade_order_lines
  quantity     numeric(14,3) NOT NULL check (quantity > 0)   -- dispatched - received
  value        numeric(14,2) NOT NULL                        -- quantity x line rate
  status       'open' | 'deferred' | 'resolved' NOT NULL default 'open'
  disposition  'audit' | 'loss' | 'charge' | 'late_receipt' NULL
  charge_person_id uuid NULL -> persons
  deferred_to  date NULL                       -- exactly once, invariant 4
  note         text
  journal_entry_id uuid NULL -> journal_entries
  resolved_at, resolved_by, created_at
  unique (trade_order_line_id)
  check (disposition <> 'charge' or charge_person_id is not null)
  check (status <> 'resolved' or disposition is not null)
```

```ts
openDiscrepancies(storeId): Promise<TradeDiscrepancy[]>   // derived, never a stored counter
resolve(id, { disposition, chargePersonId?, note }): Promise<void>
defer(id, toDate): Promise<void>                          // once only
blockingDiscrepancies(storeId, forDate): Promise<TradeDiscrepancy[]>   // gates day-open
```

## 6. Invariants

1. **A discrepancy row is created by T-173's confirm**, automatically, for every line where
   received < dispatched. It is never hand-created.
2. **One discrepancy per order line**, unique.
3. **`audit` posts nothing** and leaves the value in `1340`. It is a *decision to wait*, and it is
   still `open` for the day-open block.
4. ⭐ **`defer` may be used exactly once per discrepancy.** A second defer is refused, forcing a real
   decision. ⚠️ v1's rule, kept verbatim, and it is the whole reason defer is safe to offer.
5. **`loss` and `charge` post in one transaction with the status change** and relieve `1340` exactly.
6. **`charge` without a live salary-advance module is refused**, naming Phase 5 — never downgraded.
7. ⭐ **Every `open` discrepancy, and every `deferred` one whose date has arrived, BLOCKS the
   commissary from starting a new sales day.** v1's reason is exactly right: *forces resolution
   before revenue can be understated further.*
8. **The blocking list is derived from the rows**, never a maintained counter or flag (DEF-075).
9. **A `late_receipt` disposition re-opens the T-173 path** for the outstanding quantity and does
   not post here.
10. **Resolution is terminal.** Correcting a wrong disposition is a reversal plus a new resolution,
    not an edit (invariant 5).
11. **Only a commissary-side manager/admin may resolve.** ⚠️ The goods are the commissary's asset;
    the branch reports what arrived and does not decide what the difference was.
12. **Period lock applies.**

## 7. Tests

1. A confirm of 90 against 100 creates exactly one `open` discrepancy of 10 units at the line rate.
2. `audit` posts nothing; `1340` is unchanged; the discrepancy stays `open`.
3. `loss` posts `Dr 5300 / Cr 1340` for the value and relieves `1340` to zero for that line.
4. `charge` posts `Dr 1230 / Cr 1340` with the person as party.
5. `charge` with no advance module is refused, naming Phase 5 — and **no partial posting** exists
   afterwards.
6. ⭐ `defer` once succeeds; a second `defer` is refused.
7. ⭐ **The day-open block:** with one `open` discrepancy, `startSalesDay` for the commissary is
   refused and names the order. With it resolved, the day opens. With a `deferred` one whose date is
   tomorrow, the day opens; on that date, it does not.
8. `late_receipt` followed by a second confirm posts the balance through T-173 and closes the
   discrepancy.
9. A branch-side principal cannot resolve; a commissary manager can.
10. Re-resolving a resolved discrepancy is refused.
11. ⭐ After every disposition, `Σ 1310+1320+1330+1340 = Σ` open-layer value **across both stores** —
    the Phase 3 gate, asserted on the disposal path, because `1340` is the account most likely to be
    left holding a ghost.
12. Live route on 9008: confirm short, see the discrepancy, resolve it as a loss.

## 8. Out of scope

⛔ **v1's `pending_variance` / settle-a-failed-transaction path.** T-173 §3 — the failure it
recovered from cannot happen.
⛔ **The three admin repair/backfill tools.** T-173 §3.
⛔ **The staff-charge collection itself.** Phase 5 draws `1230` down through payroll.
⛔ **Over-receipt** (received > dispatched). ⚠️ **Named rather than assumed away:** it is a real
possibility and it is **not** a discrepancy — it is a receipt of more goods, and T-173 posts what
arrived. A negative `1340` remainder is refused by that path, which is where it belongs.
⛔ **Supplier-side shortages.** T-166's shortage reasons — a different counterparty, a different
taxonomy.

## 9. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded.
- [ ] `docs/POSTING-PATTERNS.md` gains `commissary.discrepancy-loss` and
      `commissary.discrepancy-charge`, pinned by `fixtures.ts`. ⚠️ `npm run toc`.
- [ ] `commissaryDiscrepancyOpen` registered in `repo/findings.ts`, and the sales-day block wired to
      the same query — **one source, two consumers**, never two lists that can disagree.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `resolve_trade_discrepancy` (commissary manager/admin),
      `charge_staff_for_discrepancy` — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.

## 10. ⚠️ What this spec got wrong, found by building it

### ⛔ 1. §3's "at the transfer value" was wrong, and it hid a bigger bug

The disposition table valued a charge *"at the transfer value"*, and §5 defined `value` as
*"quantity × line rate"*. Both are wrong for the same reason: **what is stranded in `1340` is
COST**, not transfer value. Relieving it at ₱310/kg when ₱300/kg went in leaves the account short
by the margin on every disposal.

⭐ Following that thread found **DEF-098**, which was the larger fault and one task upstream:
T-173 credited `1340` at the transfer rate too, so `1340` could **never clear** — a fully received
₱30,000 shipment transferred at ₱31,000 left it at −₱1,000, permanently, once per shipment.
⚠️ **The trial balance still tied**, so nothing announced it.

**Everything here is now valued at cost**, and the transfer margin goes to `5175` only for goods
that actually arrive.

### ⚠️ 2. Invariant 6 — `charge` is NOT refused while Phase 5 is unbuilt

The spec said a `charge` should be refused with a named error until the salary-advance module
exists. Built out, that is the wrong call:

- ⛔ It would leave `audit` and `loss` as the only options, so a genuinely **recoverable**
  shortfall gets written off as a loss — worse, and irreversible in the books.
- ⚠️ The same `1230` receivable is **already raisable through two shipped doors** (`owners`,
  `cash-requests`), so a gate here would be inconsistent rather than protective.

⭐ The real gap is that **nothing ever credits `1230`** — logged as **DEF-099**, and the right
control is the same one DEF-082 reached for `2160`: **an ageing alarm, not a block.** It is not
built.

### ⭐ 3. Test 11's gate needed splitting into two ties

§7.11 asks that `Σ 1310+1320+1330+1340 = Σ` open-layer value. That is false by exactly the
in-transit amount, and correctly so: **goods on a truck are in no layer**, because a FIFO layer is
a thing on a shelf. The gate is now two statements — `1310+1320+1330 = open layer value`, and
`1340 = unresolved discrepancy value`. ⚠️ The second is the sharper one: a `1340` balance with no
unresolved row to explain it is a ghost.

### ⚠️ 4. Still not built

`apps/erp/src/app/commissary/discrepancies/**` (port 9008), the `resolve_trade_discrepancy` and
`charge_staff_for_discrepancy` capability rows (no caller yet, so their ✗ cannot be tested — same
reasoning as T-173 §12), and the `commissaryDiscrepancyOpen` finding. ⭐ **The day-open block does
not depend on the finding**: it queries `tradeDiscrepanciesRepo.blocking` directly, which is the
same query the screen will list from — one source, two consumers, per invariant 8.
