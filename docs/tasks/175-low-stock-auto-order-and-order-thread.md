# T-175 — Low stock becomes an order, and the order has a conversation

> **Status:** ⭐ **BUILT, 2026-08-30** — migration `0072`, `packages/db/schema/item-thresholds.ts`, `packages/db/src/repo/low-stock.ts`, `packages/domain/src/commissary/auto-order.ts` and `messages.ts`, the `itemHasNoThreshold` finding, and 20 green integration tests. ⚠️ **§3's question is answered the recommended way — a SUGGESTED quantity, not v1's zero. One line reverts it; see §10.** The low-stock screen is not built (port 9008).
> ⚠️ **Carries one question for Ian** — §3. Built the recommended way and flagged.
> **Depends on:** T-161 (on-hand), T-168 (usage posts trigger it), T-171 (the map), T-172 (the
> order it drafts into).
> **v1 read at source** — `low-stock.actions.ts`, `branch-low-stock-order.actions.ts`,
> `item-location-settings.actions.ts`, `branch-order-messages.actions.ts`.
> `docs/discovery/14` §D and §O row 25.

## 1. Goal

The low-stock signal turns into an actual replenishment action instead of a list someone has to
remember to read — and a discrepancy or a substitution can be discussed on the order it concerns,
in a trail that survives the conversation.

## 2. The reorder model, and it is smaller than the data model implies

⭐ **`itemReorderPolicies` and `reorderAlerts` are DEAD SCHEMA.** `docs/discovery/14` §D verified it:
*"grep across `src/lib/**` and `functions/**` finds zero references to either name anywhere in the
codebase."* `01-data-model.md` lists them; nothing uses them.

**The live mechanism is one field**: `lowStockThreshold` per store per item, plus a summed-on-read
query. ⛔ **Do not build a policy-object reorder system. Build the threshold-based one that is
actually in production.**

⚠️ **Item-master debris to leave behind too:** v1's `items` still exposes `reorderPoint` and
`reorderQuantity` input fields on every edit form that **nothing reads** — vestiges of the removed
smart-reorder system (row 89, revive-but-later). T-145's `items` correctly has neither. **Do not add
them.**

## 3. ⚠️ THE QUESTION FOR IAN — is the auto-draft wanted?

v1: when a branch's stock drops to or below threshold after a usage or wastage post, the item is
**automatically queued at quantity 0** onto that branch's open commissary order draft — or a draft
is created if none exists.

`docs/discovery/14` §D asks it directly: *"is this used and valued in practice, or does it just
clutter drafts with 0-qty lines nobody fills in?"*

**Recommendation: build it, with one change — the line carries a SUGGESTED quantity, not zero.**

> A zero-quantity line is a to-do item wearing an order line's clothes. The suggestion is
> computable from data v2 already has: `threshold − onHand`, rounded up to the purchase unit. If the
> branch disagrees it types over it, which is one keystroke fewer than typing into a blank.

⭐ **And the scope rule is kept exactly:** buyer stores only — a commissary restocks from suppliers,
not through this path — and never a second open order while one is already open (T-172 invariant 3).

## 4. Scope

**Create:** `packages/db/schema/item-thresholds.ts` ·
`packages/db/migrations/<next>_t175_thresholds_and_messages.sql` ·
`packages/domain/src/stock/low-stock.ts` ·
`packages/domain/src/commissary/auto-order.ts` ·
`packages/domain/src/commissary/messages.ts` ·
`packages/db/src/repo/low-stock.ts` ·
`apps/erp/src/app/inventory/low-stock/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/low-stock.test.ts`

**Modify:** `packages/domain/src/stock/usage.ts` (fire the trigger after a post) ·
`repo/findings.ts` · barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
store_item_thresholds
  id, org_id, store_id -> stores, item_id -> items
  low_stock_threshold numeric(14,3) NOT NULL check (low_stock_threshold >= 0)
  set_by, created_at, updated_at
  unique (store_id, item_id)

trade_order_messages               -- append-only, per order, mirrored to nobody
  id, org_id, trade_order_id -> trade_orders (cascade)
  body       text NOT NULL check (length(trim(body)) > 0)
  author_id  uuid NOT NULL -> persons
  created_at timestamptz NOT NULL default now()
  index (trade_order_id, created_at)
