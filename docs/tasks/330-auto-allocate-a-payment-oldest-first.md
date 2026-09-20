# T-330 — a payment allocates itself across what is outstanding, oldest first

**Status:** SPEC — drafted by the orchestrator (`system32-df`), 2026-09-20. **Ordered by Ian.**
**Closes:** nothing. **Makes rare** what DEF-394 records as legitimate.
**Migration slot:** **none reserved yet** — `0155` is applied. Request one if a schema change proves needed.
**Depends on:** T-328 landing first. ⛔ **Do not start before it commits** — T-328 is live in `ap/index.ts`,
`ar/index.ts`, `ap/actions.ts` and `customers/actions.ts`, which are this task's core files.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `if (allocatedTotal > amount + 0.005)` | `packages/domain/src/ap/index.ts` — the one-directional check. ⛔ **DELIBERATE (DEF-394). Do not make it symmetric.** |
> | `if (allocatedTotal > amount + 0.005)` | `packages/domain/src/ar/index.ts` — same, in `recordCollection` |
> | `const surplus = Math.max(0, amount - allocatedTotal)` | `packages/domain/src/ar/index.ts` — the intended remainder treatment |
> | `export async function recordPayment(` | `packages/domain/src/ap/index.ts` |
> | `export async function recordCollection(` | `packages/domain/src/ar/index.ts` ⚠️ **NOT `trade/returns.ts`'s same-named function** |

---

## Ian's ruling, 2026-09-20 — both halves, verbatim in effect

1. **"Yes, allowed that payment more than allocated."** A payment MAY allocate less than it pays.
   ⛔ **The one-directional guard is therefore CORRECT and stays.** DEF-394 is closed as *ruled, not a
   defect*. **A future lane must not "fix" the asymmetry.**
2. **"Add auto allocate exhausting all payments to all outstanding balance covering oldest first."**
   This task.

⭐ **The two fit together:** the shortfall stays legal, and auto-allocation makes it *deliberate*
rather than accidental — the operator sees the payment consumed and any remainder named.

---

## Contract

### 1. Oldest first, and "oldest" is defined once

Allocate the payment across the counterparty's outstanding items in **ascending date order**,
consuming each in full before moving to the next, until the payment is exhausted or nothing is left
outstanding.

✅ **IAN RULED, 2026-09-20: MOST OVERDUE FIRST — order by DUE DATE ascending, earliest due date paid
first. Tie-break by INVOICE NUMBER.** ⛔ Not the invoice date, not `created_at`. His words: *"most
overdue first (i.e. by due date, earliest due date = most overdue = paid first), tie-break by
invoice number."*

⛔⛔ **BUT THE SCHEMA DOES NOT FULLY SUPPORT THAT RULE, AND THIS IS OPEN.** Measured against the live
column declarations, 2026-09-20 — **both keys are NULLABLE on both sides:**

| Side | Due-date column | Nullable? | Number column | Nullable? |
|---|---|---|---|---|
| AP | `supplier_invoices.due_date` | ⚠️ **YES** | `supplier_invoices.invoice_no` | ⚠️ **YES** |
| AR | `ar_charges.due_date` | ⚠️ **YES** | `ar_charges.reference_no` *(a reference, not an invoice no.)* | ⚠️ **YES** |

⭐ Each side has a NOT NULL date that is *not* the due date — `supplier_invoices.invoice_date` and
`ar_charges.charge_date`. So a fallback exists; **which fallback is a business decision, not a
coding one.**

✅✅ **ANSWERED — IAN RULED, 2026-09-20. THE ORDER IS NOW FULLY SPECIFIED:**

```
ORDER BY  due_date ASC  NULLS LAST,        -- undated bills go LAST (Ian's ruling)
          invoice_no ASC,                   -- his stated tie-break, where present
          created_at ASC                    -- final fallback: entry order (Ian: "no objection")
```

⭐ **`NULLS LAST` is the ruling, not a default.** He was given three options with their consequences
and chose it: a missing due date usually means nobody set a term, not that it is urgent. ⛔ The
rejected option — undated first — would have let *"we do not know when it is due"* outrank a bill
that is genuinely late.

