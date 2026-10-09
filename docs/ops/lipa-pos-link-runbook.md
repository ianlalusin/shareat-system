# Runbook: link Lipa to POS v1 (Monday 12 Oct 2026, bible row 284)

You do this at `https://erp2.shareat.net`, signed in as **admin or super admin**. Linking, tenders and money
accounts all need `manage_chart_of_accounts` (admin and super admin only; a manager is refused). Importing needs
`submit_sales_day`; **Verify & post** needs `verify_sales_day` (manager, admin, super admin) and should be a
different person from whoever imported. The report needs `view_financial_reports`.

Lipa's POS store id: `L5MExycvUOfQ96Y10FqF`. Its 4 POS payment methods (census 2026-10-07, GATE PASS):
**Bank Transfer, Cash, Gcash, QRPH**. POS "charges" post to other income 4500 (row 279), nothing to map.

## 0. Prechecks (do not start until both are true)
1. Production is on migration **0186** with the T-379/T-380 S1a push live. Ask Claude to confirm; it is a server
   check, not a screen. If not live, stop: the link act and the import both ship in that push.
2. The POS key works. On your laptop (Git Bash) run the step-4 command in `docs/ops/pos-v1-key.md`:
   `200` = go. `401` = POS has not picked up the key map. `403` = Lipa is not in the map. Anything else: stop.
3. **Lipa has no unverified typed sales days.** Open **Sales days**, pick Lipa. Every typed day must be Verified
   (or voided). Linking is refused otherwise (see step 5).

