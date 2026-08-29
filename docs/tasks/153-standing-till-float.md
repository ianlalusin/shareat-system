# T-153 — The till float: a side pocket, not a balance

> **Status:** ⚠️ **SPEC, 2026-08-29 — REWRITTEN after Ian corrected the model.** An earlier version
> of this document concluded *"no build required"*. **That was wrong**, and §2 keeps the error and
> its cause rather than quietly deleting them. Recover it at `97919a0` if the reasoning is ever
> needed.
> **Requirements:** Ian, 2026-08-29. **Related:** T-136 §2 (imprest), T-136 §8.4, DEF-085.

## 1. What it actually is

> **Ian, 2026-08-29:** *"The money is from office/admin. **It's not part of the sales that is not
> remitted.** This is extra cash float that is not remitted to the manager or admin — it sits on
> till forever. The staff just makes sure if the configured budget is 20k, every day opening and
> closing it is 20k. It is **separated** from the money being remitted. **It's on a side pocket of
> the cashier.**"*

Five things, each load-bearing:

| | |
|---|---|
| **Where it comes from** | Office / admin — an injection, not retained takings |
| **Where it lives** | ⭐ A **side pocket**. Physically segregated from the day's cash |
| **How long** | Forever. It is never remitted |
| **What is checked** | Opening **and** closing, every day, it equals the **configured** amount |
| **Per store** | The configured amount **varies** (Ian, 2026-08-29) |

## 2. ⛔ What this document said before, and why it was wrong

The previous version modelled the float as *"the amount of the drawer that is not remitted"* and
concluded it needed **no code at all**: remit the day's movement, and whatever the drawer started
with is still sitting there.

**The arithmetic was right and the model was wrong.** Ian: *"no, you read it wrong."*

⭐ **The error was treating a physical fact as an accounting residue.** *"Not remitted"* describes
what **happens** to the float; it is not what the float **is**. Under the old reading the float was
an emergent property of the takings account — whatever happened to be left over. Under the real one
it is a **separate pot with its own invariant**, and the takings never touch it.

⚠️ **Three conclusions died with it**, each recorded because each was argued at length:

1. *"No separate account — a peso in a drawer carries no label."* **It does carry a label: the side
   pocket.** The argument was sound for commingled cash, and the cash is not commingled.
2. *"No `float_amount` column — it would be a second source of truth."* **That conflated a
   duplicate with a target** (§5).
3. *"Varying amounts change nothing."* True only if the float is a residue. For a configured pot,
   the per-store amounts **are** the configuration.

⭐ **What survives, and is still why this matters:** the books do not know the money exists.
₱20,000 sits in a till and nothing recorded it going there, so cash is understated at the store and
overstated at the office, permanently, for every store with a float.

## 3. ⭐ The structure

### 3.1 A new GL account — `1115 Cash on hand — till float`

```
1110  Cash on hand — cashier         the day's takings
1115  Cash on hand — till float      ⭐ NEW — the side pocket
1120  Cash on hand — staff custodian
1130  Cash on hand — office
```

**Why its own account rather than a corner of `1110`:** a cash account answers *"where is the
money"*, and Ian's answer is that this money is somewhere else — a different pocket, counted
separately, on a different rule. Three things follow that a shared account cannot give:

1. ⭐ **Its balance is an INVARIANT.** `1115` for a store should *always* equal that store's
   configured float. Any other number is a finding, found by comparing two figures rather than by
   reading history. **The control becomes arithmetic, not diligence** — the exact property
   T-136 §2 admired in the imprest pattern.
2. ⭐ **`1110` stays purely takings**, so remittance cannot sweep the float even by accident and
   the remittance arithmetic needs no special case.
3. **The float becomes a figure the business can total.** *"How much of our cash is tied up in
   tills?"* is one balance rather than a reconstruction.

### 3.2 One money account per store — and the model already allows it

⭐ **No schema change is needed to hold a second cashier-cash account.** The rule that would have
blocked it is **partial**:

```ts
uniqueIndex('money_accounts_foundation_unique')
  .on(t.storeId, t.instrument, t.custodian)
  .where(sql`${t.isFoundation}`)          // ⭐ foundation accounts only
```

So the float pot is an ordinary **non-foundation** money account: `instrument: 'cash'`,
`custodian: 'cashier'`, `glAccountCode: '1115'`. The custodian genuinely is the cashier — they hold
it — so neither the enum nor the index is touched.

### 3.3 The configured amount lives on that money account

A nullable `float_target numeric(14,2)` on `money_accounts`. **Non-null marks the account as a float
pot**; every other money account leaves it null.

⚠️ It belongs on the money account rather than on `stores` because the **pot** is the thing with a
target, and a store with two tills would have two. That is the opposite of T-152's ceiling, which is
a store-wide risk limit and correctly lives on `stores`.