⭐ **The `created_at` fallback is what makes the order DETERMINISTIC**, and it is the reason the
tie-break question did not need his time. `invoice_no` is free text and nullable, so it can be
absent, duplicated, or non-numeric — ⚠️ **and as TEXT it sorts wrongly: `INV-10` comes before
`INV-7`**, character by character. A tie-break that can itself tie leaves two runs of the same
payment allocating differently, which is the exact defect a tie-break exists to prevent.
⛔ **`created_at` is NOT NULL on both tables and cannot tie**, so the sort is total. ⚠️ **Do not
"improve" `invoice_no` into a natural sort** — that is a new rule nobody asked for, and the third
key already makes the order well-defined.

### 2. It is a SUGGESTION the operator can change, never a silent posting

✅ **IAN CONFIRMED, 2026-09-20:** *"fill in the amounts, don't auto-post — operator still has to
confirm/Save."* ⭐ He was offered the alternative explicitly and chose this. **Not an assumption
inherited from the spec's first draft — a ruling.**

⛔ **Auto-allocation proposes; the operator commits.** It fills the allocation boxes and the existing
path posts them. ⚠️ **It must not become a second write path** — one posting function, already
guarded, already tested.
⭐ **Reason it is not automatic:** a supplier may need a *specific* invoice settled, and oldest-first
would silently pay a different one. Ian asked for exhaustion, not for removing the choice.

### 3. The remainder is named, never hidden

If the payment exceeds everything outstanding, the leftover is shown **before** posting.
⭐ AR already books it (`surplus`, DEF-394-sanctioned). ⛔ **The operator must see the number first** —
DEF-394's whole mechanism was a remainder nobody was told about.

### 4. It reduces the typo surface, and that is a stated benefit

⭐ Auto-allocated amounts are **computed from outstanding balances, not typed.** T-328 exists because
a typed `3,000` was silently dropped. ⛔ **But the fields stay editable, so typed input remains
reachable — this does NOT retire any T-328 guard.**

## Invariants

1. **The sum of allocations never exceeds the payment.** The existing guard stays and must still fire.
2. **No allocation exceeds its item's outstanding balance.** Both modules already check this.
3. **A short allocation remains legal** (DEF-394) — ⛔ do not add an under-allocation guard.
4. **Money stays integer centavos / `numeric`.** ⛔ No float accumulation across items.
5. **One posting path.** Auto-allocation writes no rows itself.

## Tests

⛔ **Of each: what value would have to be wrong for this to go red, and does the code under test supply it?**

1. **Exhaustion:** payment equal to the sum of three outstanding items allocates all three to zero.
2. **Partial:** payment smaller than the oldest item allocates that item only, partially.
3. ⭐ **Order, with a control:** three items, deliberately created out of date order, must allocate
   oldest-first. ⛔ **Shuffle the insertion order** — an allocation that is correct only because rows
   came back in insertion order passes a test that proves nothing.
4. **Remainder:** payment exceeding everything leaves the exact surplus, and it is reported.
5. **Rounding:** a payment that cannot divide evenly leaves no centavo unaccounted.
6. ⛔ **The existing guard still fires** when an operator edits an auto-filled figure upward past the
   payment. Auto-allocation must not weaken it.

## Out of scope

- ⛔ **Making the reconciliation symmetric.** DEF-394 ruled: short allocation is legal.
- ⛔ Changing AR's surplus-credit posting. Ian confirmed it as intended.
- ⛔ DEF-383, DEF-393, T-328's GROUP 4.
- ⛔ Disputed/on-hold items, if the schema has such a concept — **report whether it does**; excluding
  them may be right and it is a business rule, not a coding choice.

## Done when

Every §9 gate: typecheck · unit · integration on a lane DB · `npm run build` with 9008 free ·
`/code-review` returned and triaged · `callers.mjs` clean · committed with a message saying *why* ·
**DEF-394 cross-referenced.** ⛔ **§9.4** — the screen, or UNMET in those words to Ian (bible row 203).
