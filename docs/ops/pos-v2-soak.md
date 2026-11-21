# POS v2 offline soak: the 24-hour, two-tablet run (go-live gate, bible row 431)

**Written 21 Nov 2026.** The older file `pos2-soak.md` is the soak for the old Firebase app `apps/pos` (`net.shareat.pos2`), which is being retired. POS v2 now lives inside the ERP at `erp2.shareat.net/pos`, and the Android app is `net.shareat.erppos` (T-532). Do not use that file's steps or scripts for POS v2.

Not the same thing as the Saturday trial. The short scripted run (about 30 actions, Chrome, one tablet) is `docs/ops/pos-soak-2026-11-21-checklist.md` and `docs/runbooks/pos-soak-plan.md`. This file is the longer proof: **two tablets, about 24 hours, with real offline stretches.**

**Pass mark:** 0 sales lost and 0 sales doubled (row 431). Latest start date: Wed 2 Dec 2026 (`docs/plans/pos-v2-design.md`, section 9). Run by Ian or the Lipa manager. Nothing here touches real money: Lipa stays in **TEST** mode.

Words: **outbox** = sales saved on the tablet that have not reached the server yet. **Receipts tab** = the list of the day's sales on `/pos`.

## Before you start
1. Lipa is in **TEST** mode and the pre-flight page has no blocking items (`pos-lipa-switch.md` section A).
2. Two tablets, both paired to Lipa (Settings > POS tablet) and linked to **two different tills**. Both run the **Android app `net.shareat.erppos`**, installed from the same signed APK (the artifact of the POS shell build, `pos-shell-build.yml`). Never a debug build.
3. Each tablet signs in with an Employee ID and PIN. Write down each tablet's name and till number.
4. The status label at the top right says **Online** on both. Open the **Receipts** tab on both and write down today's receipt count before you start.
5. Do not clear the app's data or storage on a tablet that has unsent sales. That would delete them.

## The run (about 24 hours)
1. **A normal offline stretch.** Switch both tablets to airplane mode for several hours. Sell at least 60 sales per tablet: cash, GCash with a reference number, and two payment methods on one bill. Try a card payment and a refund: both must say they need the internet. Void a table nobody paid (T-620) as a manager: it needs the internet and must say so offline.
2. **Wi-Fi on and off.** For one hour, every 5 to 10 minutes turn the Wi-Fi on for 1 to 2 minutes, then off again, while still selling. The label must go from "Offline 12m, N waiting to send" to "Sending..." to "Online" and back. Sales must stay counted as waiting until the server has them.
3. **Close the app right after paying.** Pay a sale and, within 1 second, swipe the app away. Then once force-stop it from Android settings. Reopen it, also with no internet (the offline start from T-532 S4). The sale must still be there, and the next receipt number must not repeat. Do this at least 10 times per tablet.
4. **Update during an outage.** Once T-621 is live (it adds the update gate), do a deploy while a tablet is offline with sales waiting. The tablet must keep running the old screens and not lose a sale. Until T-621 is merged, skip this step and write "skipped". Also do an **in-place APK update during an outage**: install the newer signed APK over the old one (never uninstall first) while the tablet is offline with sales waiting. Every waiting sale must still be there and send once the internet is back.
5. **Unsent money warning and the 4-hour slip.** Also from T-621 (not live until merged): with more than 50,000 pesos unsent, a warning shows and selling continues; an X slip prints every 4 offline hours. Skip and write "skipped" until it is live.
6. **A change made in the office while the tablet is offline.** In the ERP, void an unpaid table that a tablet has open. Reconnect. The tablet must not lose its other sales. Write down what the screen says. BOSS then checks in the database whether any sale was set aside (there is no manager screen for set-aside sales yet).
7. **Reconnect and wait 10 minutes.** Both tablets must say **Online** with nothing waiting.

## Check (read-only)
For each tablet:
1. **Receipts tab:** the count must equal the count before you started plus the sales you rang. The top line says whether any numbers are missing (a missing number is a finding to write down, not proof a sale was lost).
2. **Till tab:** the X reading (Reading so far) matches the Receipts tab: same count, same total, day not closed.
3. **Doubles:** no receipt appears twice. Compare the last six digits of each receipt number.
4. Give BOSS the notes. BOSS checks the database for receipts that never arrived or arrived twice. Every problem goes in `docs/DEFECTS-REGISTER.md` with the step number and receipt number.
5. Leave Lipa in **TEST**. Do not close the day for real unless the test plan says so.

Also read: `docs/ops/pos2-runbook.md` is about the retired Firebase server and is not part of this run.
