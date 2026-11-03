# Foodpanda and Grab settlement upload

*   **Author:** Ian Lalusin
*   **Status:** Draft. Reviewed by Goldfish stages 5 to 9 on 2026-11-03; fixes applied; owner decisions recorded below. Several items remain open (see Open Questions).
*   **Date:** 2026-11-03
*   **Related:** [T-150 channel settlement](../tasks/150-channel-settlement.md), [capability matrix](../decisions/CAPABILITY-MATRIX.md), [intake notes](channel-settlement-upload-intake.md), [T-511 slice 1 spec](../tasks/511-settlement-upload-s1-spec.md), [real-file facts](../discovery/grab-foodpanda-settlement-files.md)

--------------------------------------------------------------------------------

## Overview

About 20% of Shareat sales come through Foodpanda and Grab, across Lipa, Malvar, Davao and Banay-banay (closing). PG will join later. Each platform pays Shareat after taking its commission and fees, and sends a report that says how the payout was worked out.

This feature lets a manager or admin upload those reports. The app reads them, works out which store each file belongs to, and shows the platform's figures next to what staff recorded. A person then **approves or rejects each store-day**. Approving books it through the existing settlement posting (T-150). The app stores a review state for every store-day: pending, booked, or rejected with a reason. This is the same flow as the old ERP (v1).

**Terms used in this document**

| Term | Meaning | Name in code or T-150 |
|---|---|---|
| v1 | The legacy ERP at `C:\Users\ianla\webapps\ERP-rebuild`, read-only | |
| T-150 | The existing channel settlement posting: `computeSettlement`, `recordChannelSettlement` | `packages/domain/src/channel-settlements` |
| store-day | One store, one sales channel, one sales date | a staged "day line" |
| sales date | The day the orders were placed | `businessDate` |
| order value | The platform's order total as staff record it, AFTER discounts: Grab `Net Sales`, Foodpanda column R (exit 5, 3 Nov). Grab `Amount` and Foodpanda column K are shown for information only. | `grossAmount` |
| review state | pending, booked or rejected | not the settlement `status` (draft, posted, voided) |
| staged line | What the server read from a file and stored for one store-day | `settlement_day_lines` |
| platform | Grab or Foodpanda; each is a sales channel | `sales_channels` |
| reader | A deterministic file parser. No AI. | |
| cancel | Voiding a booked settlement (admin PIN) | `voidChannelSettlement` |
| safety limit | The greater of 50 pesos or 10% of sales; T-150 calls it the tolerance | `computeSettlement` |
| `platformFee` | The T-150 deduction kind used for every charge and tax except commission. Not the same as Foodpanda's "Platform Fee" column, written here as "Platform Fee (column)". | |
| CPC | Cost-per-click ads | |
| MDR | Card fee on Grab | |
| COD | Cash on delivery | |
| PG | A store that joins later | |

Amounts are in Philippine pesos (PHP). Dates in this document are written as in the files (for example 12 Oct) or ISO. Foodpanda column letters (Y, Z, AD, K and so on) refer to the sample files only; the reader uses header words.

What gets uploaded:

*   **Grab:** CSV files, one pair per store per month. A *Transaction* file has one row per order, plus loan, adjustment and cancelled rows. A *Transfers* file has one row per daily payout. Grab pays once a day, per store.
*   **Foodpanda:** one zip per store per week. Inside are an xlsx file (named ".xls", but a modern Excel file) and a PDF. Release 1 reads the xlsx only. The PDF is saved so a person can open it.

## The Problem

Today the owner reads each platform report by hand, works out what each line means, and books it. It takes about an hour a week. The hard part is reading and understanding. Typing the booking comes second.

What makes it hard, from the real files:

*   **Many kinds of rows.** Grab files mix sales with loan deductions, a loan paid in, withholding tax, compensation, ads and cancelled orders. Foodpanda files have one sheet of orders and another of charges that cover the whole week.
*   **Layouts change.** Foodpanda added two fee columns between June and October, and every column after them shifted. Reading by column letter would silently read the wrong money.
*   **Loan deductions are split across stores.** The company has a Grab loan at Lipa. When Lipa's payout is too small, Grab takes the rest from Malvar or Banay-banay on the same day. A loan deduction in one store's file cannot be checked in that file alone.
*   **A payout is not a day of sales.** Grab pays at about 1:45 AM the next day. Foodpanda pays a week at a time.
*   **Nothing says what a payout is "supposed" to be.** To spot a mistake, the owner would have to recompute each day.

The proposed answer: read the files for the person, show each store-day with its difference, and show loans, charges and odd rows in their own tables. Make files that are incomplete, unreadable or unmatched stand out instead of looking like a shortfall. Then let the person approve, with the app doing the booking and remembering what was booked, what is waiting, and what was rejected and why.

## Goals

1.  A manager or admin can upload Grab CSVs and Foodpanda zips. A manager can upload for, and see, only the stores they manage. An admin sees all stores.
2.  The app matches each file to a store using the platform's own store code, which an admin sets per store under store settings, sales channel. Grab's code is its Store ID. Foodpanda's is its Vendor Code. A file whose code matches no store, or more than one, is refused with a named reason (for example "store code not found") that does not reveal other stores' data.
3.  For each store and each **sales date**, the screen shows the platform's **order value** next to the figure staff recorded for that channel and day, and the difference. The platform figure is the reference value for the comparison. Staff record sales NET of the platform discount (exit 5, 3 Nov: Lipa 12 Oct Grab recorded 6,753.00 = `Net Sales`, Foodpanda recorded 15,564.75 = column R), so the order value is Grab `Net Sales` and Foodpanda column R. Grab `Amount` and Foodpanda column K are shown for information. No discount is booked (decision 15).
4.  Separate tables show: charges (commission, fees, ads, marketing), loan lines (deductions and disbursals), and rows that are not sales (adjustments, compensation, cancelled orders, Foodpanda period charges that belong to no single day). Rows that are not sales are kept out of order value, but adjustments, compensation and advertisement rows are part of the payout and are booked (see the row-kind table in Component I).
5.  A store-day with no file shows **"no file for this day"**, never as a difference. A Grab payout still marked "Processing" or an order row "Completed" but not yet "Transferred" shows **"not paid yet"**, never as a shortfall.
6.  A **company-wide loan check** runs per day across all stores' files. The day's loan deductions from every store must add up to the daily repayment amounts stored on the open loans. The day shows one of: "loan check OK", "loan amounts don't match", "waiting for other stores' files", or "no matching loan recorded". The last one is blocking: neither the loan payment nor the payout can be approved until the loan exists in the system.
7.  Each loan record stores its **real daily repayment amount**, entered by an admin from what the platform states. A manager sees a loan deduction in their own store's payout with its amount, loan name and owner store. The loan's balance and other stores' payments stay admin-only.
8.  **The newest upload supersedes older ones.** An exact copy of an earlier file (same fingerprint) is recognized and not stored twice. For overlapping or corrected files, the newest figures show for those store-days. Older uploads stay on record with who uploaded and when. The original files are kept.
9.  Foodpanda columns are found by their header words, never by letter. A file with an unknown or missing column is stopped with a message that names the column.
10. **Approve and book.** A manager (own stores) or admin can approve a store-day. Approving books it through the existing settlement posting (T-150), for both Grab and Foodpanda. The booking amounts come from the stored parsed file on the server, never from the browser. A day can be approved only when none of the blockers in Component F applies. A difference above the safety limit (the greater of 50 pesos or 10% of sales) can still be approved, in either direction. The person types a reason and confirms it. The difference is then booked **on the same sales day**: a shortfall as a variance expense (6420), a surplus as a gain (7100). **Owner decision 2026-11-03.** The existing posting refuses a shortfall above the limit, so it must change (Component H). The person who uploaded a file cannot approve its days; an admin can approve any day (accepted default).
11. **A status for every store-day, kept in the database:** *pending* (read, waiting for a decision), *booked* (approved and posted, linked to the settlement entry), or *rejected* (not booked, with a required reason). Each records who decided and when. A rejected day posts nothing, and the platform's money stays on the receivable until it is resolved.
12. **Corrections.** If a newer upload changes a store-day that is already booked, the screen shows "changed since booked". An admin corrects it by cancelling the old settlement (the existing cancel needs an admin PIN) and approving the new figures. A booked day is never changed in place.
13. Time to read, check and book the platform reports falls from about an hour a week (as reported by the owner) to **minutes**. Target: **15 minutes a week or less** (owner, 2026-11-03). The slice 5 exit counts how many days in the October files would be blocked, because many blocked days would stop the target being reached.
14. **Month close is blocked while a platform receivable is unsettled.** A fiscal month cannot be closed while a sales channel that is not remitted daily (Grab, Foodpanda) still has an unsettled receivable, unless an admin defers that receivable with a reason. A deferred receivable is booked on the date the payment arrives, not on the sales date (Component M). **Owner decision 2026-11-03.**

## Non-Goals

*   **Auto-booking.** Nothing posts without a person's approval. There is no "approve all" for days with a difference, or for days that are blocked.
*   **A separate Hold state.** Rejected (with a reason) is the only "not booked" state besides pending. Reason: with the platform figure as the reference, Hold and Rejected would differ little. An admin can re-open a rejected day (decision 13).
*   **AI.** This release has the deterministic reader only. A file the reader cannot read is refused with a named reason. An AI fallback, called only when the reader fails, is a follow-up after release 1; the owner dates it (see Future Improvements). It would only read, summarize and present, never post.
*   **PandaGO.** PandaGO is Foodpanda's delivery service. Its items ("PandaGO Order" rows, delivery service fees, PandaGO COD) are booked separately, not here. An invoice that holds only PandaGO items, like an invoice with only an Appendix B sheet (Lipa's extra invoice in the October sample), has no sales day, so it has no review state. It shows the file status "PandaGO: not booked here" and nobody rejects it.
*   **Reading the Foodpanda PDF.** It is saved, not read.
*   **Grab xls files.** Grab sends CSV only.
*   **Creating loans.** Loans already exist in the system. This feature matches loan lines to them and books the repayment inside the settlement. It never creates a loan.
*   **A store set-up screen.** Only the store-code field in store settings is in scope.
*   **Copying v1's extras:** wastage matching, the repair tool, the review queue. Reason: none is needed to book a settlement, and each is a separate feature. The owner confirmed this cut.
*   **Reading from the platforms' APIs.** Not studied.
*   **Changing sales days or any posted figure.** This feature never edits a sales day or a posted entry.

