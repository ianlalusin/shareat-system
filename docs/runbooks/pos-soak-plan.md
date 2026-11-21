# POS soak plan: scripted run at Lipa in TEST mode (Chrome, no printer)

**Purpose:** a scripted list of about 30 actions, each with a pass mark, to prove the new POS works with real staff and a real tablet before Lipa goes live. **Owner:** Ian (runs or delegates to the Lipa manager); BOSS collects the findings. Written for T-533 (R4), 15 Nov 2026.

## When and where
| | |
|---|---|
| **Soak #1** | **Sat 21 Nov 2026 at Lipa**, during a quiet window, with real staff and the real tablet |
| **Fallback / soak #2** | **Sat 28 Nov 2026, 2-4 pm** (also used if #1 finds a blocker) |
| **Where** | **Chrome on the tablet** at `erp2.shareat.net/pos` |
| **Mode** | Lipa set to **TEST** on `/admin/stores/[id]`. **No sales day is booked. Nothing goes to v1.** |
| **Printer** | **None in this soak.** Chrome cannot use the Bluetooth printer. Steps that print are marked "printing check, T-532" and are **skipped here**. The printing is built (the Android app is ready); it is tested separately on the real tablet (T-532 S5) |

This is the first of the two go-live gates. The other is the **printing check** with the Android app `net.shareat.erppos` (T-532 S5: built, but not yet tried on the real Lipa tablet), described in `pos-lipa-switch.md` section B. Lipa goes live only when **both** pass. The 24-hour two-tablet offline soak (0 sales lost, 0 doubled, row 431) is in `docs/ops/pos2-soak.md`; this script is the shorter, scripted Lipa run and does not replace it.

## Before you start (check each)
1. Open `erp2.shareat.net/pos` in Chrome on the tablet and confirm it loads.
2. `pos-lipa-switch.md` section A is done: stands and discounts loaded, pre-flight has no blocking items, Lipa is **Test**, tablet paired, you can sign in with Employee ID + PIN.
3. People at the soak: one **cashier**, one **server**, one **kitchen person**, one **manager** (has a PIN and "approve a POS correction"). Bring a **senior citizen ID card** (a test card number, or a real card with permission) for step 14.
4. A phone or second device is open at `erp2.shareat.net/pos/kitchen` (the Kitchen screen) and another at `/pos/refills`.
5. Write down the **start time** and the tablet's name.

## Pass marks, in one line
Every step below ends with a **Pass:** line. Mark each step Pass, Fail or Skipped. A Fail is a finding.

## The script
Tabs on the tablet: **Orders, Kitchen, Refills, Receipts, Till**.

### Part 1. Sign in and seat (about 15 minutes)
| # | Action | Pass mark |
|---|---|---|
| 1 | Open `/pos`. Sign in with Employee ID + PIN (cashier). | The Orders tab opens with the cashier's name |
| 2 | Sign in with a **wrong PIN** once. | A clear "wrong PIN" message; no lock-out; the right PIN works next |
| 3 | On Orders, **Seat a party** at a stand with a package and enter heads (for example 4). | The stand shows as open with 4 heads |
| 4 | Add one **a la carte dish** to that table. | It shows under **Items so far**; the total is right |
| 5 | **Send to kitchen.** | The dish appears on the Kitchen screen for its station within a few seconds |
| 6 | On the Kitchen screen, mark the dish **Served**. | It leaves the kitchen queue; the tablet shows it served |
| 7 | **Refills** tab (on the phone): ask for a refill of one meat for that table, then mark it **Served** on the tablet or Kitchen. | The refill appears in the queue and clears when served |
| 8 | On Refills, change the **heads** from 4 to 5 and **Confirm**. | The heads show 5 on the table; the bill includes the extra head |
| 9 | Seat a second party, then open a **Take-out** order and **Send take-out order**. | The take-out shows as its own order |
| 10 | **Switch cashier** (a second cashier signs in with their Employee ID + PIN). | The new name shows; the open tables stay |

