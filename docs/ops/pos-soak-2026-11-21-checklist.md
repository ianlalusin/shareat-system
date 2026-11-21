# Lipa POS trial checklist, Saturday 21 Nov 2026

For the owner and the Lipa store manager. It replaces the steps in `docs/runbooks/pos-soak-plan.md` and the staff
sheet that name screens which do not exist ("Settings > Unsent sales", the old Receipts tab).
Fallback date: Saturday 28 Nov, 2-4 pm.

Words used here:
- **TEST mode**: the new POS works, but nothing counts as a real sale. No money is booked.
- **ERP**: the office system at `erp2.shareat.net`. The new POS lives inside it at `erp2.shareat.net/pos`.
- **Pre-flight page**: an ERP page that lists what is still missing before the trial.
- Steps marked **[needs S1]**, **[needs S2]** or **[needs S3]** depend on a small fix in task T-601. If that fix is
  not live by Friday night, use the "if not ready" line instead.

## Part 1. Before Saturday (finish by Friday 20 Nov, in this order)

| # | What | Who | Where |
|---|---|---|---|
| 1 | **Type Lipa's menu into the ERP.** There is no automatic copy from the old POS. Enter the dishes, the packages with their price per person and extra-person price, the refills, the flavours, the kitchen stations and the lunch and dinner hours. If time is short, enter a smaller set: 2 packages, 5 refills, 10 dishes. Copy names and prices from the old POS admin screens. | Owner or admin | ERP `/menu` (dishes, packages, refills, flavours), `/menu/prices`, `/menu/hours`, `/kitchen` |
| 2 | Load Lipa's tables and discount presets from the old POS. Run the dry run first, then the real run, then once more (the last run must change nothing). This runs on the owner's PC only. | Admin | `npm run pos:load-setup` (see `pos-lipa-switch.md` A2-A3) |
| 3 | Fill in the receipt header: legal business name, TIN, address, phone; the store's branch code and address. | Owner | Settings > Organization; the Lipa store page |
| 4 | Set the payment methods for Lipa: Cash, and GCash (and Maya or card if used). Each one switched on. | Admin | Settings > POS link |
| 5 | Save the business rules: VAT, senior/PWD 20%, business-day start hour, table warning minutes. Also turn **on** "manager PIN for line actions", so a cashier needs the manager to cancel a line or give a line discount. | Admin | Settings > Business rules |
| 6 | Give the Lipa manager the permission **"approve a POS refund or correction"**. Managers do not have it by default. Without it, nobody can close the day. Check the manager has a PIN. | Owner | Admin > Users > the manager > Access |
| 7 | Check the cashier, server and kitchen person each have an Employee ID and a PIN, and the right position (Cashier, Server, Kitchen Staff). | Manager | `/staff` |
| 8 | Switch Lipa to **TEST** mode. Type a reason, for example "Trial 21 Nov". Only an admin can do this. | Admin | Lipa store page > New POS card |
| 9 | Pair the tablet and link it to Lipa's till. | Manager or admin | Settings > POS tablet |
| 10 | Check the tablet is registered for manager approvals (one active row for Lipa). The one made on 31 Oct was for the old app; check it is still active. | Admin | `/admin/pos-tablets` |
| 11 | **Open the pre-flight page and read the "Soak checklist".** Every line should say Pass. Each Fail says what to do and links to the screen. Fix them and reload. **[needs S1]** | Admin | Lipa store page > POS pre-flight |
| | *If S1 is not ready:* fix every item the page lists, then tick rows 1-10 above by hand. | | |
| 12 | Prepare a **made-up** senior card number and a made-up PWD number (for example SC-TEST-0001). Never use a real card in TEST: the number is still saved. | Owner | Trial bag |
| 13 | Sign in on a phone at `erp2.shareat.net/pos/kitchen` (kitchen person) and another at `/pos/refills` (server). | Manager | Phones |

## Part 2. On the day

People: one cashier, one server, one kitchen person, one manager (with a PIN and the permission from row 6).
Write down the start time. Use Chrome on the tablet. **Do not reload or close the Chrome tab** during the trial.
Chrome opens a print box after every sale. There is no printer today: tap **Cancel** each time.

