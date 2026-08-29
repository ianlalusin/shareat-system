# T-178 — Order/channel wastage: the other thing called "wastage"

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-123 (sales day), T-150 (channel settlement — ⭐ the upload this reconciles
> against already exists), T-131 (AR), and Phase 5 for the staff-charge leg (§6).
> **v1 read at source** — `wastage.actions.ts` (1,573 lines), `src/types/wastage.ts:1-16`,
> `src/lib/wastage/settlement-match.ts`. `docs/discovery/14` §N.

## 1. ⚠️ Read this first: this is NOT stock wastage

**Two unrelated systems share one word**, and `docs/discovery/14` flags it as a trap:

| | `wastages/{id}` — **this task** | Raw-stock wastage — **T-168** |
|---|---|---|
| What is lost | A **cooked menu item** — a Foodpanda order refunded, a dine-in dish remade | Raw ingredients, spoiled or damaged |
| Stock effect | ⛔ **None at all** | Decrements stock, relieves layers |
| What it is | Order-economics reconciliation and staff accountability | Stock loss |
| Account | `5300` at the *order's* value, or a staff receivable | `5300` at FIFO cost |

⭐ v1's `WastageSource` type names `source:'inventory'` as *"Phase 2"* — **v1 itself planned a second
wastage system and never built it**, and every "raw stock wastage" capability actually lives in the
unrelated usage-record path. **Do not let "wastage" in a requirement default to the wrong one.**

## 2. Goal

A wasted or refunded channel order gets an owner, a decision and a posting — and none of them can be
left open indefinitely, because a backstop closes them and the platform's own settlement file says
who was actually right.

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| **Instant vs tracked type modes** — an instant type books straight to `booked`; a tracked one (channel orders) needs a disposition decision | ✅ |
| ⭐ **Default responsible party seeded at creation** | ✅ A tracked wastage always has a chargeable owner from the moment it exists — the store's assigned **Wastage Monitor** — so a manager **re-tags** the real person later rather than starting from nothing |
| Dispute → resolve → charge, with per-staff percentage allocation | ✅ |
| ⭐ **15-day auto-charge backstop** | ✅ Undispositioned after 15 days: the parked staff split if one was allocated, else the Monitor bears 100%, else the store absorbs it net-zero |
| ⭐ **The 15-day clock is UNIFORM, including disputed records** | ✅ **A carve-out exempting disputed records was deliberately REMOVED** — otherwise a dispute nobody resolves becomes a permanent way to dodge the backstop. **Do not restore it** |
| ⭐ **Settlement-match reconciliation** | ✅ Cross-references open tracked wastages against a parsed platform settlement, closing the gap the backstop has today: *"charges unconditionally, with zero awareness of whether the platform actually paid."* Human-confirmed, but not behind the full dispute+photo flow |

## 4. ⭐ What v2 already has that v1 did not

**T-150 built channel settlement**, and it parses exactly the file this reconciliation needs — the
Grab/Foodpanda payout with its signed deductions. v1 built its own separate upload path.

> ⛔ **Do not build a second settlement parser.** This task consumes T-150's parsed deductions and
> matches them against open wastages. One upload, two consumers.

⚠️ **And T-150 already establishes the rule that matters here:** channel fees net as a **signed**
total — *a promo day can legitimately produce a credit* — and are **never clamped at zero**
(§16.6). A platform-paid refund is a credit, and it must be allowed to be one.

## 5. Scope

**Create:** `packages/db/schema/order-wastage.ts` ·
`packages/db/migrations/<next>_t178_order_wastage.sql` ·
`packages/domain/src/wastage/orders.ts` ·
`packages/domain/src/wastage/settlement-match.ts` (pure) ·
`packages/db/src/repo/order-wastage.ts` ·
`apps/erp/src/app/wastage/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/order-wastage.test.ts` ·
`packages/domain/tests/unit/settlement-match.test.ts`

**Modify:** `packages/db/schema/stores.ts` (`wastage_monitor_person_id`) ·
`packages/domain/src/channel-settlements/index.ts` (expose parsed deductions) ·
`packages/domain/src/scheduler/index.ts` (the 15-day job — T-140 owns the scheduler) ·
`docs/POSTING-PATTERNS.md` · `tests/worked-examples/fixtures.ts` · barrels · `classification.ts` ·
`rls/registry.ts` · `CAPABILITY-MATRIX.md` · `repo/findings.ts` · `_journal.json` ·
`docs/ROADMAP.html`

## 6. The postings

| Disposition | Posting |
|---|---|
| **Absorbed by the store** | `Dr 5300` Wastage and spoilage · `Cr 1220` Channel receivable |
| **Paid by the platform** | ⛔ **Nothing.** The receivable is real and T-150's settlement clears it normally |
| **Charged to staff** | `Dr 1230` Advances to employees *(party: person)* · `Cr 1220` — split by the allocated percentages |
| **Split** | Both of the above, for their respective shares |

⭐ **`1220` is the credit in every case**, because the order was recognised as revenue with a channel
receivable behind it (T-123), and the question a wastage answers is **who ends up bearing it**.
⚠️ **Not `1210`** — a diner is not a customer (ADR-008 §11).

⚠️ **The staff-charge leg needs Phase 5's advance module.** If it is not built, the `charge` and
`split` dispositions are **refused with a named error**, and the 15-day backstop **falls back to
store-absorbed and says so on the record** — ⛔ never silently, and never by charging a person into
an account nothing can draw down.