### Part 2. Pay and discounts (about 25 minutes)
| # | Action | Pass mark |
|---|---|---|
| 11 | Tap **Pay** on table 1. Check the bill lines, VAT breakdown and total against the menu prices. | Total is right to the centavo |
| 12 | Pay in full with **Cash**; enter the amount tendered. | Change is right; the table leaves the grid; the sale shows under **Receipts** |
| 13 | **Reprint** the receipt. | **Printing check, T-532.** Skipped here. (The screen opens; do not test paper) |
| 14 | On a new table, give a **Senior discount** with a card: name, ID number, one diner. | The 20% senior discount and VAT removal show correctly on the bill; no error |
| 15 | Use the same senior card number again on another bill the same day. | A repeat-card **warning** shows; the sale is **not** blocked |
| 16 | Give a **PWD discount** to a second diner on a shared bill. | Each diner's discount applies only to that diner's items |
| 17 | Give a **line discount** (one dish) and an **order discount** (preset). | Both show; totals are right. If a manager PIN is asked, the manager's Employee ID + PIN is accepted |
| 18 | **Cancel a line** after it was sent. | A reason is asked; the line is removed; the kitchen sees it cancelled |
| 19 | **Split pay** a bill: **GCash** (with a reference number) plus **Cash**. | The two payments add up to the total; the sale is saved; GCash shows as "to check" |
| 20 | **Remove a discount** that was added by mistake. | A manager PIN is asked; the discount goes; total is right |
| 20a | **Void a table that was never paid** (T-620): seat a spare table, add a dish, then **Void**. Enter a reason. A cashier needs the manager's Employee ID + PIN; a manager signed in does not. | The table leaves the grid; the kitchen sees it cancelled; nothing appears under Receipts |

### Part 3. Internet down for 10 minutes (about 20 minutes)
Do not close or reload the Chrome tab while offline. If the tab closes or reloads and the POS will not open offline, record that as a **finding** and note the time.

| # | Action | Pass mark |
|---|---|---|
| 21 | Turn the tablet's Wi-Fi off. | An amber band says the tablet is offline and what still works |
| 22 | Seat a table, add dishes, and pay it in **Cash** while offline. | The sale saves; the screen says it is queued / sending when online |
| 23 | **Print a kitchen ticket** for the offline order. | **Printing check, T-532.** Skipped here |
| 24 | While offline, try **Close the day** (Till tab). | It refuses: "Closing the day needs the internet." |
| 25 | While offline, **switch cashier** with the other cashier's Employee ID + PIN. | The switch works from the saved list; no sale is lost |
| 26 | After 10 minutes, turn Wi-Fi back on and wait. | The band goes away; **Settings > Unsent sales** reaches **0** within a few minutes |
| 27 | Open **Receipts**. Check the offline sale appears **once**, and the numbers have no gap or repeat. | Exactly one receipt per offline sale; **nothing "Quarantined" or "Rejected"** |

### Part 4. X reading, Z reading, pairing (about 15 minutes)
| # | Action | Pass mark |
|---|---|---|
| 28 | **Till** tab: read the **X reading** ("Reading so far"). Compare receipts, gross, discounts and tenders to the Receipts tab. | The figures match. The X says the day is **not closed** |
| 29 | **Print X.** | **Printing check, T-532.** Skipped here |
| 30 | **Close the day (Z)**: tap **Close day**, enter the manager's Employee ID + PIN, confirm. | The Z closes with a Z number; the Till tab **History** shows it; **no ERP sales day is created** (TEST mode) and nothing is written to v1 |
| 31 | **Print Z / reprint Z.** | **Printing check, T-532.** Skipped here |
| 32 | **Un-pair and re-pair** the tablet: in the ERP, **Settings > POS tablet**: remove the tablet from the till, pair it again, link it to the till, sign in again on the tablet. | The tablet signs in again, and the till number series continues (no repeated receipt number) |
| 33 | **Last, only if time allows: wrong manager PIN 5 times** on the Z screen (or any manager-approval screen). | After 5 wrong PINs the tablet is **capped** with a message to see the store manager. **This locks approvals on that tablet for 24 hours.** An admin can clear it in the ERP (`manage_users`, on the till's terminal person), so do this step **last**, and have an admin ready |

That is 33 numbered actions (plus 20a); 4 are "printing check, T-532" and are skipped in this soak.

## What to record (use the table below, one line per problem)
| Step # | What happened | What should have happened | Time | Blocker? |
|---|---|---|---|---|
| | | | | |

- A **blocker** is anything that loses or doubles a sale, shows a wrong total, locks staff out, or cannot be fixed on the spot.
- Record **every** finding as a defect in `docs/DEFECTS-REGISTER.md` with the step number, the receipt number, and a screenshot. Do not put PINs, names or ID numbers in the register.
- Also write down: staff comments ("what was confusing?"), and anything that took more than 2 taps more than the old app.

## After the soak
1. Count the receipts on the tablet and under Receipts in the ERP. Test-mode receipts exist in the database but book no sales day.
2. Fill the result block in `pos-go-no-go.md`: steps passed / failed / skipped, number of sales lost (must be 0), number doubled (must be 0).
3. If there is **any blocker**, run **soak #2 on Sat 28 Nov, 2-4 pm** after the fix is deployed. Soak #2 must happen by Wed 2 Dec at the latest.
4. Leave Lipa in TEST. Do not switch to live: Ian decides after the go/no-go meeting.
5. The printing check (T-532) is done separately. See `pos-lipa-switch.md` section B.
