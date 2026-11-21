# T-614: POS v2 follow-ups before go-live

**Owner:** builder (Sonnet). **Spec:** BOSS (Opus), 21 Nov 2026. **Ian, 21 Nov:** "keep building the pos too".
Each slice is one commit, with tests that fail without the fix (a mutant). Lines are approximate; re-locate on current main.

## S1: refund bigger than a method's takings (T-613 D2, design approved by BOSS 20 Nov)

Today a Z whose refunds for a payment method exceed that method's takings is refused, because the sales day can't hold a negative cash or wallet figure (DEF-940, open).

- **At the Z** (`writeZ` in `packages/domain/src/pos/day-close.ts`, next to `postConversionsForZ`), for each method whose refunds exceed its takings in the window, post the **excess** as its own entry:
  - Dr **4950** (sales returns and voids) / Cr the money account: cash = the cashier drawer 1110 at the store; a wallet = 1140 with its money account as party.
  - Dated the Z business date.
  - `source_type = 'pos_refund_excess'`, idempotency key `pos_refund_excess:<closeId>:<cash|moneyAccountId>`.
  - Live stores only; TEST books nothing.
- **`deriveSalesDayFromZ`:** floor each negative method at 0 and reduce the day's `refunds` figure by the same excess, so the sales day still balances and nothing is counted twice.
- **Voiding or correcting** a sales day derived from that Z must reverse the excess entry too. Find the existing sales-day void path; if it can't reach the entry, stop and report.
- **Docs:** add `sale.pos-refund-excess` to `docs/POSTING-PATTERNS.md` (follow the house format; regenerate the TOC with `npm run toc`) and a worked-example fixture if the doc test requires one.
- **D3's refund-only Z** now closes. Mark DEF-940 fixed (T-614) in the register.
- **Tests:**
  - A ₱500 cash refund of yesterday's sale against ₱200 cash taken today: the Z closes, the day shows cash 0 and refunds ₱200, and an excess entry of Dr 4950 300 / Cr 1110 300 posts. The ledger balances.
  - A wallet case.
  - TEST mode books nothing.
  - Replaying the Z gives one entry.
  - Voiding the day reverses it.
  - **Mutants:** no floor, so the sales day goes negative and is refused; the excess not posted, so the ledger is short.

## S2: the receipt look-up window becomes a setting (no hard-coded business values, Ian 5 Nov)

`RECEIPT_LOOKUP_DAYS = 30` in `packages/domain/src/pos/sale.ts` (T-613 D4) is a business value.
- Add a business rule `pos.receipt_lookup_days`, default 30, minimum 1, maximum 365, unit days, through the existing business-rules registry. **If the registry needs a seed migration, stop and report the number to BOSS first.**
- Read it in `findSalesReceiptByNo`. It shows on `/settings/business-rules` like the other `pos.*` rules.
- **Tests:** the rule value changes the window. **Mutant:** the constant is read instead.

## S3: offline cold start covers every `/pos` tab, and every sign-out clears the saved shell (T-532 S4 known limits)

- **Precache:** on the first online load, the service worker (`apps/erp/public/sw.js`) also caches the static chunks of every `/pos` tab: Orders, Kitchen, Refills, Receipts, Till and Printer. A tab never opened online then opens offline too. Fetch each tab's HTML once in the background after install, then cache the chunks it references. Keep `/api/*` never cached.
- **Sign-out from anywhere** (the ERP sidebar sign-out action as well as the POS shell) purges the saved `/pos` shell, so the cached page never shows the last person's name.
- **Tests:** unit tests of the routing and precache list; a sign-out purge test. **Mutants:** the precache list empty; the purge not called from the sidebar sign-out.

## Out

- Refund approval by a second manager, and reprinting old receipts with a REPRINT mark: not asked for now.
- T-535 items (preset discount screen, Online tab, stock-usage drafts): after the freeze.