| # | Who | Do this | You should see | Write down |
|---|---|---|---|---|
| 1 | Cashier | Open `erp2.shareat.net/pos`. Sign in with Employee ID and PIN. | The Orders tab with your name. A **TEST MODE** band at the top. **[needs S3]** | Pass or fail |
| 2 | Cashier | Sign in once with a wrong PIN, then the right one. | A clear "wrong PIN" message, then it works. | Pass or fail |
| 3 | Cashier | Seat a party at a stand: pick a package, enter 4 people. Add one dish. Send to kitchen. | The stand shows 4 people; the dish is under "Items so far". | Total shown |
| 4 | Kitchen | On the kitchen phone, find the dish and tap **Served**. | It leaves the list within a few seconds. | Seconds it took |
| 5 | Server | On the refills phone, ask for one refill for that table. Change people from 4 to 5 and tap **Confirm**. | The refill shows and clears when served; the table shows 5. | Pass or fail |
| 6 | Cashier | Make a take-out order and send it. Then tap **Switch cashier** and sign in as a second cashier. | The take-out is its own order; open tables stay. | Pass or fail |
| 7 | Cashier | Tap **Pay** on table 1. Check each line, the VAT and the total against the menu. Pay in **Cash**. | The change is right; the table leaves the screen; a receipt shows on screen. | Receipt number, total |
| 8 | Cashier | New table: give a **Senior** discount with the made-up card. Then use the same card again on another bill. | 20% off and no VAT on that diner's share. The second time: a warning, but the sale goes through. | Pass or fail |
| 9 | Cashier | Give a PWD discount to one diner on a shared bill. | Only that diner's items are discounted. | Pass or fail |
| 10 | Cashier + manager | Give a line discount and an order discount. Cancel one line that was already sent. | The manager is asked for their Employee ID and PIN; it is accepted. The kitchen sees the line cancelled. | Pass or fail |
| 11 | Cashier | Pay a bill half **GCash** (type a reference number) and half **Cash**. | The two parts add up; GCash shows "to check". | Receipt number |
| 12 | Cashier | Turn the tablet's Wi-Fi **off** for 10 minutes. Seat a table, add dishes, pay in Cash. Try **Close day** on the Till tab. | A yellow band says you are offline. The sale saves. Close day says it needs the internet. | Receipt number |
| 13 | Cashier | While offline, switch cashier. | It works from the saved list. | Pass or fail |
| 14 | Cashier | Turn Wi-Fi back **on**. Watch the small status label at the top right. | It goes from "Offline · N waiting to send" to "Sending…" to **Online** within a few minutes. | Minutes it took |
| 15 | Manager | Open the **Receipts** tab. **[needs S2]** | Every sale from today appears **once**, with its time, table, total and how it was paid. The top line says "no gaps". | Count, total, any missing numbers |
| | | *If S2 is not ready:* skip; use step 16's receipt count, and BOSS counts the receipts in the database after the trial. | | |
| 16 | Manager | **Till** tab: read **Reading so far** (the X reading). Compare the number of receipts and the total with the Receipts tab (or with your notes). | The figures match. It says the day is not closed. | Count, total |
| 17 | Cashier + manager | Tap **Close day**. The **manager** (not the cashier) enters their Employee ID and PIN. | A Z number appears and shows under History. No sales day is made in the ERP (TEST). | Z number |
| 18 | Manager + admin | In the ERP, Settings > POS tablet: unlink the tablet from the till, pair it again, link it again, sign in again. Make one more sale. | It signs in again. The receipt number carries on from the last one; no number repeats. | Receipt number |

Receipt numbers: the screen after paying shows a number like `T1-000123`; the Receipts tab shows `LIP-01-000123`.
They are the same receipt. **Compare the last six digits.** (One spelling for both comes later, task T-601 S5.)

Do **not** test five wrong manager PINs today. It locks approvals on the tablet for 24 hours.

## What to record

| Step # | What happened | What should have happened | Time | Stops the trial? |
|---|---|---|---|---|
| | | | | |

- A problem **stops the trial** if a sale is lost or doubled, a total is wrong, staff are locked out, or it cannot be fixed on the spot.
- Never write PINs, names on cards or ID numbers on this sheet.
- Also note: what confused staff, and anything that took more taps than the old POS.

## After the trial
1. Count the sales: your notes, the Receipts tab and the X reading must agree. Lost sales must be 0; doubled sales must be 0.
2. Give this sheet to BOSS. Every problem goes into the defect register with its step number and receipt number.
3. Leave Lipa in **TEST**. The owner decides on going live after the go/no-go meeting.
4. If anything stopped the trial, run it again on **Saturday 28 Nov, 2-4 pm**, after the fix is live.