## 1. Map the 4 methods to money accounts (before linking)
Open `/money-accounts` (Money accounts) and look at Lipa's accounts. I could not see production, so **you decide
which exist**. What the code requires:
- **Cash** needs no account: it is a "cash" tender and goes to Lipa's cashier drawer on its own.
- **Bank Transfer, Gcash, QRPH** each need a *bank or e-wallet* money account of **Lipa** (a cash drawer is
  refused; another store's account is refused; a retired account is refused).
- If an account is missing, add it on `/money-accounts` under **Add a money account**: Name, Store = Lipa, Kind
  (e-wallet or bank), Held by. Names suggested: "GCash - Lipa", "Bank - Lipa" (the bank that receives transfers),
  and one for QRPH (**you choose**: QRPH lands in a bank account; use the same bank account as Bank Transfer unless
  the money really goes elsewhere).
- **You must choose**: which bank account receives Bank Transfer, and where QRPH settles. Nothing defaults.

Then open **Settings > POS link** (`/settings/pos-link`), Lipa's card, section **Tenders**. For each, fill
**New tender** and press **Add tender**:
| Name | Kind | Money account | POS name |
|---|---|---|---|
| Cash | Cash | (none) | `Cash` |
| GCash | Wallet | Lipa's GCash account | `Gcash` |
| Bank Transfer | Wallet | Lipa's bank account | `Bank Transfer` |
| QRPH | Wallet | the account you chose | `QRPH` |
POS name matching ignores capitals, spaces and dashes ("G-Cash" = "gcash"). Banner "Tender added." after each.
If a tender already exists, use its **Save** button to set the POS name / account instead.

## 2. Link Lipa
Same page, Lipa's card, top form:
1. **POS store**: choose the Lipa entry (id `L5MExycvUOfQ96Y10FqF`). If POS shows "isn't connected", the page shows
   boxes instead: type that id and the store name. If the list is missing, go back to step 0.2.
2. **Sales channel POS's sales land in**: Lipa's daily-remitted channel (only those are offered).
3. **Tax type**: **VAT inclusive** (row 279: VAT is a label, final prices include it). Never "VAT exclusive".
4. Press **Link store**. Banner: "Lipa is linked to POS." and the badge turns "Linked to ...".
5. Tenders section: the amber note "POS methods not mapped yet" must be **gone** (it lists any method still unmapped).

**There is no effective-date box.** The link takes effect the moment you press the button, so "Monday" means: press
it on Monday 12 Oct, not before. The system does not cut by date; from that second:
- Lipa's **typed** sales-day form is gone for **every** date, including past dates not yet typed. Past dates up to
  Sunday 11 Oct that were never typed can still be **imported from POS** (step 3), but not typed.
- Days already typed and verified stay as they are (shown "Typed"). New days show "POS".
- Staff: stop typing Lipa figures. They press **Import from POS** for a date. The database also blocks any other way
  of writing a Lipa sales figure (migration 0185).
- Delivery platforms (non-till channels) still get their small **Platform sales** entry on the day page.

## 3. First import
When: after Lipa's POS day is closed, so normally the morning after. For Mon 12 Oct that is **Tue 13 Oct**.
(Today's open day may import but will change; re-import while it is open or submitted.)
1. **Sales days > New sales day** (`/sales-days/new`), Store = Lipa, **Business date** = the day, press
   **Import from POS**.
2. You land on the day page. **Good:** source "POS"; the figures show; every method sits on its tender (Cash on the
   drawer, the three wallets on their accounts); channel rows and charges (other income 4500) look right. It is
   **still a draft**: nothing is posted yet.
3. Compare to the POS Z-report for that date: total sales and each method by hand, once, on this first day.
4. Press **Submit**, then a *different* person presses **Verify & post** (this is what recognises the revenue,
   dated the business date). Do this for each imported day.
If POS later changes an unverified day, press **Re-import from POS** on the day page.

## 4. Verify and reconcile
1. Open **Reports > POS reconciliation** (`/reports/pos-reconciliation`), Store = Lipa, Date = the day, **Apply**.
2. **Good:** the card shows POS's figure and the ledger's figure equal (delta zero, matches).
3. Press **Check POS again** (needs verify rights): it stores a fresh POS reading. After every later import, the
   system also re-checks the 7 days before it by itself.
4. If a verified day shows "POS now reports ... paid for this day; it was ... when the day was posted", POS changed
   after posting. On the day page use **Post correction** (pick the date, type a reason).
Do this daily for the first week.

## 5. If something is refused
Link refusals (each leaves nothing changed):
- "Lipa still has typed sales days that aren't verified (dates). Verify or withdraw them before linking it to POS."
  Verify or void those days, then link again.
- "That sales channel belongs to a different store." / "...needs a channel whose money is remitted daily." /
  "That sales channel is retired." Pick Lipa's active daily-remitted channel.
- "That POS store is already linked to ..." Id is used by another store; check the id.
- "That is not one of the stores POS lists. Choose a POS store from the list."
Tender refusals: "...is a cash drawer. A wallet tender pays into a bank or e-wallet account." / "...isn't one of
this store's." (wrong store's account) / "...retired money account" / "Another tender of this store already
answers to ... from POS." / "This store already has a tender called ...". Fix the one field named.
Import refusals (nothing is saved; fix, then import again):
- "POS took P... as "X", which isn't set up as a tender for this store..." A POS method has no tender: add it
  (step 1). "The tender for "X" has no money account": set it. "...money account is no longer active": pick another.
- "POS has no sales for Lipa on <date>. The day waits until POS has them." The day is not closed or has no bills. Wait.
- "POS couldn't be reached..." Try later. "The POS connection isn't set up on this server..." Redo
  `pos-v1-key.md` step 3 (`POS_API_URL`, `POS_API_KEY`), restart the service.
- "<date> is already verified. If POS changed since, it shows under Findings and is corrected there." Use step 4.4.
- "POS's payments for <date> are less than its sales..., This has to be fixed on the POS." / "POS shows P refunded
  ... but only P cash taken" / "POS's charges ... are more than its sales" / "POS didn't send ..." / "...isn't a
  whole number of centavos" / "negative figure": a bad POS day. Do not retry; send the date and sentence to Claude.
- "This store adds VAT on top of its prices in POS..." You chose VAT exclusive: re-save the link with VAT inclusive.
- "This day was typed in before the store was linked to POS. Ask the office." Should never appear.

**Undo / unlink (live since 2026-10-08, T-382, migration 0187).** A super-admin can unlink a store from POS on
/settings/pos-link with a reason; it is audited, refuses while an imported day is still unverified, and the store's
POS id never links to another store. Imported-but-unverified days can also be voided on their day page.

**Updates 2026-10-09.**
- Lipa's tenders (production, 8 Oct): Gcash, Bank (POS "Bank Transfer"), QR (POS "QRPH"), all wallets into Cashier
  online. Still to add before the first import: **Cash** (Kind Cash, no money account, POS name `Cash`) and
  **Collected off the till** (Kind Cash, no money account, POS name `collected`) — bible row 292. On a day with a
  "collected" amount, record the same day whether it was an owner drawing or part of that day's remittance.
- From T-385 (PR #3, migration 0188): **Verify & post only works on a submitted day, and the person who submitted
  it cannot verify it — except a super-admin** (bible row 293).