## Decisions Taken

Each is the owner's decision, with its date. Where the Goldfish review proposed a default and the owner accepted it, the date is 2026-11-03.

1.  **Approve and book, both platforms** (2026-11-02). Same flow as v1: a person approves each store-day and the app books it through T-150.
2.  **Foodpanda booking pattern** (2026-11-02). One entry per sales day, all sharing the invoice number as their reference. Each day's fees come from that day's orders. Ad (CPC) rows and other dated items go to the day named in their description. The weekly Platform Fee (column) (223.21) is attached to the last sales day of the invoice week and booked once per invoice, even when it is for an earlier month than the sales (October's invoices charge it "for the month of September"). The screen notes the fee's month. The week's entries add up to the invoice when no day is blocked. If the last day's sales are smaller than the fees attached to it, the fee moves to the nearest earlier day with enough sales (accepted default, 2026-11-03). The week's deposit is the sum of the entries' net deposits; each entry debits the destination account for its own day.
3.  **Charges and taxes** (2026-11-02; ads changed 2026-11-03). For now every charge and every tax, on both platforms, is an expense under the platform. Tax is not booked as tax. This includes VAT on fees, withholding taxes, Foodpanda's Expanded Withholding Tax and Surcharge Fee (both credits that enter as negative amounts), Grab's marketing fee and Eater compensation. Commission goes to `commission` (6400). **Ads go to `marketing` (6650):** Foodpanda CPC ads and Grab Advertisement rows (owner, 2026-11-03). Everything else goes to one signed `platformFee` (6400). The screen and staged line keep every column's amount, so splitting later needs no re-reading. **This supersedes T-150 sections 3 and 7 for settlements booked from uploads.** Only `commission`, `platformFee` and `marketing` are used; the other three kinds stay 0. The planner adds the decision-log row.
4.  **PandaGO is always separate** (2026-11-02). Never booked here. A PandaGO row inside a normal invoice is left out of the booked amounts, shown in its own table, and the week is marked "includes PandaGO".
5.  **Platform store codes** (2026-11-02). Codes never change, but an admin can change one in the UI.
6.  **Loan matching** (2026-11-02). Each loan stores its real daily repayment amount, entered by an admin. The loan check runs per day across all stores. A disbursal is excluded from the sales deposit. A missing loan blocks the payout. Two Grab loans can be open at once.
7.  **A shortfall above the safety limit can be approved** (2026-11-03). The person types a reason. The difference is booked on the same sales day, as variance expense (6420) or gain (7100). This changes the posting (Component H).
8.  **Month close and unsettled platform receivables** (2026-11-03). A fiscal month cannot be closed while a platform channel that is not remitted daily has an unsettled receivable, unless an admin defers it with a reason. A deferred receivable is booked on the date the payment arrives (Component M).
9.  **Approval order** (accepted default, 2026-11-03). A day can be approved only after every earlier day of the same channel is booked or rejected. The posting clears against the channel's whole balance, so approving out of order could hide a gap on a later day.
10. **Separation of duties** (accepted default, 2026-11-03). The person who uploaded a file cannot approve its days. An admin can approve any day. No admin PIN to approve; the PIN stays on cancel.
11. **Loan interest in release 1** (accepted default, 2026-11-03). T-150 books the whole loan deduction to 2400 (principal), as today. Grab's daily deduction includes interest, so the loan's balance falls faster than a real schedule. The loan screen shows the gap. Splitting interest (`splitPayment`, account 7200) is a later decision.
12. **Month-end deferral is one click** (2026-11-03). The admin action defers all open channels for the period at once. One channel at a time stays available.
13. **Rejected days can be re-opened by an admin** (2026-11-03). A re-opened day goes back to pending and needs a new approval. The re-open is audited. The receivable stays on the books until the day is booked or resolved.
14. **This design supersedes parts of bible row 320** (owner's 14 Oct answer, narrowing T-150: files become a draft settlement, the store is chosen explicitly on upload, the PDF is parsed, bad lines are quarantined). Per the owner's later decisions (2 to 3 Nov): the store is matched by the platform store code set in store settings; the PDF is saved and read later; a file with a problem is refused, not quarantined line by line; what was read is held in staging tables, not as a draft settlement (Alt-J). The planner's decision-log row names row 320 as superseded on those four points. **BOSS confirmed this on 3 Nov**: the intent of row 320 stands (a person approves before anything posts, and the file is kept as evidence). The PDF is accepted and stored in release 1; parsing it is a named follow-up, not dropped, because it is the only real check against the bank payout.
15. **Staff record sales net of the platform discount, so no discount is booked** (owner 3 Nov: "book as discount", read by BOSS as: the discount is already booked by recording the lower sale; exit-5 query by Ian on Lipa). Evidence: 12 Oct Grab recorded 6,753.00 = `Net Sales` (`Amount` 6,807.00 less 54.00 merchant discount); 12 Oct Foodpanda recorded 15,564.75 = column R. Consequence: the order-value comparison uses Grab `Net Sales` and Foodpanda column R; `Amount` and K are information only; no 4900 leg and no discount deduction is posted, on either platform. To see these discounts in 4900 the sale would have to be recorded gross, which is a POS and sales-day change outside T-511. Ian can overturn.
16. **Davao is in scope** (Ian 3 Nov: Davao sells on Foodpanda and Grab; "i dont have access to davao grab"). Davao's store codes go in store settings like the other stores. There are no Davao Grab files: the Grab reader is proven on Lipa, Malvar and Banay-banay only, and Davao's first real upload is its first test; an unknown header refuses the file with a named reason, so a layout difference fails safely instead of booking wrong figures. Davao Foodpanda files are asked of Ian when slice 3 needs them.

## Open Questions

Each has the default the design assumes and who decides. None blocks the Technical Plan; items marked **slice 1** are answered from the real files before any code.

*   **Other marketing-looking charges.** Ads go to marketing (decision 3). Grab's marketing success fee and Foodpanda's Customer Targeting Fee and Delivery Fee Campaign stay on `platformFee` (6400) by the literal reading of "ads". Owner to say if any belongs on marketing. Waiting-time, cancellation and compensation items stay on 6400 (decision 3).
*   **Grab merchant-funded discounts: decided (decision 15).** The discount is never booked: staff record the sale net, so it was never in revenue or the receivable (1220).
*   **Foodpanda vendor-funded vouchers and discounts (columns O, P, Q): decided (decision 15).** Same rule as Grab: staff record column R (after the vouchers), so nothing is booked and the vouchers are shown for information.
*   **Does a Grab loan row name its loan?** Answered (T-511 slice 1): no. Loan rows carry no loan id, description or order id; the allocation rule in Component F stands.
*   **Why a recorded day can still differ from the file.** Answered for the comparison value (decision 15). One unexplained gap was found: Lipa 20 Oct Grab recorded 9,474.00 against `Net Sales` 9,928.00 (454.00 below); the T-511 slice 2 investigation reports what explains it. A gap like that is what the review screen exists to show.
*   **Every Grab column in the mapping.** Confirmed on the October files (T-511 slice 1): `Total` = `Net Sales` + `Channel Commission`; the tax-on-commission column is already inside the commission; Net MDR, Tax on MDR, Marketing success fee and Order commission are empty or 0. Foodpanda columns are in the real-file facts doc.
*   **The October payout that does not tie in each file.** Answered (T-511 slice 1): it is the first payout of the month, whose orders are in the previous month's file; with the adjacent file every payout ties to the centavo.
*   **Cancelled and wastage orders.** Foodpanda orders cancelled after preparation are partly paid ("Wastage - Partial"). Whether they count in order value is undecided. None dominated the files opened.
*   **Rejected days: the receivable over time.** A rejected day's receivable stays on the books (decision 13). Whether an aged rejected receivable needs a write-off route is undecided.
*   **Loan end.** A loan stops being expected the day after its last deduction (the first loan's last was 27 Oct). Proposed: closed by changing the loan record's `status`.
*   **Which stores "waiting for other stores' files" waits for.** Proposed: every store that has an open loan or a loan deduction seen in the period, not channel active status. Banay-banay's channel goes inactive after closing, but its late payouts still carry deductions.
*   **Refunds and Grab adjustments.** Proposed: shown in the non-sales table, kept out of order value, booked as part of the payout. No real refund row was seen in the October sample.
*   **Foodpanda period charges** (ads, monthly Platform Fee (column)). Proposed: a weekly table, not spread across days (but see decision 2 for where they are booked).
*   **Foodpanda orders dated before the invoice week.** Some invoices contain orders from a week or more earlier (Lipa's 15 Oct invoice starts at 27 Sep). Cause unknown. They sit on their own sales date.
*   **A code change on a platform store code.** Proposed: applies to future uploads only; a file already matched keeps its store.

*   **Where the payment-arrival date comes from** for a deferred receivable (decision 8): the Grab transfer date in the Transfers file, and for Foodpanda the invoice payment date or the bank date. Proposed default when the arrival date is in a closed period: the first open date on or after it. Task spec decides the source.
*   **Loan interest gap.** The system formula gives 1,779.17 a day for the second loan (150,000 over 90 days at 2.25% a month); Grab takes 1,771.88. Decision 11 keeps booking the deduction as principal; the books' accrued interest may differ from Grab's.
*   **The first loan's end and the 2,363.12 total.** Test fixture: 591.24 a day until 12 Oct, then 2,363.12 a day from 13 to 27 Oct (both loans), then 1,771.88 a day. **Slice 1:** verify against the October files.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Principles

1.  **The server reads the file.** The browser sends the raw file. It never sends parsed numbers. v1 parsed in the browser and the server trusted the result (v1 `parse-grab.ts`, `parse-foodpanda.ts`), which let any manager post arbitrary figures. A manager can still upload an edited file, so this moves the trust boundary but does not remove it (see Risks & Mitigations).
2.  **Reading is a pure step.** File in, list of store-days out. No database, no AI, no posting inside it.
3.  **Approval carries an id, not amounts.** Approving a store-day sends only the staged line's id (plus a reason where needed). The amounts come from what the server stored when it read the file.
4.  **Booking reuses the existing settlement posting** (T-150: `computeSettlement` and `recordChannelSettlement`). This feature builds the intake, the staging and the review. It does not write ledger rows itself.
5.  **Anything the app cannot explain blocks approval.** An unknown column, an unexplained amount, a code that matches no store, a loan line with no loan: each stops that day with a plain message. The blockers are listed once, in Component F.

### Data flow

```text
 manager/admin picks files
        |
        v
 [1 Upload]      raw bytes in. Size, type and zip limits. SHA-256 fingerprint.
        |         same fingerprint, same organization, caller allowed to see that store
        v
 [2 Store match] Grab Store ID / Foodpanda Vendor Code -> store's sales channel
        |         none or several matches -> refuse the file with a named reason
        v
 [3 Read]        Grab: Transaction CSV + Transfers CSV     (CSV only)
        |         Foodpanda: zip -> xlsx (columns by header words); PDF only stored
        |         unknown / missing column -> refuse the file, name the column
        v
 [4 Stage]       one line per channel (store + platform) + sales date. Order value, charges,
        |         loan lines, non-sales rows, payout reference, paid or not yet.
        |         newest upload supersedes: new lines replace the old current ones
        v
 [5 Compare]     file order value vs the verified sales day's recorded figure.
        |         Checks: file complete, paid, charges explained, store matched,
        |         company-wide loan check for the day
        v
 [6 Review]      screen: day table + charges + loan lines + non-sales rows
        |         approve (pending -> booked)   reject (pending -> rejected + reason)
        v
 [7 Book]        existing settlement posting, built from the stored line
                  booked line keeps the link to the settlement entry
```

### Components

**A. Platform store codes (admin only).** Two new columns on the sales channel row: `platform` (`grab` or `foodpanda`, empty for other channels) and `platform_store_code`. A code is unique per organization and platform across all channels, active or not; an admin clears a code when a channel is closed or renamed. Matching ignores case and surrounding spaces. Lookup includes inactive channels, because Banay-banay's last payouts arrive after it closes. Because a code is unique across all channels, a lookup finds one channel or none; two matches cannot occur. Editing is a new admin-only permission, and a code change applies to future uploads only (proposed default, owner to confirm). The field sits in the store settings sales channel form.

**B. File intake.** A new file purpose for settlement files (CSV and zip, per-purpose size limit) in the existing stored-file system. The original file is kept with who uploaded it and when. Zip limits: compressed size, expanded size and entry count are capped; only `.xls` (xlsx inside) and `.pdf` names are allowed; no nested archives; a time limit on reading. Nothing from a zip is written to disk. The numeric caps are set in the task spec. The fingerprint is the SHA-256 of the whole uploaded file, taken from the stored file's checksum. A manager who uploads a file whose code matches a store they do not manage is refused with "This file does not belong to your stores", naming no store. The duplicate-file lookup is scoped by organization and the caller's store permission. Original files are visible only to people who can see that store's review screen; the retention period follows the stored-file rule.

**C. Readers.** Pure functions in the domain package, one per file kind:

*   *Grab Transactions CSV:* order rows (kind Payment) give order value per sales date. Loan, adjustment, advertisement and cancelled rows go to their own lists. Row status "Completed" means not yet transferred.
*   *Grab Transfers CSV:* one row per daily payout, its Net Total, and its status ("Processing" means not paid yet). It is the control total: for each payout, the Transaction rows must add up to the Net Total exactly. In the October files opened (four stores, one month) that held for 30 of 31 payouts in each store. The one left over is unexplained; slice 1 checks it. A Grab status value other than the ones named here is refused as unknown, naming the value.
*   *Foodpanda xlsx:* Appendix A gives one row per order with all fee columns. Appendix B gives the period charges. Columns are found by header words. An unknown or missing column stops the file.

Dates follow v1 (checked 2026-11-03): a Grab row takes its sales date from "Created On"; a Foodpanda row from "Order Date". A Grab adjustment's incident date is shown beside it but does not move it. A Foodpanda charge with no date in its description is dated to the last sales date in the file. Every Grab row belongs to the store-day of its payout, by Settlement ID, whatever its own date: a withholding tax remittance (a half-month) or a chargeback is booked on the payout's store-day as `platformFee` and shown in its own table.

The reader library choice is for the implementation task. Constraints: server-side only, no `xlsx` 0.18.5 (it has published security advisories, to be named in the task spec), xlsx only (the Foodpanda ".xls" is really xlsx), and size caps.

**D. Staging tables (new, one hand-authored migration, with RLS and cutover classification):**

*   `settlement_uploads`: one row per uploaded file. File reference, fingerprint, platform, matched channel, reader version, row counts, uploaded by and at, and a pointer to the upload that replaced it.
*   `settlement_day_lines`: one row per channel, sales date and version. Platform order value, the charge amounts by kind, loan deduction total, disbursal total, net payout, payout reference, payment-arrival date (the Grab transfer date, or the Foodpanda payment date), paid state, a snapshot of the recorded figure and the difference, the source upload, the **review state (`pending`, `booked`, `rejected`)**, the reason, who decided and when, and the settlement id once booked. Exactly one version is current per key. A new upload for a key that is already `booked` and has different figures creates a pending version flagged "changed since booked". It never edits the booked one. A new upload that covers fewer days than the file it replaces shows a warning. When another store's lines change, the loan check of dependent days is re-run, and a booked day whose loan figures change is flagged "changed since booked". Approval checks that the line is still the current version, so two people cannot decide the same day.
*   `settlement_loan_lines`: each loan row (store, amount, deduction or disbursal, platform transaction id) and the loan it was matched to.
*   `settlement_other_lines`: adjustments, compensation, cancelled orders, period charges and PandaGO rows, each with a kind. PandaGO rows are shown and never booked.

**E. Loan record.** One new column on loans: the **expected daily repayment amount**, entered by an admin. This release adds only that one field to the loan record. Start date, term, rate, rate period and status already exist on `loans`. Weekly and semi-annual rate periods are a separate loans task. The formula gives 1,779.17 a day for the second Grab loan at Lipa; Grab takes 1,771.88 (see Open Questions).

**F. Day checks (pure, in the domain package):**

*   *Complete:* every payout in the control file is present. A day with no orders and no payout is not a gap: the check follows the control file's payouts, not a continuous date run. A store-day with no file shows "no file for this day".
*   *Paid:* a "Processing" payout or a "Completed" order row shows "not paid yet".
*   *Charges explained:* every charge column read maps to a known kind (table below). A residual that known columns do not explain blocks the day.
*   *Loan check, company-wide per day:* add up every loan deduction from every store's file for that day, by loan. Allocate in a fixed order (older loan first, each up to its expected daily amount) unless Grab rows name their loan (open question; slice 1 checks). An admin can override the allocation, and the choice is stored on the staged lines. A row can be split across two loans. Results: **OK** (each open loan's total equals its expected daily amount, within 0.01: Grab rounds on a loan's last day, and in the October files 27 Oct sums to 2,363.11, not 2,363.12); **doesn't match**; **waiting for other stores' files** (every store with an open loan or a deduction seen in the period needs a file for that day); **no matching loan recorded** (blocks). October's data showed the sums are exact: 591.24 a day until 12 Oct, then 2,363.12 a day from 13 to 27 Oct, then 1,771.88 a day (to be verified in slice 1).
*   *Disbursal:* a loan disbursal row is money in. It is excluded from the day's sales deposit, because the loans module already recorded it. It is matched to a recorded loan with the same principal and start date, or the day shows "no matching loan recorded".
*   *Verified sales day:* a store-day with no verified sales day shows "no verified sales day yet" and cannot be approved.
*   *Blockers (the one list used by Goal 10, Principle 5 and the screen):* no file for the day; not paid yet; charges unexplained; store not matched; no verified sales day; loan check not OK (including no matching loan recorded); no destination account on the channel; negative net deposit; a posted settlement already exists for the channel and day; period closed for the settled-on date (not for a day covered by a deferral); an earlier day of the same channel is neither booked nor rejected; the line is not the current version. No destination account, negative net deposit and a posted settlement already exists come from T-150's `previewChannelSettlement`. "Period closed" and "no verified sales day" are not in the preview, so `dayBlockers` computes them itself (the database enforces the closed-period wall at posting). The preview's input type omits `salesDayId` and `settledOn`, so `buildSettlementInput` returns the record type and the preview call drops those two.

**G. Approve and reject (domain functions, one transaction each).**

*   *Approve:* check the permission and store scope; re-run the day checks on the stored line; refuse if blocked or not current. Refuse if the approver is the person who uploaded the file (an admin may approve any day). A difference above the safety limit needs a typed reason and the one acknowledgement of the difference (Component H); it books on the same sales day. Build the settlement input from the stored line and call the existing posting. Write `booked` and the settlement id in the same transaction. The audit log records who, when, the file, the reader version and the decision.
*   *Reject:* requires a reason. Posts nothing. The receivable stays.
*   *Correction:* a booked day is never changed in place. An admin cancels the settlement with the existing PIN-protected cancel, then approves the newer pending version.

**H. Extending the existing posting.** Three changes to T-150: two schema changes in migration 0229 (loan legs, the acknowledgement) and one behaviour change (the settled-on date, slice 8). They need T-150's full integration suite on a fresh database.

1.  **Several loan legs per settlement.** Today `RecordSettlementInput.loan` is one leg, `{ loanId, amount, ownerStoreId }`, stored in the columns `loan_id` and `loan_owner_store_id`. The check `channel_settlements_loan_shape_check` requires a loan whenever the loan deduction is not zero. A store-day can repay two loans (Lipa after 12 Oct) or another store's loan. The input takes a list of legs, a child table holds them, and each leg posts like today's single leg (2400, or the 1250/2150 cross-store pair). The legs add up to the one loan deduction, enforced by a deferred constraint trigger (a CHECK cannot count rows in another table) and by the domain function. The two old columns `loan_id` and `loan_owner_store_id` are dropped in the same migration (after the backfill), so one fact has one home. Existing settlements are backfilled with one leg each, from the stored loan and owner store. The check is dropped, and a deferred trigger replaces it (a CHECK cannot count rows in another table). Void reverses the whole entry, including every leg, as today; it needs no loan-payment guard, because the repayment is a leg inside the same entry. Consumers to update: existing callers and the screen, and `docs/POSTING-PATTERNS.md`.
2.  **One acknowledgement of the difference (owner decision 7).** Today `computeSettlement` refuses a shortfall past the tolerance, and only a gain can be acknowledged (`recognizeGain`, no stored reason). The gain check at `channel-settlements/index.ts:363-371` is generalized into one acknowledgement, `acknowledgeDifference: { reason }`, stored as `difference_reason`; the sign of the difference picks the account (shortfall to 6420, gain to 7100). The reason is stored on the settlement. Existing callers that pass `recognizeGain` are updated in the same change (the task spec lists them). The preview reports both cases the same way.
3.  **Settled-on date (a behaviour change, no schema change).** One rule: `settledOn` is the sales date, unless a deferral covers the channel and the sales date's period. Then it is the payment-arrival date from the file, or, if that date is in a closed period, the first open date on or after it (`firstOpenDateOnOrAfter` in `repo/fiscal-periods.ts`, already used by the recurring-expenses job). Owner to confirm. "Period closed" is a blocker only for a day not covered by a deferral.

No other change: the six deduction kinds stay closed, and a seventh needs an account decision first.

**I. Column to deduction mapping.** The six kinds and their accounts are from T-150; the owner decision below uses only two of them. A column that is not listed here is an unknown column and stops the file.

| Platform column | Deduction kind | Account |
|---|---|---|
| Grab: `Channel Commission` (Order, Delivery, Step-up and GrabKitchen commissions are empty or 0) | commission | 6400 |
| Grab: every other charge and tax: Net MDR, Grab Fee, Tax on MDR, Marketing success fee (all empty or 0 in the October files), the Withholding Tax Remittance adjustment rows (the `Withholding Tax` column is always 0), Deduction - Eater Compensation rows, Compensation - Orders rows (a credit). The tax-on-commission column is already inside `Channel Commission` and is not booked again | platformFee (signed, one regular Grab deduction) | 6400 |
| Grab: Advertisement rows | marketing | 6650 |
| Grab: `Discount (Merchant-Funded)`; Foodpanda: vendor-funded vouchers and discounts (O, P, Q) | not booked: staff record the sale net of it, so booking it would count it twice | none |
| Grab: Loan Deduction rows | loan legs | 2400, or 1250/2150 across stores |
| Foodpanda: foodpanda Commission (Y) | commission | 6400 |
| Foodpanda: CPC ads (Appendix B, dated in the description) | marketing | 6650 |
| Foodpanda: every other charge and tax: Pandabox Fee (Z), monthly Platform Fee (last day of week), Tax On Partner Charges (AD), 1/2% Withholding Tax (T), Customer Targeting Fee (AB), Delivery Fee Campaign (AC), Waiting Time Fee (U), Cancellation Fee (V), Surcharge Fee (S, a credit), Expanded Withholding Tax (AE, a credit) | platformFee (signed, one regular Foodpanda deduction) | 6400 |
| Foodpanda: PandaGO rows | not booked | shown only |

Owner decision 2026-11-02: for now all Foodpanda charges and taxes, and all Grab charges and taxes, are an expense under their platform, and tax is not booked as tax. `commission` and `platformFee` land on 6400 and ads land on `marketing` (6650), so the ledger shows two expense lines per platform (owner, 2026-11-03). The screen and the staged line keep every column's amount, so a later decision to split them needs no re-reading of files. The only booking difference between platforms is the loan, which exists on Grab only and is not a charge.

The mapping of every Grab column is from the column names only. A test on real files must confirm each one before the table is final (slice 1 exit criterion).

Per row kind (Grab and Foodpanda):

| Row kind | In order value | In the payout (control total) | Booked |
|---|---|---|---|
| Order (Grab Payment, Foodpanda order) | yes | yes | sales |
| Adjustment, compensation, Eater compensation | no | yes | `platformFee` |
| Advertisement (Grab rows, Foodpanda CPC ads) | no | yes | `marketing` |
| Cancelled order | no (open question for Foodpanda wastage) | no | no |
| Loan deduction | no | yes | loan legs |
| Loan disbursal | no | yes, but excluded from the sales deposit | no (the loans module recorded it) |
| PandaGO | no | no | no |

**J. Permissions.** New: upload settlement files (manager for own stores, admin all); edit platform store codes (admin only); edit a loan's expected repayment amount (admin only). Approve and reject reuse the existing `record_ar_collection` permission held by managers and admins. Deferring a receivable at month close reuses `override_period_lock`, only for its admin-only bar (its label says "post into a closed period", which deferring is not). `close_period` is also granted to managers and is deliberately not used (see `capabilities.ts`). Cancelling a booked settlement keeps the admin PIN. Each permission gets a row in `docs/decisions/CAPABILITY-MATRIX.md` and a test that the role without the permission is refused.

**K. Screens (`apps/erp/src/app/channel-settlements/`).**

*   *Upload:* pick many files, see per-file results (matched store, rows read, or the named refusal reason).
*   *Review:* store-day table (platform order value, recorded figure, difference, state, loan check, paid state), and, when the difference is not zero, the day's orders with time and amount, read again from the stored file (the file is kept as evidence; the order lists are not kept in the staging tables, and no order ids or customer fields are shown) (so a whole omitted order, such as a late order after 23:00, is visible; the Lipa 20 Oct Grab gap of 454.00 equals the day's last order, created 23:18), with the charges, loan lines and non-sales tables beside it. Approve and reject per day. A "needs attention" filter. Foodpanda weeks are grouped by invoice.

**L. Observability.** Every upload logs the fingerprint, reader version, matched store, rows read, and the named reason for any refusal. Refusals are counted by reason. Whole files are never logged.

**M. Month-close guard and deferral (owner decision 8, 2026-11-03).**

*   *Rule:* a fiscal month cannot be closed while a sales channel that is not remitted daily (`is_remitted_daily` false: Grab, Foodpanda) has an unsettled receivable, meaning the balance on its receivable account (normally 1220) at period end is not zero.
*   *Where it lives:* close readiness is already a filter over the findings feed (the close checker and the findings feed are one machine, `findings/index.ts`). So the rule is a new period-scoped hard detector, `channelReceivableUnsettled`, next to the existing detectors. It reads each channel's own `receivable_account_code` as of the period end (not a hard-coded 1220; `outstandingFor` hard-codes 1220 today), reusing T-507's per-channel and store-scope logic in `repo/ar.ts` (`platformAging`, `platformControlBalance`) where it fits. The findings page then shows it with the channel and amount (it needs a label entry), and the close check picks it up from the feed. Nothing is added inside `closeBlockers`.
*   *Deferral:* an admin may defer a channel's receivable for a period, with a typed reason. The deferral stores channel, period, **the deferred amount**, reason, who and when, in `channel_settlement_deferrals` (migration 0230, owned by the settlement module). The detector skips a deferred channel and period, but only while the balance still equals the deferred amount; if it differs at close, the finding returns. A deferral is a deliberate exception: an acknowledged hard finding still blocks close (`findings/index.ts`), and `acknowledgeFinding` is not reused, so that rule is not weakened for other findings. The permission is `override_period_lock` (admin only).
*   *Expected routine:* Grab pays about a day late and Foodpanda about a week late, so at month end the 1220 balance is normally not zero on every Grab and Foodpanda channel, including active stores. With four stores and two platforms that is up to eight channel deferrals a month. To keep it to one step, the admin action defers all open channels for the period at once (decision 12; one channel at a time stays available). An "open channel" means a channel that is not remitted daily and has a non-zero receivable-account balance at period end. The system captures the deferred amount at defer time; the admin does not type it.
*   *Booking later:* when the file for a deferred day arrives, the settlement is booked with `settledOn` = the date the payment arrives, in an open period (Component H, item 3). `businessDate` stays the sales date. T-150's rule that nothing posts into a closed period (invariant 11) does not change.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A manager uploads an edited file | Wrong figures booked | The browser sends no figures. The uploader cannot approve their own file. The booked deposit is not compared with the real bank or wallet deposit in release 1; that check is a future improvement. |
| Approving days out of order | The posting clears against the channel's whole balance, so a later day's gap can be hidden | Approval order rule (decision 9) and a test: approve day N while day N-1 is unsettled. |
| Two people approve or upload at once | Double booking, stale overwrite | Version check at approval. Only one settlement per channel and day can be posted. |
| Foodpanda fee larger than the last day's sales | Day cannot be booked | The fee moves to the nearest earlier day with enough sales (decision 2). |
| Late file for a closed month | Cannot post | Month-close guard and deferral (Component M). |
| Loan deduction booked as principal | Loan balance falls faster than a real schedule; `paid_off` can fire early | Decision 11 and a visible gap on the loan screen. Interest split is later. |
| Extending the posting to several loan legs | Touches code that posts money | Migration 0229, full integration suite on a fresh database, backfill test, cross-store test. |
| Oversized or hostile files | Memory or disk exhaustion | Caps on size, entry count, expanded size and read time; nothing written to disk (Component B). |
| A reader or library fails mid-batch | Some files read, some not | Per-file results. Files are staged one by one, in their own transaction. |
| A reader fix after files are stored | Old lines read by an old reader | The reader version is stored; the task spec decides whether to re-read. |
| File contains customer order ids | Sensitive data retained | Visible only to people who can see that store's review screen. |
| Platform changes its layout | Reader refuses the file | Foodpanda columns found by header words; an unknown column stops the file with its name. AI fallback is a later follow-up. |

## Alternatives Considered

### Alt-A: Read-only first release

*   **Pros**: No ledger risk. Delivers the reading and checking, which the owner called the hard part. Slices 1 to 5 of the plan below.
*   **Cons**: Booking stays manual, so the weekly job would not reach "minutes".
*   **Reason for Rejection**: The owner chose approve-and-book for both platforms in this release, like v1. The plan keeps the risk down by booking only clean days, from stored figures, through the existing posting.

### Alt-B: AI as the main file reader

*   **Pros**: Handles odd or changed layouts without code changes.
*   **Cons**: A new provider, key, cost limit and a question about sending store financials to an outside company. An AI can misread a number and still look sure. A cell in a file can carry instructions aimed at it.
*   **Reason for Rejection**: Money amounts come only from the deterministic reader. The owner wants an AI fallback, called only when the reader fails, as **follow-up work soon**, not in this release. It would only read and present, never post.

### Alt-C: Read files in the browser, as v1 did

*   **Pros**: Less server work.
*   **Cons**: The server then trusts numbers the browser sends. Any manager could post arbitrary figures to the books. v1 also used the `xlsx` 0.18.5 package, which has published security advisories.
*   **Reason for Rejection**: The server reads the raw file and the browser never sends amounts.

### Alt-D: Match a file to a store by store name

*   **Pros**: No new field.
*   **Cons**: Names change. Foodpanda's Malvar partner name differs between files.
*   **Reason for Rejection**: Both platforms give a stable code (Grab Store ID, Foodpanda Vendor Code). An admin sets it in store settings.

### Alt-E: Compare by payout date

*   **Pros**: Matches the bank statement.
*   **Cons**: Grab pays one day late, and Foodpanda pays a week at a time. Staff record sales by day, so the days would not line up.
*   **Reason for Rejection**: Sales date, with the payout date shown as "money arrived on".

### Alt-F: Other places for the weekly Foodpanda Platform Fee

*   **F1, split over seven days. Pros**: smooths daily fee figures. **Cons**: adds rounding cents and a daily charge the platform never made.
*   **F2, a separate weekly entry. Pros**: mirrors the invoice. **Cons**: needs a new kind of posting and breaks the rule that each day's receivable clears to zero.
*   **Reason for Rejection**: Attach it to the last sales day of the invoice week, once per invoice, even when the fee names an earlier month. It uses the existing posting unchanged and the week adds up exactly. Booking it against its own month was also considered. It is the most accurate, but it fails when that month is closed.

### Alt-G: Work out each loan's daily amount from principal, rate and days

*   **Pros**: Nothing new for an admin to type.
*   **Cons**: The formula gives 1,779.17 a day for the second loan. Grab takes 1,771.88. Every day would look like a mismatch, and a tolerance could hide a real error.
*   **Reason for Rejection**: Each loan stores the real daily amount, entered by an admin.

### Alt-H: Check loans per store file

*   **Pros**: Simpler. A manager needs only their own file.
*   **Cons**: When Lipa's payout is short, Grab takes the rest from Malvar or Banay-banay on the same day. No single store's file adds up alone.
*   **Reason for Rejection**: The loan check runs per day across all stores' files.

### Alt-I: Hold as a separate state, or refuse overlapping uploads

*   **Pros**: Hold lets a day wait with a different meaning than rejected. Refusing overlaps is stricter.
*   **Cons**: With the platform figure as the reference, Hold and reject differ little. Refusing overlaps blocks a corrected file from the platform.
*   **Reason for Rejection**: Three states only (pending, booked, rejected with a reason), and the newest upload supersedes older ones, which are kept.

### Alt-J: Hold pending states on the existing settlement table

*   **Pros**: No new tables. The settlement table already has a draft status.
*   **Cons**: A settlement row needs a verified sales day and final numbers that balance. A day where the platform paid but staff recorded nothing could not be saved, and that is the most important difference to see.
*   **Reason for Rejection**: New staging tables hold what was read. Only booking writes to the settlement table.

### Alt-K: Book tax as tax, and split ads into Marketing

*   **Pros**: Matches the accounts T-150 set up (VAT stays with the fee, withholding tax to 6800, ads to 6650).
*   **Cons**: Needs an accounting decision on each tax line. Two Foodpanda columns (Surcharge Fee and Expanded Withholding Tax) are credits that need their own accounting rule.
*   **Reason for Rejection**: Partly accepted. Ads go to marketing (6650), as the owner decided on 2026-11-03. For now taxes and every other charge stay one expense on 6400. The detail is kept, so splitting later needs no re-reading.

### Alt-L: No new feature

*   **Pros**: Manual booking already works. No build and no upkeep when the platforms change formats without notice.
*   **Cons**: It leaves the hour a week, and with about 20% of sales on these platforms the owner is the only person who can do it. Cheaper options exist (a cleaner export or API from the platform, or showing the expected receivable beside each day on the existing screen) but were not studied.
*   **Reason for Rejection**: The owner wants minutes. The plan limits upkeep by finding Foodpanda columns by header words and refusing a file with an unknown column rather than reading it wrongly.

### Alt-M: Auto-book clean days

*   **Pros**: Fastest weekly job.
*   **Cons**: Nothing would stop a bad file from posting. The owner wants a person to approve each day.
*   **Reason for Rejection**: Approval by a person. Auto-booking could be added later for days with no difference and no loan.

### Alt-N: One settlement per loan leg instead of changing the posting

*   **Pros**: No change to the posting identity.
*   **Cons**: Only one settlement per channel and day is allowed, and the money rules (fees booked once) would need to be split across entries.
*   **Reason for Rejection**: Loan legs inside one settlement keep the single place where fees are booked.

### Alt-O: Relax one settlement per channel and day

*   **Pros**: Would let a day be booked in parts.
*   **Cons**: That rule guards against double-booking a fee (the 198k-peso double-count pattern recorded in `docs/tasks/131-accounts-receivable.md`).
*   **Reason for Rejection**: Kept.

### Alt-P: Use the existing admin period override instead of a deferral (confirmed rejected by BOSS, 3 Nov: nothing posts into a closed period; a deferral moves `settledOn` to an open date; `override_period_lock` is reused only as the admin-only gate)

*   **Pros**: Already built (`override_period_lock`, the `period_overrides` table, `insertPeriodOverride`, used by expense approval and sales-day verification). No new table.
*   **Cons**: It posts into a closed month with a reason. The owner asked for the opposite: close is blocked while a platform receivable is unsettled, an admin may defer it, and the settlement is booked on the date the payment arrives, in an open month. `recordChannelSettlement` takes no override today.
*   **Reason for Rejection**: Decision 8. The deferral reuses the same admin-only permission, not the posting override.

## Future Improvements

*   **AI fallback (after release 1; the owner dates it):** when the deterministic reader refuses a file, an AI reads it and shows what it found, labelled "AI-read, not checked". A person checks it first. The AI never approves or books. It needs a provider, a key, a monthly cost limit, and a decision on sending store financials and PDFs to an outside company.
*   **Read the Foodpanda PDF** for the invoice period and the amount owed, as a second check on the xlsx totals.
*   **Split charges and taxes** by kind (VAT, withholding, marketing) once an accounting decision is made. The staged lines already keep each amount.
*   **Weekly and semi-annual rate periods** for loans (a separate loans task).
*   **Check the booked deposit against the real bank or wallet deposit.**
*   **Split loan deductions into principal and interest** (`splitPayment`, account 7200).

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Before any code: this repo's Next.js has breaking changes. Read the matching guide in `node_modules/next/dist/docs/` before writing any page or action file. Never build on a production host (159.223.46.224 or 159.223.78.207); builds run in CI. Stop the local dev server before `npm run build`. Each slice needs a written task spec in `docs/tasks/`, with T-numbers taken from the coordination board at spec time. The planner writes each spec in plan mode.

### Baseline warning

Every code fact in this design (file names, function names, line numbers, migration numbers, capability names, test pins) was checked on a checkout that is 303 commits behind `origin/main` (9238217, 3 Nov 2026). Known changes on main since then: migrations 0213 to 0225 are taken (the next free number comes from the coordination board); T-398 S3 already added `(org_id, id)` unique indexes and same-organization twin foreign keys on `channel_settlements`, `loans` and `sales_days`, so the census pin and exemptions have moved; domain functions now take `tx: Tx`; T-487 changed month close, T-494 changed AR, T-507 added a platform receivables section to the AR report, and `channel-settlements`, `loans`, `findings` and `fiscal-periods` code changed. A re-verification against current main was done on 3 Nov (`docs/designs/reviews/rebase_check_report.md`) and its corrections are applied below; slice 1 repeats the check before building. The task number and migration numbers come from the orchestrator.

### Slices, in order

Numbers reserved by the orchestrator on 3 Nov 2026: task **T-511**; migrations **0228, 0229, 0230**, in that order; DEF-810 to DEF-812; bible rows 425 to 427. Migrations 0226 (T-508) and 0227 (T-510) are ahead of these and not merged yet, so these files must sort after them. Set each journal `when` above main's latest at merge time.

1.  **Spec, sample files, library choice.** Redacted real files go into the fixtures folder. Slice 1's spec fixes the zip, xlsx and CSV libraries, the numeric caps, the accepted content types, the exact header strings and row-kind values for both platforms, the sales-date time zone rule (Manila), and answers the "slice 1" open questions. Slices 3 and 4 do not start before it.
2.  **Additive migration (store codes, loan repayment amount, the four staging tables, the file purpose), permissions, and the two admin edits (platform code, repayment amount) with their domain functions and screens.** Includes every file-module edit that the new purpose forces, so typecheck passes. Gated on the integration suite on a gate database (the same-organization census is an integration test).
3.  **Readers** (pure functions) with tests on the real fixtures.
4.  **Upload intake and staging.** Files in, lines staged, newest upload supersedes.
5.  **Review screen** with the day table, side tables and the loan check. Reject is wired. Approve is hidden until slice 7.
6.  **Posting change (second migration):** several loan legs per settlement, and the one acknowledgement of the difference for a shortfall or gain above the limit. Full integration suite on a fresh gate database.
7.  **Approve wired to booking.** Includes the approval order and uploader-is-not-approver rules.
8.  **Month-close guard and deferral** (decision 8): third migration, the findings detector, the admin defer action and the settled-on rule.
9.  **Docs, roadmap, status board.**

Slices 1 to 5 deliver reading, checking and review with no change to anything that posts. Slices 6 to 8 touch code that posts money or closes a month. If the scope must shrink, stop after slice 5 and ship that first.

The AI fallback is a separate later task and is not in these slices.

### Plan decisions

These close design gaps found in review. Column lists, message texts and header strings are owned by the slice specs (see item 67).

**Staged line to settlement input** (the builder is slice 5, `settlement-input.ts`; booking is slice 7). One staged line becomes one `RecordSettlementInput`:

| Settlement input | From the staged line |
|---|---|
| `businessDate` | the sales date |
| `salesDayId` | the verified sales day for the channel and date |
| `grossAmount` | order value |
| `deductions` | `commission`; `marketing` (ads); `platformFee` (signed sum of every other charge and tax) |
| loan legs | the day's allocated legs (Component F); a disbursal is not a leg |
| `netDeposited` | gross, less commission and `platformFee`, less the loan deduction. Never negative: a day that would go negative is blocked or its fee is relocated (decision 2) |
| `reference` | payout id (Grab) or invoice number (Foodpanda) |
| `settledOn` | Component H item 3 |
| destination account | the channel's configured account |
| acknowledgement | `acknowledgeDifference: { reason }`, only when the difference is above the safety limit |

A Foodpanda week is several entries, one per sales day, all with the invoice number as `reference`. The Platform Fee (column) is attached once, to the last sales day, or relocated to the nearest earlier day with enough sales. The week's deposit is the sum of the entries' `netDeposited`; each entry debits the destination account for its own day, and there is no separate deposit entry. The slice 7 spec starts with a worked Grab day and a worked Foodpanda week.

**One function owns the blockers** (slice 5). `dayBlockers(line, context)` in `day-checks.ts` composes the full list from Component F. Both `approveDay` and the review screen call it. At approval it re-reads, and does not use the snapshot on the line, for: the recorded figure, the verified sales day, the posting preview (`previewChannelSettlement`, for the T-150 blockers), the period state, and the state of earlier days. The snapshot is for display only.

**Earlier days** (slice 5). "Earlier days" start at the channel's first staged day. A day before it never blocks. A day earlier than the one being approved, with no staged line, blocks only if staff recorded sales for the channel on that day. A day with no recorded sales never blocks.

**Grab rows to store-days** (slice 4). The file kind is detected from its header row (Transactions, 68 columns; Transfers, 10 columns), never from the file name. Transactions rows are matched to payouts by Settlement ID; a payout's store-day is its `Date` minus one day. A payout with no rows in any uploaded Transactions file shows "waiting for the earlier file" (its absence is not a difference). A Transactions file with no Transfers file stages nothing and shows "waiting for the Transfers file". Replacing a file re-matches the affected days.

**Legs total** (slice 6). A deferred constraint trigger checks at commit that the legs add up to the loan deduction and that a non-zero deduction has at least one leg (RULES.md rule 3: the database enforces the rules, not the service layer). The domain function checks it too. An in-code-only check is allowed only if the task spec records the exception to that rule.

### Target Files to Create/Modify

README items below: the per-directory README files are not tracked on main (only `packages/db/migrations/README.md` is). Treat each README item as Create, or land the README batch first. There is no tracked per-directory format to copy, so follow the format in the existing untracked batch.

Each item names its slice. Format: path (Create or Modify), slice, changes.

#### Database and migrations

1.  `packages/db/migrations/0228_t511_settlement_intake.sql` (Create). **Slice 2.** Hand-authored (ADR-012 §5), additive only. Add `platform` (CHECK: `grab`, `foodpanda`, or NULL) and `platform_store_code` to `sales_channels`, with a check that both are set or both NULL, and a unique index on organization, platform and `lower(trim(platform_store_code))` across all channels, active or not (hand-added, noted in the schema file). Add nullable `repayment_amount` to `loans` with a check above zero. Drop and re-add the `stored_files` purpose check (as in migrations 0204 and 0205) with `channel_settlement_file`. Create `settlement_uploads`, `settlement_day_lines`, `settlement_loan_lines`, `settlement_other_lines`, with row-level security through `app_current_org()`. Money columns are `numeric(14,2)`. One current version per channel and sales date: a `version` integer and an `is_current` boolean, with a partial unique index where `is_current`. Unique fingerprint per organization on uploads. Every foreign key to a parent has an `org_id` composite twin, and the new foreign keys reference the `(org_id, id)` unique indexes that already exist on main for every parent named in this plan. Every numeric column gets a `*_finite_check` (the t327 census) and the money columns are classified in `packages/domain/src/shared/money-positivity-census.ts`. Grants: UPDATE on uploads, day lines and loan lines (the allocation override); the other tables are insert-only (ADR-012 §4a). The exact column list is slice 2's spec deliverable. It must also say where invoice number, "changed since booked", "unexplained", the Foodpanda fee month, the allocation override and the loan-check result are stored.
2.  `packages/db/migrations/0229_t511_settlement_loan_legs.sql` (Create). **Slice 6.** Hand-authored. Changes a constraint and data that feeds posting. Create `channel_settlement_loan_legs` (settlement, loan, owner store, amount above zero) with `org_id`, composite foreign keys to `stores` and `loans`, unique on (settlement, loan, owner store), and row-level security. Backfill one leg for every existing settlement that has a loan, then drop `loan_id`, `loan_owner_store_id` and their composite twins (`channel_settlements_loan_id_same_org_fk` from migration 0213, and the loan-owner-store twin from 0194). Drop `channel_settlements_loan_shape_check`, and create the deferred legs-total trigger that replaces it (the legs table carries its own `org_id` and composite twins; a child table without `org_id` would use `assert_same_org_via_parent`, which exists since migration 0214). Add `difference_reason` to `channel_settlements`. Requires the full integration suite on a fresh gate database.
3.  `packages/db/migrations/0230_t511_channel_settlement_deferrals.sql` (Create). **Slice 8.** Hand-authored, additive. Create `channel_settlement_deferrals` (channel, fiscal period, deferred amount, reason, deferred by, deferred at, superseded-by), unique on (channel, period) among non-superseded rows, with row-level security and composite foreign keys, and an UPDATE grant for the superseding row. The deferred amount gets a finite check and a positivity classification. It belongs to the settlement module, which owns account 1220, because the close guard also covers settlements typed by hand.
4.  `packages/db/migrations/meta/_journal.json` (Modify). **Slices 2, 6, 8.** Each migration appends its own journal entry in its own slice, one day after the previous (ADR-012). No snapshot files.
5.  `packages/db/schema/settlement-intake.ts` (Create). **Slice 2.** The four staging tables, with the platform list, review states (`pending`, `booked`, `rejected`) and line kinds as shared constants. Each hand-added index or check carries a "hand-added in migration 0228" note.
6.  `packages/db/schema/channel-settlements.ts` (Modify). **Slices 6 and 8.** Slice 6: the loan legs table, drop the two old loan columns, add `difference_reason`, drop the loan shape check. Slice 8: the deferrals table (UPDATE grant for the superseding row).
7.  `packages/db/schema/sales-days.ts` (Modify). **Slice 2.** `platform` and `platformStoreCode` on `sales_channels`.
8.  `packages/db/schema/loans.ts` (Modify). **Slice 2.** `repaymentAmount`.
9.  `packages/db/schema/stored-files.ts` (Modify). **Slice 2.** Add `channel_settlement_file` to `FILE_PURPOSES`.
10. `packages/db/schema/index.ts` and `packages/db/src/index.ts` (Modify). **Slices 2 and 4.** Slice 2: export the new schema file. Slice 4: export the repo as `settlementIntakeRepo`, in the slice that creates it (the existing pattern is `export * as channelSettlementsRepo`).
11. `packages/db/src/repo/settlement-intake.ts` (Create). **Slices 4 and 5.** The only place SQL is written for this feature. Slice 4: insert an upload (a repeat fingerprint, scoped by organization and the caller's store permission, returns the earlier one); find a channel by platform and code (one match, or none); insert a new line version and retire the previous current one; read the recorded figure and verified state of a sales day; list days with recorded channel sales and no current staged line. Slice 5: list review rows scoped to a manager's stores; an unscoped internal read of all stores' loan lines for the company-wide check (never returned to a manager as rows); move a line from pending to booked or rejected with compare-and-set so two people cannot decide the same day; store a loan allocation override.
12. `packages/db/src/repo/channel-settlements.ts` (Modify). **Slices 6 and 8.** Slice 6: insert and read loan legs; return legs when listing and voiding; `InsertSettlementInput` and `ChannelSettlementRow` stop carrying the old loan fields. Slice 8: add an as-of balance by the channel's `receivable_account_code` (extending `outstandingFor`, which hard-codes 1220); insert, supersede and read deferrals.
13. `packages/db/src/repo/loans.ts` (Modify). **Slice 2.** Read and write `repayment_amount`. List open loans for an organization.
14. `packages/db/src/repo/files.ts` (Modify). **Slice 2.** `FILE_REFERENCES` is derived from `FILE_PURPOSES` minus `GUARDED_PURPOSES`, so it accepts the new purpose on its own. The spec decides how the withholding-certificate column refuses it (an explicit allow list, or `GUARDED_PURPOSES`, which also carries read-path meaning), and registers the new upload file column.
15. `packages/db/src/repo/findings.ts` (Modify). **Slice 8.** The SQL for the `channelReceivableUnsettled` detector.
16. `packages/db/src/rls/registry.ts` (Modify). **Slices 2, 6, 8.** Register each slice's new tables with scope and reason (every new table carries its own organization column, including the legs table). The build stops without it.
17. `packages/db/src/cutover/classification.ts` (Modify). **Slices 2, 6, 8.** Classify the six new tables as purge, because they describe uploads and decisions over receivables the opening balance replaces, like `channel_settlements`. The build stops without it.
18. `packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts` (Modify, only if a pin moves). **Slices 2 and 6.** Nothing to delete or re-pin for the loan columns: the exemption lists are empty and `OPEN_BASELINE` is the empty-set hash. New tables must pass the census: composite twins for org-to-org foreign keys. `NO_FK_PIN` and `JSONB_PIN` move only if a new table has no foreign key or has a jsonb column. The census is an integration test, so slices 2 and 6 are gated on the integration suite on a gate database, not only `npm test`.
19. `packages/db/src/triggers/registry.ts` (Modify). **Slice 6.** Register the deferred legs-total trigger that migration 0229 creates.
20. `packages/db/src/audit/catalogue.ts` (Modify), and `tests/unit/t402-s1a-action-coverage.test.ts`. **Slices 2, 4, 5, 7, 8.** Entries, named `<area>.<verb>`, each with category, sensitivity, scope, viewers (in the options) and entity, modelled on `set_channel_payout`. Each slice adds the entries for the actions it ships: slice 2 platform-code edit and repayment-amount edit; slice 4 upload; slice 5 reject, re-open and allocation override; slice 7 approve; slice 8 defer receivable. The audit log refuses an action that is not in the catalogue.

#### Domain: reading and staging (new folder `packages/domain/src/settlement-intake/`)

21. `README.md` (Create). **Slice 3.** Overview, interface, invariants, side effects, verification, in the repo's per-directory format.
22. `safe-zip.ts` (Create). **Slice 3.** Pure function. Open a zip from bytes with caps on compressed size, expanded size and entry count (values from slice 1's spec). Allow only `.xls` and `.pdf` names, refuse nested archives, apply a time limit. Return the xlsx bytes and the PDF bytes. Write nothing to disk.
23. `packages/core/src/csv.ts` (Modify, only if needed). **Slice 3.** `parseCsv` already exists here (T-502 S4: BOM, quoted fields, CRLF, blank lines, line numbers), and `packages/domain` already imports it as `@shareat/core/csv`. The Grab readers use it. Add a feature only if Grab needs one it lacks (for example header-keyed rows). No change to `etl`.
24. `grab-transactions.ts` (Create). **Slice 3.** Reader. Columns by header words. Order rows (kind Payment) give order value per sales date from "Created On". Loan deduction, loan disbursal, adjustment, advertisement and cancelled rows go to their own lists. Every row is matched to its payout by Settlement ID; a row with no Settlement ID (Cancelled) is ignored for money. Row status "Completed" is "not paid yet". Refuse the file naming any missing or unknown column.
25. `grab-transfers.ts` (Create). **Slice 3.** Reads the payout rows (payout id, Net Total, status, transfer date). Does not keep bank account digits.
26. `foodpanda-workbook.ts` (Create). **Slice 3.** Reader. Open the xlsx (named ".xls"), find columns by header words (never by letter), read "Order Date" for the sales date, give per-order fee amounts per day, read the charges sheet, put PandaGO rows in the other-lines list, date undated charges to the last sales date, record the Platform Fee (column) month beside it. Accept a workbook with no orders sheet.
27. `deduction-mapping.ts` (Create). **Slice 3.** The table in Component I as data: platform column to deduction kind. An unlisted column stops the file.
28. `store-match.ts` (Create). **Slice 4.** Code to channel. One match, or refuse, naming the code. Matching ignores case and surrounding spaces.
29. `stage.ts` (Create). **Slice 4.** Pure function. Turn the reader output into one line per channel and sales date. Map commission columns to `commission`, ads (Grab Advertisement rows, Foodpanda CPC ads) to `marketing`, and all other charges and taxes to `platformFee`. The Platform Fee (column) attaches once per invoice, to the last sales day, or is relocated at staging time to the nearest earlier day whose order value less its own fees covers the fee. Loan disbursal is excluded from the sales deposit. A residual that the listed columns cannot explain marks the line "unexplained".
30. `day-checks.ts` (Create). **Slices 5 and 8.** `dayBlockers` and the checks behind it: complete, paid, charges explained, verified sales day, "no file for this day", earlier days. Each returns a named state. `approveDay` builds the context. The T-150 blockers come from calling `previewChannelSettlement` with the input from `settlement-input.ts`. Slice 8: the "period closed" blocker is skipped for a day covered by a deferral.
31. `settlement-input.ts` (Create). **Slices 5 and 8.** Pure function `buildSettlementInput(line, context)`: the mapping in Plan decisions, used by both `dayBlockers` (to call the T-150 preview) and `approveDay`. Slice 5: `settledOn` is the sales date, with no deferral lookup. Slice 8: the settled-on rule of Component H item 3, reading the deferral.
32. `loan-check.ts` (Create). **Slice 5.** Pure function. Apply Component F's allocation rule: older loan first, each up to its repayment amount; a row may split across two loans; a stored admin override wins. A loan with no repayment amount makes the day "no matching loan recorded". Returns OK, doesn't match, waiting for other stores' files, or no matching loan.
33. `ingest.ts` (Create). **Slices 4 and 5.** Domain function. Authorize first; check size, type and magic bytes; fingerprint; match store; read; pair Grab files; stage. `ingest` handles one file and takes a transaction (domain functions take `tx: Tx`, DEF-421); the upload action opens one transaction per file, as `channel-settlements/lib.ts` does with `withOrgPrincipal`, so a bad file refuses only itself; per-file results or a named refusal are returned. A line already booked with different figures gets a pending version flagged "changed since booked". A new upload that covers fewer days than the file it replaces returns a warning. Slice 5 adds: when a file arrives, re-run the loan check of dependent days across stores, and flag a booked day whose loan figures change.
34. `review.ts` (Create). **Slices 5 and 7.** One transaction each. `listReviewDays` returns what the screen needs. A manager sees only their own stores' lines (Goal 1) and, from the company-wide loan check, only the state "waiting for other stores' files", naming no store; a loan deduction shows its loan name and owner store only on the manager's own store (Goal 7). `rejectDay` (slice 5) requires a reason and posts nothing. `reopenDay` (slice 5, admin only) sets a rejected day back to pending, with a reason, and audits it. `overrideLoanAllocation` (slice 5, admin only). `approveDay` (slice 7) calls `dayBlockers`, refuses a blocked or non-current line, refuses the person who uploaded the file unless the approver is an admin, builds the input with `buildSettlementInput`, calls `recordChannelSettlement`, then writes `booked` and the settlement id. It supplies `settledOn` under Component H item 3. Approve, reject and override write the audit log; reads do not. All check store scope.
35. `index.ts` (Create). **Slices 3 to 5.** Exports; each export is added in the slice that creates the file it exports.

#### Domain: changes to existing code

36. `packages/domain/src/index.ts` (Modify). **Slice 3.** Export the new folder.
37. `packages/domain/src/channel-settlements/index.ts` (Modify). **Slice 6.** Posts money; changes require the full integration suite. Accept a list of loan legs instead of one loan. Replace `recognizeGain` with `acknowledgeDifference: { reason }`: a shortfall past the tolerance books to 6420, a gain to 7100. This also changes `SettlementPreview.needsGainAcknowledgement`, `ComputedSettlement` and `previewChannelSettlement`. Post one debit per leg, including the paired cross-store legs. Keep the settlement identity and the single place fees are booked. Void reverses the whole entry, including every leg, as today; it needs no loan-payment guard (the repayment is a leg inside the same entry).
38. `packages/domain/src/channel-settlements/deferrals.ts` (Create). **Slice 8.** `deferReceivable`: authorize (`override_period_lock`), validate the reason, record the deferred amount at defer time (not typed), insert (a second deferral supersedes the first), write the audit log. Options: all open channels for the period, or one.
39. `packages/domain/src/channel-settlements/README.md` (Modify). **Slices 6 and 8.** Document loan legs, the acknowledgement, deferrals and the staged-line caller.
40. `packages/domain/src/findings/index.ts` (Modify). **Slice 8.** The period-scoped hard detector `channelReceivableUnsettled` for each channel that is not remitted daily and has a non-zero 1220 balance at period end. Finding key `channelReceivableUnsettled:<channelId>:<YYYY-MM>`; `keyPeriod` already matches a trailing `:YYYY-MM`, so a test pins the key shape instead of changing it. It skips a channel and period with a deferral whose amount still equals the balance. No change to `closeBlockers`. Add a detector census test.
41. `packages/domain/src/field-rules/channel-settlements.ts` and `field-rules/loans.ts` (Modify). **Slices 2, 5, 6, 8.** Rules for the acknowledgement reason, the reject reason, the deferral reason, the platform code format, and the loan repayment amount, so the money-rule census passes (and the money columns are listed in `shared/money-positivity-census.ts`). New rules sit beside `LOAN_ADD_RULES`.
42. `packages/domain/src/files/limits.ts` (Modify). **Slice 2.** Add `channel_settlement_file` to `LIMIT_PURPOSES` (the compile-time equality check at `files/index.ts` must still hold), with CSV and zip types and the size limit from slice 1. The server action limit is 26 MB.
43. `packages/domain/src/files/magic.ts` (Modify). **Slice 2.** Accept a zip signature and a plain-text CSV check for the new purpose. `fileBytesMatchType` has no purpose argument today; the task spec decides how to add one.
44. `packages/domain/src/files/index.ts` (Modify). **Slice 2.** `PURPOSE_CAPABILITY` allows one capability per purpose: set it to `upload_settlement_files`. Reading a stored settlement file goes through the review screen's own check (`record_ar_collection`), a documented exception. Add an `EXTENSIONS` entry for csv and zip (it falls back to `.bin`).
45. `packages/domain/src/loans/index.ts` and `README.md` (Modify). **Slice 2.** New `updateLoanRepaymentAmount` (admin only, `edit_loan_repayment_amount`); `createLoan` takes the optional amount. A helper lists open loans for the loan check. There is no update function today, and `createLoan` is gated by `manage_chart_of_accounts`.
46. `packages/domain/src/sales-channels/index.ts` and `README.md` (Modify). **Slice 2.** New function to set and clear a channel's platform and code, authorized by `edit_platform_store_code` (admin only): trim, case-insensitive duplicate refusal with a named message, a format rule. `createSalesChannel` and `updateSalesChannel` keep `manage_store_settings`. List channels with their codes.
47. `packages/domain/package.json` and `package-lock.json` (Modify). **Slice 3.** Add the libraries chosen in slice 1. Do not add `xlsx` 0.18.5.

#### Permissions

48. `packages/auth/src/capabilities.ts` (Modify). **Slice 2.** Add `upload_settlement_files` (store scope, manager and admin), `edit_platform_store_code` (admin only) and `edit_loan_repayment_amount` (admin only). Wire every structure the file keeps: the `Capability` union, the `CAPABILITIES` array, the scope table, the area map, the role grid and the label list. Seeing the review screen, approve and reject reuse `record_ar_collection`. The allocation override reuses `edit_loan_repayment_amount`. Deferral reuses `override_period_lock`, only for its admin-only bar (Component J).
49. `docs/decisions/CAPABILITY-MATRIX.md` (Modify). **Slice 2.** A row for each new permission.
50. Capability tests (Modify). **Slice 2.** At the repo root `tests/unit/`: `capability-matrix.test.ts` (the count, and the elevated set, since admin-yes manager-no capabilities join it) and `t337-capability-areas.test.ts`. Under `packages/auth/tests/`: a test that the role without each new permission is refused.

#### Application screens (`apps/erp/src/app/channel-settlements/`)

51. `upload/page.tsx`, `upload/UploadForm.tsx`, `upload/actions.ts`, `upload/README.md` (Create). **Slice 4.** Multi-file picker. The action opens one transaction per file and passes raw bytes to `ingest`, and shows per-file results and named refusal reasons. Authorization is the first call in the action. The page calls `requirePageAccess`.
52. `review/page.tsx`, `review/ReviewTable.tsx`, `review/ApproveForm.tsx`, `review/actions.ts`, `review/lib.ts`, `review/typed-forms.ts`, `review/README.md` (Create). **Slices 5 and 7.** The day table (order value, recorded figure, difference, state, loan check, paid state), the charges, loan lines and other-lines tables, a "needs attention" filter, Foodpanda weeks grouped by invoice, the allocation override for admins, and reject per day with the reason box. `ApproveForm` is added in slice 7. Reads go through the manager-redacted view.
53. `apps/erp/src/app/channel-settlements/page.tsx` (Modify). **Slice 5.** Links to upload and review. A settlement booked from an upload says so. The task spec checks whether this route's missing entry in `route-capability.ts` is intended.
54. `apps/erp/src/app/channel-settlements/actions.ts`, `SettlementForm.tsx`, `lib.ts`, `typed-forms.ts`, and the tests `apps/erp/tests/t351-settlement-preview-render.test.ts`, `apps/erp/tests/integration/t343-s5-5v-followups.test.ts` `apps/erp/tests/integration/t343-s5-5s-followups.test.ts`, `packages/domain/tests/integration/t440-s6-money-refusals.test.ts` (it keys on the loan amount rule) and `apps/erp/tests/t440-s9-auth-first-guard.test.ts` (it names `recordChannelSettlement`), `packages/domain/tests/integration/_fixtures/t507-platform-ar.ts` (calls `recordChannelSettlement`), `packages/domain/tests/integration/t351-review-followups.test.ts` (uses `SettlementPreview`), `apps/erp/tests/integration/t389-s3-channel-settlements-web.test.ts` and `apps/erp/tests/t343-s5-5s-number-boxes.test.ts` (it asserts the single `loanAmount` input) (Modify). **Slice 6.** The existing callers of the single loan and `recognizeGain` inputs move to loan legs and the one acknowledgement. The form's single loan field becomes a list of legs: add or remove a leg (loan, owner store, amount); each amount above zero; the legs must add up to the loan deduction field.
55. `apps/erp/src/app/settings/sales-channels/page.tsx`, `actions.ts`, `lib.ts`, `typed-forms.ts` (Modify). **Slice 2.** The platform and code fields, shown and editable for admins only. The `/settings` route needs `manage_store_settings`; the admin-only fields are hidden from managers.
56. `apps/erp/src/app/loans/page.tsx`, `actions.ts`, `lib.ts` and `apps/erp/src/app/loans/[id]/page.tsx` (Modify). **Slice 2.** Show the repayment amount, and add a new edit form (none exists). The page needs `view_financial_reports`, so managers do not see it. The loan screen shows the interest gap (decision 11).
57. `apps/erp/src/lib/route-capability.ts` and `apps/erp/src/components/nav.tsx` (Modify). **Slices 4 and 5.** `nav.tsx` is pure data. The route entries filter it, and routes missing from `route-capability.ts` are open to any signed-in person. Add entries for `/channel-settlements/upload` (`upload_settlement_files`) and `/channel-settlements/review` (`record_ar_collection`), then the menu items.
58. `apps/erp/src/app/findings/page.tsx`, `actions.ts`, `lib.ts` (Modify). **Slice 8.** A `KIND_LABEL` entry for the new finding, and one admin action, "defer with reason" (all open channels for the period, or one; an open channel is defined in Component M), guarded by `override_period_lock`, which calls `deferReceivable`. Authorization first.
59. `apps/erp/src/app/README.md` (Modify). **Slice 5.** List the new routes.

#### Tests and fixtures

60. `packages/domain/tests/fixtures/settlement-intake/` (Create). **Slice 1.** The directory does not exist yet; slice 1 supplies it. Source: the owner's sample folder `C:\Users\ianla\SE\FOODPANDA INVOICES\2026` (June, July, August, OCT), outside the repo. The OCT folder holds Lipa, Malvar and Banay-banay files only (Grab Transaction and payment CSVs for 1 to 31 Oct, Foodpanda zips for 5, 12, 19 and 26 Oct); no Davao files were supplied, so slice 1 asks for them or records that Davao had none. The parent folder also holds unrelated files; copy only the settlement files, and only after redaction. Redacted real files (customer ids and bank digits removed): Grab Transaction and Transfers CSVs for a month; Foodpanda zips for the June layout, the October layout, a charges-only invoice, a PandaGO-only invoice, a changed-layout file, a zip with too many entries, an oversized expansion, and a nested archive.
61. `packages/domain/tests/unit/settlement-intake-*.test.ts` (Create). **Slices 3 to 5.** The readers, the mapping, safe zip, store match, stage, day checks, and the loan check on the October scenario (591.24 a day until 12 Oct, then 2,363.12 a day from 13 to 27 Oct; the 13 Oct split across three stores).
62. `packages/domain/tests/integration/settlement-intake-*.test.ts` (Create). **Slices 4 to 7.** Each case has its assertion in the spec. Cases: ingest; duplicate fingerprint; cross-organization; store-code unique index (case and spaces); one Grab file only, both, replace one; newest upload supersedes; "covers fewer days" warning; "changed since booked", also from a loan change; reject with store scope and permissions; an admin re-opens a rejected day, a manager cannot; compare-and-set race; a day with a difference above the limit (shortfall books to 6420 with a reason and is refused without one; gain books to 7100); a blocked day; fee relocation; loan disbursal excluded from the deposit; two loan legs in one entry; cross-store legs; void with legs; approving day N while day N-1 is unsettled is refused; a day before the channel's first staged day never blocks and a day with no recorded sales never blocks; the correction flow (cancel, then approve the newer version); a manager uploading another store's file is refused with "This file does not belong to your stores"; the legs-total trigger refuses at commit; the uploader cannot approve their own file but an admin can; the interest-gap display.
63. `packages/domain/tests/integration/` existing settlement tests (Modify). **Slice 6.** Update for loan legs; add the 0229 backfill test.
64. `packages/domain/tests/integration/settlement-month-close.test.ts` (Create). **Slice 8.** A month with an unsettled Grab receivable cannot close; the same month closes after an admin deferral; a manager cannot defer; the close is blocked again if the balance differs from the deferred amount; a deferred day books with `settledOn` in the open period; a non-deferred day whose `settledOn` falls in a closed period shows "period closed".
65. Repo-wide sweeps and baselines (Modify). **Slices 2, 4, 5, 6, 7, 8.** In `apps/erp/tests/`: `action-link-sweep.test.ts` and `t348-page-description-sweep.test.ts` (the new pages' links and descriptions), `touch-target-baseline.json`, the number-box tests (the new amount inputs), `t440-s9-auth-first-guard.test.ts` (the new actions), `t411-row-link-census.test.ts` and `t412-destructive-census.test.ts` (the reject and defer controls). At the repo root `tests/unit/`: `domain-actions-have-callers.test.ts`, `route-capability-coverage.test.ts`, `nav-route-reachability.test.ts`, `no-ungated-read-surface.test.ts`.
66. `apps/erp/tests/integration/settlement-review-render.test.ts` (Create). **Slice 5.** A live-route check of the upload and review pages on port 9008.

#### Documentation

67. `docs/tasks/511-*.md` (Create; T-511 is the feature, one spec per slice). **Slice 1 onward.** One spec per slice. Slice specs own what this plan leaves open: the exact column list for each staging table, the reason-code table (upload refusals and blockers, with message texts and a test per code), the exact header strings and row-kind values, the numeric caps, the libraries, the fixture redaction rules, and the worked Grab day and Foodpanda week.
68. `docs/GLOSSARY.md` (Modify). **Slice 9.** Sales date, order value, payout, staged line, pending, booked, rejected, platform store code, repayment amount, acknowledgement of the difference.
69. `docs/POSTING-PATTERNS.md` (Modify). **Slice 9.** The Foodpanda week (one entry per day, the Platform Fee (column) on the last day), Grab with two loan legs, a shortfall above the limit, and the disbursal exclusion.
70. `docs/decisions/ADR-NNN-*.md` (Create). **Slice 9.** Staging tables, loan legs, the deferral, and the AI fallback deferred.
71. `docs/CAPABILITY-GAPS.md`, `docs/ROADMAP.html`, `docs/WHATS-LEFT.html` (Modify). **Slice 9.** Mark the gap covered, add the slices, republish the status board.
72. READMEs (Modify). **Slices 2 to 8.** `packages/db/schema`, `packages/db/src/repo`, `packages/db/src/rls`, `packages/db/src/audit`, `packages/domain/src`, `packages/db/migrations`.

**Planner actions (not implementer scope):** `PROJECT_BIBLE.md` decision-log rows for every owner decision in this design (a spec must not list the bible in implementer scope, per RULES.md).

### Verification Plan

*   **Compilation/Build**: stop the local dev server, then `npm run build` from the repo root. CI builds on its own.
*   **Unit Tests**: `npm test` (the vitest unit project). Includes the migration journal guards, the same-organization census and the capability and audit-coverage guards.
*   **Static Analysis & Linting**: `npm run typecheck` and `npm run lint`, both clean (confirm the script names in `package.json`).
*   **Test Coverage Requirement**: every new permission has a refusal test. Every mapped column has a real-file test. Every refusal reason has a test.
*   **E2E/Integration**: the full integration suite on a fresh gate database for all three migrations (0229 drops a constraint and two columns and adds a trigger). A live-route smoke on port 9008.
*   **Real-file check** (slice 1 supplies the fixtures): run the October files through the readers. Grab payouts must match the Transfers control totals (30 of 31 in each store). The 12 Oct Lipa deposit must come out as 4,473.51 with the 150,000 left out. The loan check must show 591.24 a day until 12 Oct, 2,363.12 a day from 13 to 27 Oct, then 1,771.88. A Foodpanda week must add up to the recomputed Appendix A and Appendix B totals (the invoice grand total is only in the PDF), with the Platform Fee (column) on the last day. At the slice 5 exit, also check the screen on the Lipa days with an order after 23:00 (1, 5, 10, 19, 22 and 26 Oct, plus 21 Oct, the day an order booked a day late would show up) against the recorded figures from the exit-5 script. At the slice 5 exit, count how many October days would be blocked, and for what reason, to check the 15-minute target (confirmed by the owner) (a manual count is acceptable).

--------------------------------------------------------------------------------

*Drafted with EGM*