## 7. Contract

```
order_wastages
  id, org_id, store_id, sales_day_id -> sales_days
  channel        text NOT NULL           -- grab | foodpanda | dine_in | ...
  order_ref      text NULL               -- the platform's order id
  type_mode      'instant' | 'tracked' NOT NULL
  amount         numeric(14,2) NOT NULL check (amount > 0)
  reason         text NOT NULL
  status         'open' | 'disputed' | 'resolved' NOT NULL default 'open'
  disposition    'platform_paid' | 'absorbed' | 'charged' NULL
  auto_charged   boolean NOT NULL default false     -- the backstop fired
  settlement_id  uuid NULL -> channel_settlements   -- matched, §4
  journal_entry_id uuid NULL
  opened_at, resolved_at, resolved_by, created_by
  check (status <> 'resolved' or disposition is not null)

order_wastage_allocations
  id, wastage_id (cascade), person_id -> persons
  percent numeric(5,2) NOT NULL check (percent > 0 and percent <= 100)
  unique (wastage_id, person_id)

stores  -- new column
  wastage_monitor_person_id uuid NULL -> persons
```

## 8. Invariants

1. **This module writes NO stock movement and consumes NO layer.** §1. A reviewer finding one has
   found the two systems conflated.
2. **A tracked wastage is created with a responsible party** — the allocated staff if any, else the
   store's Wastage Monitor. ⛔ Never created ownerless.
3. **Allocation percentages sum to exactly 100** when any exist. A DB-checked total, not a UI rule.
4. ⭐ **The 15-day clock runs from `opened_at` and applies to DISPUTED records too.** ⛔ The removed
   carve-out is **not** restored.
5. **The backstop's fallback order is: allocated split → Monitor 100% → store absorbs net-zero.**
   Exactly v1's, and the last branch is why an unassigned Monitor is not a failure.
6. **An auto-charge sets `auto_charged` and is reversible** by a manager for 30 days, as a reversal
   plus a new resolution — never an edit (invariant 5).
7. ⭐ **A settlement match never posts on its own.** A manager reviews each match and clicks
   *Mark paid* or *Charge staff*. v1's design and it is right: *human-confirmed, but not gated
   behind the full dispute+photo flow.*
8. **A wastage matched to a settlement that paid it resolves as `platform_paid` and posts nothing.**
9. **The matcher is pure and never writes** — it proposes; the human disposes.
10. **`charge` without Phase 5 is refused; the backstop degrades to absorbed and records that it
    did.** §6.
11. **Period lock applies**, including to the scheduled backstop. ⚠️ A cron posting into a closed
    period is §16.7 defect #6's exact shape, arriving through the back door.
12. **The 15-day job is idempotent** — a second run the same day charges nothing twice.

## 9. Tests

1. ⭐ **No stock moves:** every disposition asserted against unchanged on-hand and unchanged layers.
2. A tracked wastage created with no allocation gets the Monitor as responsible party.
3. Allocations of 60/30 are refused; 60/40 accepted.
4. ⭐ **The backstop at 15 days fires for a `disputed` record** — the test that pins the removed
   carve-out.
5. Backstop fallbacks: with an allocation, it charges the split; without one, the Monitor 100%;
   with no Monitor, store-absorbed net-zero. Three cases.
6. `absorbed` posts `Dr 5300 / Cr 1220`; `charged` posts `Dr 1230 / Cr 1220` split by percentage;
   `platform_paid` posts nothing.
7. A settlement match **proposes** and posts nothing until a manager confirms.
8. A matched-and-paid wastage resolves `platform_paid`, and T-150's settlement clears `1220`
   normally — asserted end to end, so the two modules are proved not to double-clear.
9. `charge` with Phase 5 absent is refused; the backstop degrades to absorbed and the record says so.
10. Reversing an auto-charge within 30 days writes a reversal and a new resolution; at 31 days it is
    refused.
11. The backstop run twice on one day charges once.
12. A backstop posting into a closed period is refused.
13. Live route on 9008: record a tracked wastage, dispute it, match a settlement, mark it paid.

## 10. Out of scope

⛔ **Raw-stock wastage.** T-168. §1.
⛔ **A second settlement upload or parser.** §4 — T-150 owns it.
⛔ **Settlement → HR infraction filing.** ✅ Already classified nice-to-have, deferred past cutover
(`CAPABILITY-GAPS.md`).
⛔ **The staff-advance module.** Phase 5.
⛔ **Photo evidence workflows for disputes.** T-141's file brokering exists; wiring an evidence
requirement is a control decision nobody has asked for — raise it, do not build it.

## 11. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE** for both tables; `wastage_monitor_person_id` is a **KEEP SHELL**
      column on `stores`. `rls/registry.ts` NULLIF-guarded.
- [ ] The 15-day job registered through **T-140's scheduler**, not a new cron path. ⚠️ v1's own
      lesson: a shipped scheduler that was never actually scheduled is DEF-044, and the same shape
      cost the holiday-calendar job a year.
- [ ] `docs/POSTING-PATTERNS.md` gains `wastage.order-absorbed` and `wastage.order-charged`, pinned
      by `fixtures.ts`. ⚠️ `npm run toc`.
- [ ] `orderWastageOpenPastBackstop` registered in `repo/findings.ts` — a wastage the job should
      have closed and did not is the tell that the job is not running.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `record_order_wastage`, `resolve_order_wastage`,
      `charge_staff_for_wastage`, `reverse_auto_charge` — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