### 3.4 The postings, and there are only two

**Establishing or resizing the float** — office to side pocket:

```
Dr  1115  Cash on hand — till float   20,000.00
    Cr  1130  Cash on hand — office             20,000.00
```

Two asset legs; nothing touches profit. An ordinary `createMoneyTransfer`.

**At cutover** the cash is already in the pocket, so it is counted rather than moved:

```
Dr  1115  Cash on hand — till float   20,000.00
    Cr  3900  Opening balance equity            20,000.00
```

⛔ **That is the complete list.** The float is never remitted, never swept, never part of a sales
day, and a shift handover posts nothing (§6).

## 4. ⛔ The rule that must be enforced: a float account is not remittable

`createRemittance` requires `from.custodian === 'cashier'`, and the float pot **is** custodian
`cashier`. Without a further rule it would appear in the remittance picker and could be handed to
the office — the one thing Ian says never happens.

**So a money account with a non-null `float_target` may not be a remittance source**, refused in
`createRemittance` with a denial test. ⚠️ A service-layer rule rather than a database one, because
it governs *which document may move the money*, not whether a value is valid.

## 5. ⭐ A target is not a duplicate — correcting my own objection

The previous version refused a configured amount because *"recording an intended amount beside the
real one creates the second source of truth rows 143/145/147 refuse."*

**That misapplied the rule.** Those rows forbid storing a **copy of a figure the ledger already
computes** — a cached balance, a maintained total — because the copy drifts and the two then
disagree about the same pesos.

⭐ **A target is not a copy of the actual. It is the other operand of the comparison.**
`balance ≠ target` is not drift to be prevented; **it is the finding.** T-152's un-remitted ceiling
is the same shape — a configured number a derived position is measured against — and nobody would
call that a second source of truth.

## 6. Shifts, unchanged by the correction

> **Ian:** *"1 store 1 till. Most is 2 shifts, 1 morning 1 evening, same till."*

v1 models this as `CashRemitShiftPlain` (`types/index.ts:1443`), whose `opening.source` is
`'float' | 'manual' | 'handover'`, with `prevShiftId` chaining one cashier to the next.

⛔ **A shift handover posts nothing.** Same pocket, same store, same account. What moves is
**responsibility**, and responsibility is not a ledger fact.

⚠️ **v2 has no shift record at all** (capability gap, 2026-08-29), and it matters here: Ian's
*"opening and closing it is 20k"* is a **per-shift** check, and the ERP has nowhere to record
either count.

## 7. Franchise stores

> **Ian:** *"All stores, even franchisee."*

v2 models a franchise as its **own org** (ADR-008 §7, correcting DEF-050), so a franchisee's float
is its own money from its own office — the same two postings in that org's books, no cross-entity
due-from. ⚠️ Padre Garcia is not an org in v2 yet, so its float cannot be recorded until it is.

## 8. Where it belongs: the ERP, with POS reading it

Unaffected by the correction. The **counting** belongs at the till and POS already does it
(`cashHandovers`); the **record** cannot live there — it is real company cash, Postgres is the sole
system of record (bible §2.3), and *"maintained"* needs an expected figure the count is checked
against, which fails silently if the amount and the cash live in different systems. ⛔ This project
also cannot write to POS: the reference repos are READ-ONLY.

## 9. Scope

**In:**

1. `1115` seeded in the chart. ⚠️ Trips the pinned account count (**100 → 101**) — the guard
   working.
2. `money_accounts.float_target`, nullable, positive when set.
3. A float money account per store, created **on demand** rather than seeded (§below).
4. `createRemittance` refuses a float account as a source, with a denial test.
5. A `tillFloatOffTarget` detector in T-135's layer: `balance ≠ float_target`.
6. Setting or resizing the target gated on **`set_cash_policy`** — T-152's admin-only capability.
   Same class of decision, and Ian named admin for that one.

**Out, with reasons:**

| Out | Why |
|---|---|
| The per-shift opening/closing count | ⛔ **There is no shift record in v2** (§6). The detector compares the ledger balance to the target, which catches a float spent or never funded. Catching *"the cashier counted 19,500 this morning"* needs the count, and the count needs the shift |
| A float release/return document | It sits forever. A transfer resizes it; nothing else moves it |
| Auto-creating a float for every store | The amounts vary and some stores may have none. A phantom ₱0 pot would be a finding waiting to fire |

## 10. Open for Ian

1. **The configured amount per store** — needed to create each pot, not to build this.
2. ⚠️ **When the float is short, what then?** The ledger will show `1115` below target and raise a
   finding. Whether the shortfall is charged to a cashier, topped up from office, or written off is
   the same three-way decision T-143 made for remittance variances — and it is Ian's.
