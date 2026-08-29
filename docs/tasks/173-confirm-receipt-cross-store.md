# T-173 — ⭐ Confirm receipt: the one event where both stores' books move

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-172 (the dispatched order), T-165 (the perpetual shape), T-163 (the receipt
> posting), T-166 (the delivery document it auto-creates).
> **v1 read at source** — `branch-order-receive.actions.ts` (698 lines),
> `commissary-delivery-expense.actions.ts`, shared gate `autobook.ts:27-56`.
> `docs/discovery/14` §O rows 13–17, and the *"Intent worth preserving"* entries for both.
> ⭐ **`docs/discovery/14` calls this "the single most important cross-domain rule in the whole
> commissary system."** This spec exists so it is preserved as a stated invariant rather than
> re-derived from first principles.

## 1. Goal

When a branch confirms what actually arrived, **both stores' books move, once, together, in one
database transaction** — and they agree by construction rather than by later correction.

## 2. ⭐ The rule, and it is the whole task

> **Everything posts at CONFIRM RECEIPT, keyed to what the branch actually RECEIVED — never to what
> was fulfilled or dispatched.**

v1 arrived at this after the alternative failed, and said so plainly:

> *"This avoids the previous mismatch where dispatched-fulfilled qty differed from received qty and
> the AR had to be retroactively credited."* (`branch-order-receive.actions.ts:56-80`)

⭐ **It is also Phase 2 §3.3's already-adopted rule, arrived at independently from the sell side** —
*"the buyer's side posts at `received`, not at `dispatched`… so a short delivery or a dispute
surfaces as a disagreement instead of being silently absorbed."* Two roads, one destination.

## 3. What v2 deletes, and why it can

v1's pipeline is shaped around one constraint that **no longer exists**: Firestore cannot span two
stores in one transaction.

| v1 mechanism | v2 |
|---|---|
| `pending_variance` stamped first, flipped to `recognized` inside the second store's transaction | ⛔ **Deleted.** A two-phase-commit workaround for a limitation that is gone |
| Admin repair: orphaned branch-sale revenue | ⛔ **Deleted.** Repairs a hard-delete path v2 does not have |
| Admin backfill: sale never mirrored into the sales-day report | ⛔ **Deleted.** v2's report is a query over the ledger; there is no mirror to miss |
| Admin repair: branch-payment → commissary-AR mirror | ⛔ **Deleted.** One transaction, no mirror |

⭐ `03-business-logic.md` §8 calls this *"likely the single largest simplification available anywhere
in this codebase."* Four repair tools and a two-phase commit collapse into one `BEGIN … COMMIT`.

⚠️ **The underlying invariant must survive the deletion:** *never recognise a movement you have not
successfully posted both sides of, and never leave a clean receipt unrecoverable.* Under Postgres
that is not a protocol — it is what a transaction **is**.

## 4. The posting — one entry, six legs, two stores

Continuing T-172's ₱18,000 dispatch, all of it received:

| Account | Store | Dr | Cr |
|---|---|---:|---:|
| `1340` Inventory in transit | commissary | | 18,000.00 |
| `1250` Due from related store *(party: branch code)* | commissary | 18,000.00 | |
| `1310`/`1330` Inventory | branch | 18,000.00 | |
| `2150` Due to related store *(party: commissary code)* | branch | | 18,000.00 |

**Plus T-151's outbound fee, if any**, riding the same entry: it lands on the receiving store and
**touches no item's cost** (T-151 invariant 2, test 8).

⭐ **No revenue.** *A branch is not a customer of its own company.* v1 books branch sales as revenue,
which is why it then needed `excludeBranchSales` to stop its own insights being wrong — **the
exclusion is the tell that the recognition was wrong upstream** (T-133 §3).

⚠️ **`party_id` for a `party_type='store'` line is the other store's `code`, not a uuid** — there is
no party FK yet (DEF-040) and store codes are stable and human-chosen.

### The branch's stock and layers

