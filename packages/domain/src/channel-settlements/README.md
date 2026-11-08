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

## The period charge and the double-count rule (S6c)

A weekly platform fee, or any uncategorised charge, has no sales day: staging keeps it as a `period_charge` line (`booked_as none`) and now stores its VAT (`settlement_other_lines.vat_amount`: its net times the rate printed on the file, half up, once). `postPlatformCharge(tx, actor, { otherLineId })` (`charge.ts`) books it **once**:

- total = net + VAT, in whole centavos. A positive total is **Dr 6400 (fee + VAT, one line) / Cr 1220 party the channel**; a negative total (a platform credit note) is the same pair reversed.
- journal source type `channel_charge`, dated on the charge when its month is open, else the first open date after it (a period is never reopened); key `channel_charge:{otherLine}:post`.
- one row per staged line in `channel_period_charges` (append-only). A repeat is a quiet `{ posted: false }`. The staged line itself is never touched. Audit action `channel_charge.posted`.
- the accounts are the named constants of the channel-settlement repo; the VAT rate is never a constant here. No caller until slice 7 (approve an upload).

**The double-count rule.** When the platform later takes the charge out of a payout, the settlement must say so: `recordChannelSettlement` and `previewChannelSettlement` take `settleChargeIds` (the `channel_period_charges.id` list). Let C be the total of those charges. The receivable before them was `owed + C`; the payout settles `min(owed + C, gross)`; the `1220` credit, and the stored `outstanding_cleared`, are that **less C**. Without the ids the deposit looks C short of the day, and the shortfall books to `6420` on top of the `6400` the charge already booked: the same cost twice. With them the difference is zero. The ids are de-duplicated, must be the same channel and store, booked, and not already netted by a settlement that is not voided (serialised per charge by an advisory lock). The links (`channel_settlement_charge_links`) are written in the settlement's transaction; a void leaves them as history and they stop counting through the settlement's status, so the charge can be netted again.

**Re-uploads and known limits.** Ingest replaces an upload of the same channel, kind and period by setting `settlement_uploads.superseded_by` on the old one; it never retires the old upload's period lines (`is_current` stays true for them). So `postPlatformCharge` refuses a line whose upload was replaced ("This file was replaced by a newer upload"), and, because a charge booked from the first file is not undone by the second, it also refuses a line when a charge with the same store, channel, charge date, net amount and description is already booked from a different line ("probably from an earlier copy of this file"). **Accepted limit:** two genuinely identical charges (same day, amount and description) cannot both be posted in S6c; the second is refused and the owner is asked. A line staged before its VAT was kept (`vat_amount` NULL) cannot be fixed by uploading the same file again (an identical file is refused as already uploaded): it needs a corrected file or an owner fix. A charge dated after today is refused with its own sentence. A settlement whose netted charges use up the whole receivable and that moves no money, fee or loan is blocked in the preview and refused when recorded (a zero `1220` credit is never posted).

**Approve limit (S7a).** A Grab day merged from several Transactions files records ONE source upload, so the uploaders of the other files are not checked by the uploader rule of `approveDay`; only the recorded source upload and the payout upload are. Accepted until a day keeps every upload it was built from.