```

```ts
setThreshold(storeId, itemId, threshold) / clearThreshold(storeId, itemId)
lowStock(storeId): Promise<LowStockRow[]>       // at or below, worst shortfall first
ensureAutoOrderLines(storeId, itemIds): Promise<AutoOrderReport>
postMessage(orderId, body) / listMessages(orderId)
```

## 6. Invariants

1. **Low stock is a query over T-161's on-hand summed across the store's locations**, compared to
   the threshold. ⛔ No cached list, no alert table (DEF-075, and §2's dead schema).
2. **An item with no threshold is not low stock**, and is instead surfaced as a **finding** —
   `itemHasNoThreshold`. ⭐ **This is the replacement for v1's forcing function** (T-168 §7.1): it
   nags a manager instead of blocking a cook at 11pm.
3. **Equipment-kind items are exempt** from thresholds and from auto-order. They are not consumables
   (T-168).
4. **Auto-order fires only for buyer stores** — a store with an active `commissary_links` row as the
   branch. A commissary never auto-orders.
5. **Auto-order appends to the single open draft, or creates one.** ⛔ Never a second open order
   (T-172 invariant 3).
6. **An item already on the open draft is not appended again**, at any quantity — idempotent per
   (order, item).
7. **The suggested quantity is `threshold − onHand` rounded up to the purchase unit**, and is
   overwritable. ⚠️ It is a **suggestion recorded on the line**, not a second stored balance: it is
   written once at append and never refreshed, because a number that silently changes under a person
   filling in a form is worse than a stale one.
8. ⭐ **Auto-order failure never fails the usage post that triggered it.** It runs after commit and
   its failure is a finding. *A cook must be able to record what they used even when the ordering
   subsystem is down.*
9. **Messages are append-only** — no edit, no delete, enforced by the same trigger pattern as
   T-161. ⚠️ It is an audit trail of a commercial conversation, and an editable audit trail is not
   one.
10. **A message may be posted by a principal with access to either store**, matching T-173
    invariant 8 — both sides are in this conversation.
11. **Messages carry no attachments and no read receipts.** §8.

## 7. Tests

1. `lowStock` returns items at or below threshold, worst shortfall first, and excludes items above.
2. An item with no threshold does not appear, and raises `itemHasNoThreshold`.
3. Equipment-kind items never appear and never auto-order.
4. Posting usage that crosses the threshold appends one line to the branch's open draft, with a
   suggested quantity of `threshold − onHand` rounded up.
5. Posting usage again for the same item appends **nothing** — idempotent.
6. With no open order, one is created; with a `dispatched` order open, **no second order is
   created** and the reason is reported.
7. A commissary store never auto-orders.
8. ⭐ Forcing `ensureAutoOrderLines` to throw leaves the usage post **committed** and raises a
   finding. *This is the test that proves invariant 8.*
9. A hand-edited suggested quantity survives a later usage post.
10. `UPDATE` and `DELETE` on `trade_order_messages` **raise**, in raw SQL.
11. A principal with access to neither store cannot post or read messages.
12. Live route on 9008: the low-stock list, and an auto-drafted line visible on the order.

## 8. Out of scope

⛔ **Smart reorder** — 14-day projection, day-of-week seasonality, AI recommendations, an alerts
dashboard with ack/snooze/dismiss. ✅ **Already classified: *"revive, but later"*** (Ian,
2026-08-23, bible row 89). ⚠️ It is a **regression to investigate, not a feature to scope fresh** —
it existed in v1, was removed, and left `firestore.rules` blocks naming a deleted `reorder.actions.ts`.
⛔ **`itemReorderPolicies` / `reorderAlerts`.** §2 — dead schema.
⛔ **`reorderPoint` / `reorderQuantity` on the item master.** §2 — vestigial in v1.
⛔ **Message attachments, read receipts, notifications.** In-app notifications are a separate
deferred gap (`CAPABILITY-GAPS.md`).
⛔ **Supplier auto-ordering.** A commissary restocks through T-166, by a human.

## 9. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`,
      including the append-only trigger on messages.
- [ ] `classification.ts`: `store_item_thresholds` **KEEP** (configuration, like `item_pricing`);
      `trade_order_messages` **PURGE** (it belongs to a purged order). `rls/registry.ts`
      NULLIF-guarded.
