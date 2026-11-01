# T-504 — A sales channel is never zero or blank unless "No sales" is ticked

**Status:** SPEC (Opus, 1 Nov 2026). **Owner:** orchestrator. **Migration:** none. **Lanes:** Sonnet tester → Sonnet builder → Sonnet auditor.

## Why (Ian, 1 Nov)
> "dont let sales report record zero or null sales channel without ticking no sales checkbox"

A blank or 0 channel is ambiguous: "nothing sold" and "forgot to type it" look the same, and a forgotten Grab or
Foodpanda figure is a receivable nobody collects.

## Facts (read-only trace, 1 Nov)
- Form `apps/erp/src/app/sales-days/SalesDayForm.tsx:131-175`: one row per configured channel, amount `channel_<id>` +
  per-channel checkbox `nosales_<id>` (already exists).
- Action `sales-days/actions.ts:69-80` SKIPS a blank unticked channel (no row); a typed 0 unticked is saved as 0.
- Domain `packages/domain/src/sales-days/create.ts` `writeChannels` (:160-193), `edit.ts` (:125),
  `platform.ts:76-89` (feed-day "Platform sales": blank or ticked → 0 row). Only ticked+non-zero is refused.
- DB CHECK `sales_day_channels_no_sales_is_zero_check` (no_sales=false OR amount=0) stays. No migration needed.
- DEF-628 (open): an amount typed with "No sales" ticked is silently dropped in platform.ts:77.

## Rule
1. **Every channel row the person types must be either an amount > 0 or "No sales" ticked.** Blank or 0 with the box
   unticked is refused, in words: "{Channel}: type the sales, or tick No sales if there were none."
2. Where: on **save** (create, edit) and on **submit** (a completeness check: every active channel configured for the
   store that this form shows has a row with amount > 0 or no_sales = true). Submit's check also catches days saved
   before this rule.
3. Scope: typed days — every channel shown on the form (remitted and non-remitted). POS-linked feed days (source
   `pos_v1_day_feed`) — only the "Platform sales" section the person types (setPlatformSales); the POS-fed figures are
   not typed and are out of scope.
4. **DEF-628 fixed with it:** an amount typed AND "No sales" ticked is refused ("{Channel}: you typed sales and ticked
   No sales — choose one."), in platform.ts and create/edit alike, never silently dropped.
5. Action stops dropping blank-unticked rows: it passes them to the domain, which refuses.
6. Form: live rule (existing "Save is off until" pattern) naming each offending channel; Save/Submit off until fixed.

## Tests (tester, red first)
Blank unticked refused (create, edit, platform) · 0 unticked refused · ticked + blank → no-sales row · ticked + amount
refused (DEF-628) · amount > 0 saves · submit refuses an older day missing a channel row · feed day: POS-fed channels not
checked, platform section is · refusal sentence names the channel · existing sales-day tests still pass (fixtures that
relied on skipping blank channels get explicit amounts or ticks — never weaken assertions).

## Out
- Platform receivables on the AR aging report (separate question to Ian).
- Any migration.

## Added 1 Nov (Ian, same day) — commas, one Save, the form remembers

> Ian: 'The amount for "Foodpanda" — "16,980" is not a valid amount. Use at most two decimal places.' and "there is a
> separate save button, it must not be like that we must have 1 save button for whole sales report and form must
> remember its values like user type something then exit and go back to that date the form must load the drafted values"

7. **Thousands commas accepted** in the shared money-input parser (every form, not only sales days): `16,980`,
   `16,980.50`, `1,234,567.8` are valid; commas must be in correct groups of three (`1,5`, `16,98,0`, `,100` refused
   with the existing sentence). Spaces trimmed. The stored value never contains a comma. Unit-test the parser.
8. **One Save for the whole sales report.** The typed channels AND the feed-day "Platform sales" section save together
   with one button, in one transaction (setPlatformSales folds into the same save). No section has its own Save.
9. **Drafts.** Save keeps the day OPEN (a draft); blanks are allowed while drafting. **The rule in §Rule 1–2 is
   enforced at SUBMIT** (and a typed 0 unticked or amount+ticked is still refused at save, since those are never a
   half-finished state). Supersedes "on save" for blanks.
10. **The form remembers unsaved typing.** While the person types, the form keeps a browser-side draft keyed by
    person + store + business date (localStorage, wrapped in try/catch; works when storage is unavailable, just
    without the memory). Reopening that date restores the draft over the saved values and says so ("Restored what you
    typed on {time} — not saved yet." with "Discard"). A successful Save or Submit clears it. Nothing is sent to the
    server until Save; no autosave to the server (no audit churn).

## Rulings after the tester's pass (BOSS, 1 Nov)
1. **Feed days ARE covered at submit**: every active NON-remitted channel (Grab, Foodpanda, …) needs an amount or a
   tick — that is exactly Ian's case. Feed-day fixtures (s6Fixture and the files the tester listed) tick
   Foodpanda "No sales" explicitly, or type an amount. Never weaken an assertion.
2. Names as the tester pinned them (`salesDay.channels.tickedOrTyped`, draft-memory.ts exports, `data-draft-key`).
   Live rule: blank shows a hint and blocks **Submit** only; 0-unticked and amount+ticked block Save and Submit.
3. **One Save on a feed day:** `editSalesDay` takes optional `platform` rows and writes them in the same transaction
   (setPlatformSales's body becomes an internal helper it calls; the separate platform Save button and its action are
   removed, callers re-pointed). Add the domain atomicity test: a refused platform row rolls back the typed rows.
4. **Submit sentence names every missing channel** in display order: "Type the sales, or tick No sales, for: Grab,
   Foodpanda."
5. Retired channels are never required.
6. The edit page becomes a CheckedForm (live rules), like /new.
