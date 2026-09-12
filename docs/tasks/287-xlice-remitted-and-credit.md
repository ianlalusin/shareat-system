# T-287 — Xlice: remitted daily AND settleable on credit

> ⚠️ **SPEC ONLY. No code in this task yet.** Needs a migration slot, which is not allocated
> (0145 is lane A's, 0146 is earmarked for T-276). Task number provisional.

**Ian, 2026-09-12:** *"Xlice is a sales channel that is remittable daily but also can be settled as
credit - AR how do i set that up?"*

## ⭐ The short answer: the database already allows the channel half. The day-record does not.

`sales_channels_non_remitted_needs_receivable_check` (`packages/db/schema/sales-days.ts:152`) reads:

```sql
is_remitted_daily = true or receivable_account_code is not null
```

It **requires** a receivable account when the channel settles later. It does **not forbid** one when
the channel is remitted daily. So a channel that is both is already legal at the schema level, and
no constraint has to be widened.

Two things block it in practice:

1. **The form says the opposite.** `/settings/sales-channels` labels the field *"— none (only valid
   when it reaches the till) —"*, which reads as a prohibition, and the page's own copy frames the
   choice as exclusive: *"whether its money reaches the till on the day **or** is owed to us."*
2. **A sales day records ONE number per channel.** `sales_day_channels` holds `amount` and
   `noSales` and nothing else, so there is nowhere to say *how much* of today's Xlice take was cash
   in the drawer and how much went out on credit.

## ⛔ What this task must NOT do: add a third state to `is_remitted_daily`

That flag is described in the schema as *"the single most load-bearing field here"* — it decides
whether a channel's money is part of expected remittance at all, and every remittance, till and
reconciliation path reads it. Widening it to a three-way would touch all of them to express
something that is **not a property of the channel**.

⭐ **The repo already knows the axes are orthogonal and says so.** `sales_day_tenders`' header:

> *"They are orthogonal axes and a day needs both: `sales_day_channels` answers where the sale came
> FROM; this table answers where the money WENT. A Foodpanda sale can settle into any wallet, so
> neither answers the other's question."*

`is_remitted_daily` is a third thing that conflates them — a channel-level constant standing in for
a per-transaction fact. Xlice is simply the first channel where the conflation shows.

## The design

### 1. The channel declares it may go on credit — no schema change

Xlice is `is_remitted_daily = true` **with** `receivable_account_code` set (`1220` in practice).
The form stops presenting the two as exclusive, and the receivable field's helper text becomes
*"required when it settles later; optional when it reaches the till, for a channel that can also
sell on credit."*

### 2. The day splits what was collected from what was booked

`sales_day_channels` gains `receivable_amount numeric(14,2) not null default 0`, with:

```sql
check (receivable_amount >= 0)
check (receivable_amount <= amount)
check (no_sales = false or receivable_amount = 0)
-- a channel may only book a receivable if it has somewhere to book it
check (receivable_amount = 0 or <channel has receivable_account_code>)  -- trigger, not CHECK:
                                                                       -- it crosses tables
```

Expected remittance for the day becomes `sum(amount - receivable_amount)` over remitted channels —
**today's behaviour is preserved exactly**, because `receivable_amount` defaults to 0 on every
existing row.

### 3. ⭐ The credit half becomes an `ar_charge` against a named customer

Ian confirmed the debtor is a **named customer**, not a platform settling in bulk. So the credit
portion is not a floating number on a sales day — it is a charge in the AR module that already
exists (`ar_charges` / `ar_collections` / allocation / write-off, keyed by party), which brings
ageing, collection and allocation with it at no design cost.

⛔ **This is why `receivable_amount` alone is not sufficient** and the task is not "add a column":
a receivable with no party is exactly v1's `unallocatedAmount` — *"money tied to nothing on 38
collections, no way to re-apply"* — which `ar.ts`'s header lists as one of four things refused here.
**The submit form must name the customer, and the posting must create the `ar_charge`.**

⚠️ **Therefore the amount cannot be a single figure per channel per day.** One day may sell to two
customers on credit. The honest shape is a child row per (sales day, channel, customer), and
`receivable_amount` on `sales_day_channels` is then a derived total rather than the source. **This
is the main open design question and it should be settled before implementation, not during.**

## Open questions for Ian

1. **Can one Xlice day carry credit sales to more than one customer?** If yes, the child-row shape
   above is required and this task grows. If it is always one account, the simpler column stands.
2. **Who confirms the credit half — the cashier submitting the day, or a verifier afterwards?**
   It creates a receivable, which is money owed; the submit/verify split already exists for sales
   days and should probably govern this too.
3. **Does POS already capture this?** `sales_day_tenders`' header records that a previous gap was
   closed by noticing *"the cashier POS has this — it defines which mode of payment is used by
   customer."* ⭐ **Read `webapps/POS` before designing the capture UI** — RULES §3, and the same
   check shrank T-274.

## Files a future implementation would touch

`packages/db/schema/sales-days.ts` · a new migration · `packages/db/src/repo/sales-days.ts` ·
`packages/domain/src/sales-days/**` · `packages/domain/src/ar/**` ·
`apps/erp/src/app/sales-days/**` · `apps/erp/src/app/settings/sales-channels/**`
