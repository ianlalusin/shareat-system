# T-168 — Usage, wastage, adjustment: the busiest door in the domain

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-160, T-161, T-162, T-164 (which owns the postings this task triggers).
> **v1 read at source** — `general-inventory.actions.ts` (the single busiest file, 8 transaction
> sites), `meat-usage.actions.ts`, `reserved-usage-categories.ts`. `docs/discovery/14` §B, §I.

## 1. Goal

Anyone on the floor can record what was consumed or spoiled, a manager posts it, and the stock and
the books move together — with the one mislabel that silently destroys stock made impossible.

## 2. ⭐ v1 keeps two of these and v2 keeps one

v1 has **two parallel implementations**: `general-inventory.actions.ts` for items and
`meat-usage.actions.ts` for meat products, each with its own draft/post/void lifecycle, its own
race guard, and its own copy of the same rules. The split exists because `meatProducts` and
`inventoryProducts` were separate collections — a duality **v1 itself was already retiring**
(`types/item.ts:3`, *"Single source of truth for all item types… Replaces the split"*).

⭐ **T-145 already finished that migration: one `items` table, `kind` including `meat_slab` and
`meat_sliced`. So there is one usage path here, not two** — and the meat-specific rules become
rules about a `kind`, not a second module.

⚠️ **One consequence, and it is a fix rather than a port:** v1 blocks POS mapping for meat because
`meatUsageRecords` carries no `locationId`. In v2 every movement carries one (T-161), so **the
exclusion is not inherited** (T-177, phase plan §6.3).

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| **Draft → post → void.** Posting is the only step that moves stock | ✅ A floor worker records; a manager (or a PIN'd local user) posts |
| ⭐ **A usage record labelled `transfer` is REJECTED outright** | ✅ **The usage flow writes only an OUT leg — a mislabelled transfer destroys stock instead of moving it.** Shared client+server guard; the server one is the control |
| ⭐ **Usage may only draw from an `operating` location** | ✅ A storage room cannot be a usage source (T-160 invariant 3) |
| **Equipment exemption from the threshold gate** | ✅ Kitchenware is not a consumable: no threshold required, no replenishment fired |
| **Manual adjustment (+/−) with a typed reason** | ✅ For when neither a delivery nor a usage explains a discrepancy. `can_adjust_inventory` |
| **Opening / initial inventory set, edit, reset** | ⚠️ **Narrowed** — see §7 |
| **Wastage charged to a staff member, atomically** | ✅ Same transaction as the stock movement. No orphan charge, no orphan wastage |
| ⭐ **Balance read inside the transaction** | ✅ T-161 §3 — the two named drift bugs |
| ⛔ Hard low-stock-threshold requirement before posting | **Ask Ian.** §7 |

## 4. Scope

**Create:** `packages/db/schema/stock-usage.ts` ·
`packages/db/migrations/<next>_t168_stock_usage.sql` ·
`packages/domain/src/stock/usage.ts` · `packages/domain/src/stock/reserved-categories.ts` ·
`packages/db/src/repo/stock-usage.ts` ·
`apps/erp/src/app/inventory/usage/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/stock-usage.test.ts` ·
`packages/domain/tests/unit/reserved-categories.test.ts`

**Modify:** barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
stock_usage_records
  id, org_id, store_id, location_id -> stock_locations
  kind        'usage' | 'wastage' | 'adjustment' | 'opening'  NOT NULL
  status      'draft' | 'posted' | 'void' NOT NULL default 'draft'
  used_on     date NOT NULL
  department_id  uuid NULL -> departments        -- attribution, usage only
  reason_code    text NULL                       -- WASTAGE_REASONS; required for kind='wastage'
  adjustment_reason text NULL                    -- free text; required for kind='adjustment'
  charge_person_id  uuid NULL -> persons         -- wastage only
  posted_at, posted_by, voided_at, voided_by, void_reason
  created_by, created_at
  check (kind <> 'wastage'    or reason_code is not null)
  check (kind <> 'adjustment' or adjustment_reason is not null)
  check (charge_person_id is null or kind = 'wastage')

stock_usage_lines
  id, record_id -> stock_usage_records (cascade)
  line_no, item_id, quantity numeric(14,3) NOT NULL   -- SIGNED only for kind='adjustment'
  movement_id uuid NULL -> stock_movements
  unique (record_id, line_no)
```

```ts
saveDraft / addLine / removeLine / deleteDraft
postUsageRecord(id): Promise<PostResult>     // the only step that moves stock
voidUsageRecord(id, reason): Promise<void>
```

## 6. Invariants

1. **A draft moves nothing.** No movement, no layer, no entry until `postUsageRecord`.
2. ⭐ **A usage or wastage record whose category, reason or note resolves to a reserved
   `transfer` synonym is REFUSED, server-side.** The synonym list is shared with the client, and
   the client copy is a convenience — the server one is the control.
3. **A `usage`/`wastage` line must have `quantity > 0`.** Only `adjustment` accepts a signed
   quantity, and only with `can_adjust_inventory`.
4. **The source location must be `operating`.** ⚠️ And where a store has any active operating
   locations, `location_id` is **required** — v1 closed a real drift hole here where the store
   balance moved and the per-location balance did not.
5. **Posting calls T-164** — `postConsumption` for `usage`, `postWastage` for `wastage`,
   `postCountVariance`-equivalent for `adjustment` — and does not compute cost or choose accounts
   itself. One implementation of the posting rules, not a second copy.
6. **Wastage with a `charge_person_id` posts the salary-advance charge in the same transaction**,
   or the whole post fails (T-164 invariant 9).
7. **Void reverses stock, layers and entry in one transaction, and voids a linked staff charge
   FIRST** — so a failure never leaves a reversed stock movement standing beside an un-reversed pay
   deduction. ⭐ The ordering is v1's and it is deliberate.
8. **Equipment-kind items need no low-stock threshold** and fire no replenishment.
9. **A void is terminal.** A voided record is never re-posted; a correction is a new record
   (invariant 5).
10. **Period lock applies to post and to void.**
11. **A frozen location (T-169) refuses a post**, with an admin-only bypass that is itself audited.

## 7. ⚠️ Two questions for Ian, raised rather than decided

### 7.1 The threshold forcing function

v1 **refuses to post usage for a meat item until someone has configured its low-stock threshold** —
a forcing function that makes every trackable item get a reorder point. `docs/discovery/14` §B
flags it: *"is this a rule Ian wants preserved, or was it a workaround for a different problem?"*

**Recommendation: do not port it.** It couples a *reporting* setting to an *operational* action,
and the failure mode is a kitchen unable to record what it used at 11pm because a setting was never
filled in. **The need it serves is real** — items without thresholds never appear in low-stock —
and T-175 serves it better: a **finding** listing items with no threshold, which nags a manager
instead of blocking a cook. ⭐ **Built as recommended; say so plainly, and it is one line to
restore if Ian disagrees.**

### 7.2 Opening / initial inventory

v1 lets a manager set, edit and reset an opening balance per item at any time. **v2 narrows this
to the cutover**: `opening_counts` + T-134 own the 2027-01-01 opening, and row 106 says v2 always
starts from zero. ⭐ **What survives is a NEW STORE's opening balance** — a store joining after
cutover genuinely needs one, `kind='opening'`, admin-only, posting against `3900` per T-134's rule.
⛔ **Edit and reset do not survive**: an opening balance that can be re-typed after postings exist
is a plug, and `balanceadjustment.plug` is in `POSTING-PATTERNS.md` specifically so nobody ports it
forward.

## 8. Tests

1. A draft moves nothing: on-hand, layers and entries are all unchanged until post.
2. Posting 5 kg of usage writes one movement, consumes FIFO layers, and posts `Dr 5110 / Cr 1310`
   at the FIFO cost — cost asserted, not just the presence of an entry.
3. ⭐ A record with category `transfer` is refused — asserted for **every** synonym in the reserved
   list, as a table-driven test.
4. Posting from a `storage` location is refused; from an `operating` one, accepted.
5. In a store with operating locations, a record with no `location_id` is refused.
6. Wastage with `reason_code = 'spoilage'` posts `5300`, never `5110`.
7. Wastage with a charge posts both legs; forcing the charge to fail rolls back the stock movement.
8. Void reverses stock and entry, and voids the staff charge **first** — asserted by ordering, with
   a forced failure after the charge void leaving no reversed stock.
9. An adjustment of −3 by a user without `can_adjust_inventory` is refused.
10. A post into a closed period is refused.
11. A post into a frozen location is refused; an admin bypass succeeds and writes an audit row.
12. Re-posting a voided record is refused.
13. Live route on 9008: draft on one screen, post on another, and see on-hand and the P&L move.

## 9. Out of scope

⛔ **The posting rules themselves.** T-164 owns account choice, cost and the period lock.
⛔ **A second meat-specific module.** §2 — one path, `kind` is a column.
⛔ **Order/channel wastage.** T-178. Different system, same word (phase plan §6.1).
⛔ **Low-stock listing and auto-order.** T-175.
⛔ **Production conversion.** T-176 — an input *and* an output, which is a different shape.

## 10. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded.
- [ ] §7.1 and §7.2 built as recommended, and **both raised in the task report's `FOR IAN` block**
      — a decision taken by a spec is still a decision Ian gets to see (§3.5).
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `post_usage`, `can_adjust_inventory`, `can_charge_staff`,
      `void_usage_record`, `bypass_count_freeze` (admin) — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
