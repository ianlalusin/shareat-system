# T-507 — Platform receivables (Grab, Foodpanda) on the receivables report

**Status:** SPEC (Opus, 2 Nov 2026). **Owner:** orchestrator. **Migration:** none. **Lanes:** Sonnet tester → builder → auditor.

## Why (Ian, 1–2 Nov)
> "inspect why manually inputed grab and foodpanda sales are not showing in receivables and sales" … "yes add platform
> receivables to the receivables report"

## Facts (read-only trace, 1 Nov)
- A verified sales day posts Dr `channel.receivable_account_code` (normally **1220**, party_type `channel`, party_id =
  the channel) / Cr 4150 (routing.ts receivableLines). POSTING-PATTERNS.md: "T-123 raises 1220 on every verified
  Foodpanda/Grab day".
- `/reports/ar-aging` and `packages/domain` ar.ts read ONLY 1210 (AR_CONTROL_CODE, ar.ts:25; ar-aging/page.tsx:74).
- Platform money owed shows today only on `/channel-settlements` (derived from 1220 by party; settlements credit 1220).
- Only VERIFIED days post; unverified days are not receivables yet (correct — the screen should say so).

## Build
1. `/reports/ar-aging` gains a second section **"Due from delivery platforms"**, one row per channel (party on the
   channel's receivable account — read the account from `sales_channels.receivable_account_code`, never hard-code 1220),
   with the same aging buckets as the customer section, aged by the journal entry date of each open debit, FIFO-matched
   against credits (settlements) per channel — reuse the customer aging's matching logic, do not write a second one.
2. A line under the section: "Only verified sales days appear here. {n} day(s) with platform sales are waiting for
   verification." with a link to the sales-days list filtered to unverified (count from sales_days not verified that
   have a non-remitted channel amount > 0, in scope).
3. Totals: the customer section total ties to 1210's balance; the platform section total ties to the sum of the
   platform receivable accounts' balances per channel (tie-out tests both).
4. Each channel row drills to `/channel-settlements` for that channel (existing screen; no new drill page).
5. Same capability and store scope as the existing report (store-scoped party lines: a manager sees only their stores'
   platform receivables — confirm 1220 lines carry store_id; if not, the section is org-wide and only shown to
   whole-org viewers, and the tester reports which).
6. CSV export of the report (if the report already has one) includes the platform section.

## Out
- Changing how or when platform sales post (still at verify).
- Settlement screen changes.

## Rulings after the tester's pass (2 Nov)
1. Domain shape as the tester pinned (`getArAgingReport(...).platform = {rows, totals, controlBalance, reconciles,
   waitingForVerification}`). 1220 lines carry store_id, so the section is store-scoped like the rest.
2. Receivable account read from the channel; the test fixture's 1250 channel is fine. No change to which accounts accept a party.
3. Add an **"Waiting for verification"** filter to /sales-days (`?status=unverified` = open + submitted); the line links there.
4. Drill link `/channel-settlements?channel=<id>` (the existing preselect) is right.
5. Same gate as the existing page (record_ar_collection); no new visibility rules.
6. Wording as pinned.