The received quantity creates **branch-side FIFO layers at the transfer price** — which is what
carries the commissary's processing cost into the branch's books (T-133: *"the transfer PRICE
carries the processing cost — ₱310/kg, not ₱300"*). ⭐ **The layer is confirmed, not provisional:**
the price is known and agreed, there is no invoice still to arrive, and nothing goes to `2120`.

### The auto-created delivery

The receipt creates a `deliveries` row with `kind = 'commissary'` — the branch's own record of what
arrived, **exempt from T-166's photo gate** because it is system-generated. It carries no separate
posting; T-173's entry is the posting.

## 5. ⭐ The ₱12,184.71 incident, and the structural answer

**AP silently never booked**, traced to Banay-Banay order BO-BNY-2607-0011, 2026-07-23, ₱12,184.71.
The auto-book wrapper was tightened to manager/admin in a cross-store sweep while the
receipt-confirm gate still admitted cashiers — so **every cashier-received delivery from then on
booked no AP at all**, with no error anywhere. v1's fix was to make both gates share one definition.

> **v2's answer is stronger than a shared definition: there is no second gate.** The posting happens
> **inside** the confirm transaction. There is no `autoBookBranchDeliveryExpenses` function to call,
> to forget, or to gate differently. `CAPABILITY-MATRIX.md` gets **one** row — `confirm_receipt` —
> and it is the only authority involved.

⚠️ **A second, related v1 finding is closed by the same shape:** both auto-book and its reverse were
**independently-reachable, unauthenticated server actions** (*any `'use server'` export is an RPC
endpoint*) that wrote and reversed expenses on a branch with no auth at all. In v2 they do not
exist as endpoints.

⭐ **The two-sided access check survives as a real requirement, though:** a commissary-side actor and
a branch-side actor are **both** legitimate callers of the confirm path, from opposite store-access
grants. A one-sided check would break the highest-volume commissary flow — invariant 8.

## 6. Scope

**Create:** `packages/domain/src/commissary/receive.ts` ·
`packages/db/migrations/<next>_t173_confirm_receipt.sql` ·
`apps/erp/src/app/commissary/orders/[id]/receive/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/commissary-receive.test.ts`

**Modify:** `packages/db/schema/trade.ts` (`received_quantity` on the line) ·
`packages/domain/src/trade/index.ts` · `docs/POSTING-PATTERNS.md`
(`commissary_dispatch.transfer` gains the receipt half) · `tests/worked-examples/fixtures.ts` ·
`CAPABILITY-MATRIX.md` · `repo/findings.ts` · `_journal.json` · `docs/ROADMAP.html`

## 7. Invariants

1. ⭐ **Every posting is keyed to `received_quantity`, never `fulfilled_quantity`.** §2.
2. **One transaction, both stores.** ⛔ No best-effort second write, no mirror, no repair tool.
3. **`1250` and `2150` are equal and opposite within the entry**, so invariant 6's reciprocal check
   holds by construction (T-133 invariant 3).
4. **`1340` is fully relieved for the received quantity**, and any dispatched-but-not-received
   remainder **stays in `1340`** until T-174 disposes of it. ⭐ **It is not written off silently** —
   goods in a truck that never arrived are a real asset until somebody says otherwise.
5. **No revenue leg. No `ar_charge`. The credit limit is not consulted.** A branch is not extended
   credit (T-133 invariant 4).
6. ⚠️ **Unit-mismatch guard:** if the branch item's `base_unit` differs from what was dispatched, the
   **movement and the entry are written and flagged, and the branch BALANCE is skipped**. v1's
   reasoning is exactly right and is kept: *"adding commissary-denominated qty onto a branch balance
   the branch reads in its own unit is exactly the corruption we're preventing."* ⭐ In v2 this is a
   **finding**, `commissaryUnitMismatch`, not a silent flag on a document.
7. ⭐ **Receipt-confirm authority IS the posting authority.** One capability. §5.
8. **Two-sided access:** a caller with access to **either** store may confirm. Not one-sided.
9. **Confirming is idempotent.** A second confirm of the same order is refused, not re-posted.
10. **Period lock applies**, on both stores' legs — which is one entry, so one check.
11. **The branch's layers are created at the received quantity × the line rate**, confirmed, and
    never provisional.
12. **A short receipt does not block the confirm.** It posts what arrived and leaves the difference
    for T-174. ⛔ Blocking here is what forced v1's retroactive AR credits.

## 8. Tests

1. ⭐ **The core case:** dispatch 100 kg at ₱310, receive 100. One entry, four legs, both stores;
   `1340` at zero; branch layers of 100 @ ₱310; commissary on-hand unchanged (it already left at
   dispatch); `1250 = 2150`; **no revenue account touched at all**.
2. ⭐ **The short case:** dispatch 100, receive 90. Postings are ₱27,900 — **90 × ₱310, not 100** —
   and **₱3,100 stays in `1340`**, asserted.
3. Ian's worked case end to end: bought at ₱300, processed at ₱10/kg, transferred at ₱310. The
   branch's later consumption of that stock posts COGS at ₱310, so **the commissary's processing
   work reaches the branch's P&L**.
4. T-151's outbound fee rides the entry, lands on the receiving store, and **no item's landed cost
   changes** — asserted by re-reading the branch price.
5. No `ar_charge` row exists; the credit limit is not consulted even when the counterparty has one.
6. ⭐ **Unit mismatch:** a branch item in `g` against a commissary dispatch in `kg` writes the
   movement flagged, **skips the balance**, and raises `commissaryUnitMismatch`.
7. ⭐ **Both sides can confirm:** a commissary-scoped principal and a branch-scoped principal each
   succeed; a principal with access to **neither** is refused. *This is the two-sided check, and a
   one-sided implementation passes two of these three.*
8. ⭐ **The ₱12,184.71 regression test:** a **cashier** at the branch confirms a receipt, and the
   full four-leg entry posts. *There is no second authority that could admit the confirm and refuse
   the posting.*
9. A second confirm is refused.
10. A confirm into a closed period is refused.
11. ⭐ **Forcing the branch-side write to fail rolls back the commissary side too** — asserted by
    re-reading both stores. *This is the test that proves the two-phase commit was deletable.*
12. Across a fixture of mixed transfers and external sales, **total `1250` = total `2150`** for the
    org (T-133 test 8, extended to receipts).
13. `Σ 1310+1320+1330+1340` still equals `Σ` open-layer value across **both** stores — the Phase 3
    gate on the cross-store path.
14. Live route on 9008: confirm a receipt as a branch cashier and read both stores' ledgers.

## 9. Out of scope

⛔ **Discrepancy disposition.** T-174 decides what the `1340` remainder becomes.
⛔ **Franchise receipts.** No second org (T-133 §4, bible row 111). The `inter_entity` treatment is
still refused, and the refusal names the ADR.
⛔ **Any repair or backfill tool.** §3. If one is ever needed, the transaction was not a transaction.
⛔ **A branch payment to the commissary.** `1250`/`2150` are settled by T-139's `money_transfers`,
which already posts the four-leg cross-store shape with cash in place of goods.

## 10. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `docs/POSTING-PATTERNS.md`'s `commissary_dispatch` section carries **the whole arc** —
      dispatch to `1340` (T-172), receipt to the branch (this task) — with the periodic shape
      relabelled historical. ⚠️ `npm run toc`.
- [ ] `commissaryUnitMismatch` registered in `repo/findings.ts`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] Test 11 written **first** and shown to fail against a two-statement implementation.
- [ ] ⭐ `CAPABILITY-MATRIX.md` gains **exactly one** row for this path — `confirm_receipt`. A
      reviewer finding a second AP-booking capability has found §5 reproduced.
- [ ] `docs/ROADMAP.html` updated.
