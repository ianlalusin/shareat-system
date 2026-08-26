# T-139 — Money transfers: moving money between the places it sits

> **Status:** ✅ **BUILT, 2026-08-26.** Written before implementation (bible §1.2a, "no implementation
> without a written task spec").
> **Depends on:** T-1xx money accounts (ADR-010, bible rows 142–149), `postEntry`/`reverseEntry`.
> **Related:** T-136 cash custody (remittance is ONE transfer, specialised), bible row 150.

## Ian's brief

> *"Each account can move money in any direction — cashier cash to cashier online, office to
> office, office to cashier, cashier to office, depending on transaction. Office gave cashier
> additional petty cash via cash request, debit/credit on both ledgers."*

and, on who may do it:

> **Ian, 2026-08-26:** *"yes manager level money transfer."*

---

## 1. Why this is its own document and not part of T-136

T-136 is about **remittance** — a specific, governed transfer with a sales day behind it, an
expected figure to reconcile against, and a shortage rule. This is the **general** case: any money
account to any other, in any direction, for any reason a person can name.

⭐ **Remittance is a transfer with extra obligations, not a different mechanism.** Both end up as
the same two balance-sheet legs. Keeping the general case separate means the specialised one can
add its rules without the ordinary "top up the till from the safe" having to satisfy them.

## 2. The posting — already documented, already verified

`docs/POSTING-PATTERNS.md` §Transfer, **926 legs, the 4th most-used entry in v1**. Do not
re-derive it:

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| destination GL | amount in | | `money_account` **iff** GL is `1140` |
| fee account (only when a fee applies) | fee | | — |
| source GL | | amount out | `money_account` **iff** GL is `1140` |

⚠️ **The pattern doc's own trap, repeated here because it is the one that bites:** *"do not assume
every transfer is P&L-free."* A bank or cash-out fee is a real expense. The entry balances whether
or not you include the fee leg — **only the account would be wrong** — so nothing fails loudly.

## 3. ⭐ The decision this task exists to make: what does "amount" mean?

v1's builder takes `amount` = *what arrives*, and charges the source `amount + fee`.
`POSTING-PATTERNS.md`'s worked example narrates the same three legs as *"a ₱10,000 transfer that
costs ₱50, so only ₱9,950 lands"* — i.e. `amount` = *what leaves*.

**The legs are identical either way; the two readings differ only in what a person types.** But
that is not harmless: the same figure in the same box produces two different transfers, and both
are plausible in this business —

| Real case | What actually happens |
|---|---|
| Bank wire | You send ₱10,000, the bank debits ₱10,050. **Fee is added to the source.** |
| GCash cash-out | You cash out ₱10,000, you receive ₱9,950. **Fee is deducted from the target.** |

⭐ **So the resolution is to refuse the convention entirely: the user states BOTH figures.**
`amount_out` (what left the source) and `amount_in` (what reached the destination). The **fee is
derived** as `amount_out − amount_in`.

Why this is the right answer and not extra typing:

1. **Both numbers are observable facts.** The source statement shows one; the destination shows
   the other. They are exactly the two figures a person is reconciling against — which is what
   makes the transfer checkable at all.
2. **There is no convention left to misremember**, so the wire case and the cash-out case are
   entered the same way and neither needs mental arithmetic.
3. **The fee is derived, not stored** — the same rule this project applies to every other figure.

⛔ `amount_in > amount_out` is **refused**. Money arriving that never left is not a transfer;
it is income, and it must not be enterable here.

## 4. The case is stored; the figures are derived

A `money_transfers` row records what a human asserted and the ledger cannot reconstruct:

⚠️ **The reason a table is needed at all is narrow and worth stating**, because "derive it from
the journal" is usually right here: a **cash** leg posts to `1110`/`1120`/`1130` with **no party**
— the GL code is the location — so *which named account* moved is not recoverable from a cash-to-
cash entry's legs. It survives only because the service refuses a second cash location per
custodian per store, which is a constraint that could reasonably be relaxed later. The reference
number, the note, and who moved it are not in the ledger either.

Stored: `from_money_account_id`, `to_money_account_id`, `amount_out`, `amount_in`, `fee_account_code`,
`transfer_date`, `reference`, `notes`, `journal_entry_id`, `status`, and the void pair.

⛔ **Not stored:** any balance, any running total, and **no `fee` column** — it is
`amount_out − amount_in`, and a stored copy is a second source of truth for a figure that already
has one.

## 5. Rules

1. `transfer_funds` (store-scoped, manager and up — bible row 150). Every ✗ needs a denial test.
2. Source ≠ destination. v1 enforces this; so do we.
3. Both accounts **active**, both in the actor's org. A retired account cannot be either end —
   it is exactly the "strand the money" case retirement already guards.
4. ⭐ **Cross-store is allowed, OFFICE TO OFFICE ONLY** — ✅ **DECIDED, Ian 2026-08-26**
   (bible row 152), replacing this task's original blanket refusal.

   > *"A manager of lipa and malvar who is not allowed to get remittance is able to collect money
   > from malvar to spend on lipa, but that's deeply wrong. The right pattern is malvar remits to
   > office first before lipa can use it."*

   The abuse is a manager reaching into another store's **till**, so the fix is not to ban
   cross-store movement — the business genuinely needs it — but to force it through the office.
   A cashier or staff account at either end is refused, which makes the bypass *unrepresentable*
   rather than merely discouraged. The entry gets the `1250`/`2150` due-from/due-to pair, the same
   four-leg shape `commissary_dispatch.transfer` already uses, so it eliminates on consolidation.

   ⚠️ **Still open, and bigger:** the rest of Ian's scenario — Malvar office cash funding a *cash
   request* whose liquidated **expense belongs to Lipa**, with any return going back to Lipa.
   Cash requests do not exist in v2 yet. This transfer is the foundation they will sit on, not a
   substitute for them.
5. ⛔ **No overdrawing** — ✅ **DECIDED, Ian 2026-08-26**: *"for transfer block overdraw."* An
   account cannot send more than the ledger says it holds. ⚠️ Not applied to a reversal: refusing
   one would leave a wrong entry uncorrectable.
6. `amount_out > 0`, `amount_in > 0`, `amount_in <= amount_out`.
7. Fee > 0 requires a fee account; defaults to `6870` Bank charges.
8. Idempotency key `transfer:{id}:post`; reversal `transfer:{id}:void`.
9. Void reverses through `reverseEntry` — never a hand-written opposite entry, never a delete.

## 6. Done when

- [x] `money_transfers` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [x] Repo + service (create · void), gated on `transfer_funds`.
- [x] Integration tests: the three-leg fee case, the party-on-1140 rule, each refusal in §5, a
      denial test per role that lacks the capability, and a proof that no `fee` column exists.
- [x] Screen, driven end to end in a browser — ₱10,000 out of the cashier drawer, ₱9,950 into BDO, ₱50 to 6870, then reversed; every balance returned to its starting figure.
- [x] Gates: typecheck · unit · integration.
