# T-144 — Cash requests: a float handed to a person, and what comes back

> **Status:** ✅ **BUILT** — migrations `0034`, `0035`, `packages/domain/src/cash-requests/`,
> `/cash-requests`, integration tests. Spec written 2026-08-27 before implementation (bible §1.2a);
> the status line was never updated on shipping and said `SPEC` until 2026-08-29 (T-136 §9.1).
> **Unblocks:** T-136 §2 (the imprest fund's replenishment needs this document to gate against) and
> the cross-store half of bible rows 152–153.
> **Postings already verified:** `POSTING-PATTERNS.md` §Cash request — **82 release legs, 52 return
> legs** from real v1 data.

## 1. What it is

Money handed to a **person** for an errand — a market run, a permit fee — spent, and then
reconciled. ⭐ **It is not an imprest fund.** An imprest fund holds a fixed standing balance and is
replenished; this holds **zero** between requests, which is why the ERPNext migration's four
postings all net to nothing when the request closes (T-136 §5b).

## 2. The postings, and the one that is already built

```
release   DR 1120 staff float   CR the funding account      ← this task
spend     DR the expense        CR 1120                     ← T-122 ALREADY DOES THIS
return    DR the funding acct   CR 1120                     ← this task
shortage  DR staff advance      CR 1120                     ← this task
                                        → 1120 nets to ZERO
```

⭐ **The spend leg exists.** `expense_payments.cashRequestId` is already there, and its comment says
why: *"presence alone routes a cash payment to 1120 instead of 1110."* This task supplies the
document that column has been pointing at.

⚠️ **The request itself posts NOTHING** (bible §16.10). Asking for money is not a financial event;
only the release is. A system that posted on request would show a float in someone's hands before
anyone handed it over.

## 3. ⭐ 1120 gains a party, and the party is the REQUEST

`POSTING-PATTERNS.md` records that in v1 *"1120 is **not** a `requires_party` account — it is a
plain asset, not a control account with a subledger."*

⛔ **That is the shape v2 should improve — but state the reason precisely, because the loose version
is false.** v1 DOES name the holder: `requesterName` and `requesterUid` are on the request document.
What v1 cannot do is answer from the LEDGER. One store has one Staff-float account (T-142), two
people can hold floats at once, and one person can hold two — so ₱2,000 with Ana and ₱3,000 with Ben
is one ₱5,000 balance at 1120, and "how much is still out, against whom?" means joining back to the
requests. ⛔ **Which is why v1 stores `remainingAmount` on the document**: the figure lives there
because the ledger could not produce it — a stored number beside a ledger, the shape that drifted
into three registers in v1's loans.

⭐ Same reasoning as row 142 (the wallet) and row 158 (the loan): **`party_type = 'cash_request'`,
`party_id = the request**. And the column to carry it on the spend leg already exists.

## 4. States, and which ones are DERIVED

`requested` → `approved` | `rejected` → `released` → `liquidated` | `cancelled`

⭐ **`liquidated` is derived, not stamped**: it is true when the float's ledger position reaches
zero — spent, returned and short accounted for. ⛔ v1 stores `remainingAmount` and
`varianceAmount`; both are subtractions of things the ledger already knows.

⚠️ **`decisionLocked`** is worth porting as behaviour rather than a column: once released, the
approval cannot be edited. Money has moved; changing the decision behind it rewrites history.

## 5. ⚠️ It already interacts correctly with remittance, and that is not an accident

Ian's own definition of what a cashier owes: *"out = expense with payment from cashier, **cash
request released by cashier**, salary advance released by cashier."*

⭐ A release credits `1110`, so it **reduces the cashier's net movement for that date** — which is
exactly what T-143's end-day report sums. **Nothing needs adding.** The figure was right before
this document existed, because the report asks the ledger what the cashier holds rather than
enumerating document types (bible rows 145, 157).

## 6. Scope

**In.** The `cash_requests` table · request · approve/reject · release from a named money account ·
return · shortage · the derived float position and status · screens.

**Out, and named so the omissions are decisions:**

- ⛔ **Cross-store release** (Malvar's office funding a Lipa float). The pieces exist — rows
  152–153's both-stores gate and the `1250`/`2150` pair, built and tested in T-139 — but it is a
  second slice, and a single-store request that works beats a cross-store one that half does.
- ⛔ **`releaseCashSourceMode` (`envelope` | `till`).** ⚠️ v1 carries a landmine here: absent
  *"is treated as `'till'` by the sales-report auto-deduction filter, preserving legacy behavior"* —
  another field where missing means something. **Ian's call whether the distinction is still real.**
- ⛔ **Coverage** (`coverageDayIds` — a request stamped against sales days). It reaches into
  remittance settlement and needs its own thinking.

## 7. Rules

1. `create_expense` to raise a request; **`approve_expense` to approve or release** — releasing is
   handing over money, and it must not be the same person's unilateral act as asking.
2. ⛔ A release cannot exceed the approved amount.
3. Money leaving obeys T-139: a cashier account **warns**, an office account **refuses** (row 154).
4. The float position is **derived**: released − spent − returned − short.
5. ⛔ A shortage needs a **person** and a reason — the same refusal as a remittance variance
   (row 144). The float was handed to somebody; who it is was never in doubt.
6. Return and shortage together may not exceed what is still held.
7. Reverse through `reverseEntry`. ⛔ Never a delete.

## 8. Done when

- [x] `cash_requests` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [x] `party_type` widened to `'cash_request'`; the expense spend leg carries it.
- [x] Services: request · approve/reject · release · return · shortage, with the position derived.
- [x] Integration tests: the release/return pair against POSTING-PATTERNS; ⭐ **a test that the
      float nets to zero when the request closes**; a spend through T-122 attributed to the
      request; the over-release refused; a shortage charged to nobody refused; a denial test.
- [x] Screens, driven end to end in a browser.
- [x] Gates: typecheck · unit · integration.

---

## 9. What the build changed after the spec was written

**Two things the spec did not anticipate, both settled in bible row 159.**

⭐ **`1120` had to be made party-requiring, and that is a migration on a seeded chart.** Migration
0035 updates `accounts.requires_party` for every org, and the seed says why in place. There is
nothing to backfill on the lines — v2 had posted nothing to `1120` before this task.

⭐ **Return and shortage post as TWO entries, not one.** The first version combined them into a
single credit to `1120` and its own test caught it: one leg cannot say how much came back and how
much did not, so `floatPositionOf` read the whole ₱2,000 as returned. They are genuinely two events,
they can fall on different days, and either can be reversed alone. `SettleResult.entryIds` is a
list for this reason.

⚠️ **`cancelled` was reachable in the schema with no code path to it** — a dead status. Added
`cancelCashRequest`, gated on `create_expense` rather than `approve_expense`: withdrawing your own
ask is not an approval decision, and requiring a manager to un-ask would leave dead requests in the
queue because the only person who could clear them had no reason to look. It refuses once released.

⚠️ **A picker bug found while driving the screens.** Five screens each carried their own copy of
`peso()`, all five interpolating the symbol by hand — which renders an overdrawn till as
`₱-27,850.00`, symbol first and sign second. Replaced with one `Intl` formatter at
`apps/erp/src/lib/format.ts`, which puts the sign where the locale wants it: `-₱27,850.00`. An
overdrawn drawer is precisely the figure the overdraft guard exists to raise, and it was being drawn
in a shape that invites the eye to skip the sign.

### Verified in a browser, end to end

A ₱2,000 float on Lipa: requested → approved → released from the cashier drawer → settled with
₱1,400 returned and ₱600 short. The ledger afterwards:

| source | account | Dr | Cr | party |
|---|---|---|---|---|
| release | 1120 | 2,000.00 | | the request |
| release | 1110 | | 2,000.00 | — |
| return | 1110 | 1,400.00 | | — |
| return | 1120 | | 1,400.00 | the request |
| shortage | 1230 | 600.00 | | **Dev Admin, by name** |
| shortage | 1120 | | 600.00 | the request |

⭐ **`1120` for this request: `0.00`.** The overdraft guard also fired on the release and *warned
rather than blocked*, which is right — the drawer is cashier-custodian and the day is unverified
(bible row 154).