- [ ] `itemHasNoThreshold` and `autoOrderFailed` registered in `repo/findings.ts`.
- [ ] ⭐ §3's question is in the task report's `FOR IAN` block: *built with a suggested quantity
      rather than v1's zero; here is why; one line reverts it.*
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `set_item_threshold` (manager, and cashier/inventory staff per v1),
      `post_order_message` — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.


## 10. ⭐ FOR IAN — §3's question, and how to reverse the answer



**Built the recommended way.** When a branch's stock reaches its threshold, the item is appended to

that branch's open commissary draft **with a suggested quantity** — `threshold − onHand`, rounded

up to a whole base unit — rather than v1's quantity 0.



**Why:** a zero-quantity line is a to-do item wearing an order line's clothes, which is exactly what

`docs/discovery/14` §D suspected was happening. The number is computable from data we already have,

and a line that arrives filled in is one keystroke *fewer* than a blank one: the branch accepts by

doing nothing and types over it when it disagrees.



⚠️ **If you would rather have v1's behaviour**, it is one line in

`packages/domain/src/commissary/auto-order.ts` — `suggestFor` returns `quantity('0')`. Nothing else

changes; the `suggested_quantity` column simply records zero.



⭐ **A second decision worth knowing about, because it changes what a cook experiences.** v1 blocks

a usage post until somebody sets the item's threshold. That puts the demand on the person at the

stove at 11pm, who cannot answer it. Here it is a **finding** instead — `itemHasNoThreshold`, per

store — so it nags the manager who can act. **Nag the person who can act, never block the person

who cannot.**



## 11. ⚠️ What the spec assumed that the code did not need



### ⭐ Invariant 3 — equipment exemption is already structural



§6.3 exempts *"equipment-kind items"*. There is no such kind: `ITEM_KINDS` is `raw_material`,

`supply`, `retail`, `meat_slab`, `meat_sliced`, and equipment lives in `fixed_assets`, a different

table with a different lifecycle. ⛔ **The exemption needs no code** — an equipment item cannot be

an `items` row, so it cannot have a threshold or reach the auto-order. Recorded rather than

silently dropped, because the next reader will look for the check.



### ⚠️ Where the price comes from, and what is still missing



The appended line is priced from the commissary offering's `manual_cost` — **tier 3 of T-171's

fallback only**. The richer basis (a slab link, then the item's own landed history from T-151) is

the catalogue read path, which is unbuilt. ⛔ An item with no price is **not added**, and the report

says so: a ₱0 line becomes a ₱0 order becomes a ₱0 receivable, and that matters more for a

machine-made line than a hand-made one, because nobody looks at this one before it lands.



### ✅ Was "still not built" — resolved 2026-09-06 (T-220)

⚠️ **Written 2026-08-30 and never revisited while later tasks built almost all of it.** Corrected by
T-220's deferral sweep (DEF-185).

| Then | Now |
|---|---|
| `apps/erp/src/app/inventory/low-stock/**` and the order-thread UI — blocked on port 9008 | ✅ **Built** (`page.tsx`, `actions.ts`) |
| `set_item_threshold`, `post_order_message` capability rows | ✅ **Both in `CAPABILITY-MATRIX.md` and `packages/auth/src/capabilities.ts`** |
| `itemHasNoThreshold` finding | ✅ **Shipped** — `findingsRepo.itemsMissingThreshold` raises exactly that kind |
| `autoOrderFailed` finding | ⛔ **Deliberately NOT built — T-220 §4, and DEF-186** |

⛔ **Why it is refused, and the bigger thing found while refusing it.** `replenishAfterUsage`
persists nothing — its `failed` string is returned and dropped — so there is no state for a derived
detector to read under T-135's derived-not-stored model.

⚠️ **And `replenishAfterUsage` has ZERO production callers.** `grep` across `packages/` and `apps/`
finds it in three places, all inside `packages/domain/tests/integration/low-stock.test.ts`. **The
low-stock auto-order never runs.** The header's reason for not calling it from `postUsageRecord` is
sound — that function takes a `tx` it does not own — but it was then never wired anywhere else. A
detector here would report on a code path that never executes: exactly the vacuous detector T-161
refused. Filed as **DEF-186**; wiring the seam is Ian's call, not T-220's.

⭐ The original containment argument stands and is why this is not urgent: a broken ordering path
costs a draft line and never a usage post.
