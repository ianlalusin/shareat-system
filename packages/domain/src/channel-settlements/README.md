# channel-settlements

Clearing the `1220 Channel receivable` that Foodpanda and Grab raise. One function posts a payout (`recordChannelSettlement`), one previews it without writing (`previewChannelSettlement`), one voids it. Spec: `docs/tasks/150-channel-settlement.md`, loan legs and the acknowledged difference: `docs/tasks/511-settlement-upload-s6-spec.md` (S6a).

## Loan legs

A payout can dock several loans (Grab does). The input carries `loanLegs: { loanId, amount, ownerStoreId? }[]`, and **the loan deduction is the sum of the legs**: there is no separate deduction input.

- One leg is one loan and one owner store. A leg with a blank loan id is a picker left open and is dropped. The same (loan, owner store) twice is refused in plain words.
- `ownerStoreId` absent, null or the paying store is a **same-store** leg: a `2400` debit. Another store is the **cross-store** triple `1250` / `2400` / `2150`.
- Posting order: the bank deposit, the fees, the variance (6420) or gain (7100), each leg in the order given, then the `1220` credit.
- Stored in `channel_settlement_loan_legs` (the repo reads them back as `loanLegs` on a settlement and on every list row; a same-store leg carries the paying store's id as owner). The legs are written with the header in one transaction, and a deferred database trigger refuses a commit where they do not add up to `channel_settlements.loan_deduction`.
- A void reverses the whole journal entry, so every leg is reversed at once; the leg rows stay as history.
- The staged path (`../settlement-intake/settlement-input.ts`) builds the legs from the loan check's allocation of the store's own rows: `loanLegsForLine`.

Known limit: nothing in the settlement path refuses a leg above the loan's outstanding balance (only `recordLoanPayment` does).

## The acknowledged difference

`acknowledgeDifference: { reason }` replaces the old `recognizeGain` tick. When the payout differs from the day by more than the tolerance, **either sign**, a person must give a reason (1 to 500 characters after trimming):

- the payout is short of the day: the difference books to `6420` (settlement variance);
- the payout is over the day: it books to `7100` (settlement gain).

The trimmed reason is stored in `channel_settlements.difference_reason`. Within tolerance an acknowledgement is ignored (not stored, not refused) and nothing is asked. The preview says what is needed: `needsAcknowledgement`, the absolute `difference` and its `differenceSign` (`short`, `over`, `none`); its blockers name `acknowledgeDifference`.
