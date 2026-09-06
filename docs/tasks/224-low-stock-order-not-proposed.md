# T-224 — `lowStockOrderNotProposed`: the durable half of DEF-186

> **Status:** spec written 2026-09-06 (ianla-25, Opus planner). **Decision:** Ian, 2026-09-06.
> **Completes:** DEF-186, whose fix (T-223) wired the auto-order but left its failures reported only
> on screen. ⛔ **No migration.**

## Why this exists

T-223 gave `replenishAfterUsage` its first caller and made a failure visible — as a clause on the
success message of the post that triggered it. ⚠️ **A screen message dies with the request.** Nobody
sees it twice, nobody sees it if they were not the person posting, and a *repeated* failure looks
exactly like a first one.

⭐ **The consequence is persisted, so it is derivable**: an item at or below its threshold, at a store
that can order, with nothing on order for it. That survives a lost log line, a closed tab, and the
cook who posted at 11pm and went home — which is the difference between a message and a control.

⛔ **Deliberately not shipped inside T-223.** A detector in the same commit as the path it watches
gives independent evidence of neither: if both are wrong together, both tests agree with both bugs.
That is DEF-188's mechanism exactly, and it is worth one extra commit to avoid.

## What the condition is — and it must not be a second definition

The detector's set mirrors `ensureAutoOrderLines`' own gates, in the same order, because a finding
that disagrees with the thing it watches is worse than no finding:

| Gate | Where it already lives | Why it is in the detector too |
|---|---|---|
| Store has an **active commissary link** | `lowStockRepo.commissaryFor` | ⛔ A store that cannot order must never be nagged for not ordering |
| Item is **at or below threshold** | `lowStockRepo.lowStock` — `coalesce(qty,0) <= threshold`, `items.status = 'active'` | Same predicate, including the `<=` and the active-item filter |
| Item is **not already on the open order** | `lowStockRepo.openOrderFor` + `itemsAlreadyOnOrder` | ⚠️ See below — this is the part that is easy to get wrong |

⭐ **"Open" means `draft`, `confirmed` OR `dispatched`, and dispatched is the one that matters.**
`openOrderFor`'s own comment: *"a dispatched order is goods-in-transit not yet received, so it
BLOCKS. An auto-append must not quietly start a second order while a truck is still on the road."*
⛔ **A detector that only checked `draft` would fire on every item currently in a truck** — stock that
has been ordered, paid for, and is physically on its way. That is the noise failure this task must
not ship.

⚠️ **And the line must carry `requested_quantity is not null`**, matching `itemsAlreadyOnOrder`. A
`commissary_added` substitution line is the commissary's proposal, not the branch's ask, and does not
mean the branch ordered the item.

## Contract

```ts
export async function lowStockOrderNotProposed(tx: Tx, orgId: string): Promise<DetectedFinding[]>
```

**Aggregated per branch store**, one finding each: `{ storeId, count, deepest shortfall, sample item
names }`. ⛔ Not one finding per item — a store with 20 low items is one operational problem, and 20
findings would bury the other 25 detectors.

`severity: 'soft'`. ⚠️ **Deliberately not `hard`.** Nothing is wrong with the books; stock is low and
nothing is on order, which is an operational prompt. `hard` blocks period close, and a close should
not be held for a reorder.

`drillTo`: `/inventory/low-stock`.

## Invariants

1. **A store with no active commissary link never appears.**
2. **An item on an open order — including `dispatched` — never appears.**
3. Same threshold predicate as `lowStock`: `<=`, and active items only.
4. One finding per store, never per item.
5. No bare `current_date`, no `Date.now()` — the T-218 guard covers `findings.ts`.
6. Registered in `findingsFor` and proven reachable through `listFindings`, not by calling the repo.

## Tests — both directions for each gate

- ⭐ **Fires** when a linked store has a below-threshold item and no open order at all.
- ⛔ **Silent** when the item is on a **`draft`** order.
- ⛔ **Silent** when the item is on a **`dispatched`** order. ⚠️ The noise case: goods in a truck.
- ⛔ **Silent** for a store with **no commissary link** — it cannot order.
- ⛔ **Silent** when on-hand is above threshold.
- ⚠️ **Fires** when the open order exists but carries a *different* item — an open order is not
  blanket cover.
- ⚠️ **Silent** for a `commissary_added` line with `requested_quantity is null` — the commissary
  proposing something is not the branch having ordered it.
- One finding per store when several items qualify.

⚠️ Integration on an isolated lane DB, announced first.

## Out of scope

- **Any change to `ensureAutoOrderLines` or T-223's wiring.** This observes; it does not repair.
- **A threshold-setting nag** — `itemsMissingThreshold` (`itemHasNoThreshold`) already covers items
  with no threshold at all, and this detector only sees items that have one. ⭐ Confirmed
  non-duplicate before adding, per T-213's precedent.

## Done when

- [ ] Detector ships, **registered**, both-direction tests including the dispatched-order case.
- [ ] Verified by breaking it: unregistering fails exactly the positive tests.
- [ ] typecheck · unit · integration (lane DB, stated) · build (dev server stopped) · smoketest
      `/findings` on 9008, stating plainly whether it fired on real data or not.
- [ ] DEF-186's follow-up closed in the register. Roadmap + this status line updated.
