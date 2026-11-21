# Lipa switch runbook: moving Lipa from the old POS trial app to the new POS

**Purpose:** the exact steps, owners and times to switch Lipa to the new POS, and to roll back. **Owner:** Ian (decides); an admin runs the steps; BOSS tracks. Written for T-533 (R4), 15 Nov 2026.

Read with: `docs/plans/pos-v2-design.md` section 8 (switch-over) and 8a (December bridge), `docs/runbooks/pos-soak-plan.md`, `docs/runbooks/pos-go-no-go.md`, `docs/ops/pos-soak-2026-11-21-checklist.md` (the Saturday trial sheet), `docs/ops/pos-v2-soak.md` (the two-tablet offline soak, not repeated here), `docs/ops/pos2-runbook.md`.

**Update 21 Nov 2026:** the printing work (T-532 S1 to S4) is built and live: the printer screen `/pos/printer`, the Android app `net.shareat.erppos` ("SharEat POS", built by CI as a signed APK) and the offline start. The only printing step still open is **S5, the real-tablet printing check at Lipa** (section B).

## The rules, in plain words
- Lipa stays **OFF or TEST** until Ian says "go" (bible row 435). Nothing here switches Lipa to live by itself.
- Only an **admin or super admin** can change a store's POS mode. They must give a reason. Every change is audited (row 456). A store manager is refused.
- A store switches at a **business-day boundary**, never in the middle of a day. A business day never mixes two sources.
- **Go-live needs two things, both:**
  1. the soak passes (24 hours on two tablets, 0 sales lost, 0 sales doubled; row 431), **and**
  2. the printing check passes (T-532 S5). This is a separate check on the real tablet with the Android app (the APK shell). The app is built; the check has not been done yet. The soak in Chrome cannot test the Bluetooth printer.
- The new POS does not write to the old v1 Firebase, except the **December bridge** (day totals only, until 31 Dec 2026, row 436).
- The load script only **reads** v1. Nothing here changes Lipa's v1 data.
- **Lipa's business rules must be seeded on production** (VAT, senior/PWD discounts, business-day start hour, table warning minutes). The pre-flight page shows if they are missing. Without them the switch is refused.

## What "mode" means
| Mode | What happens |
|---|---|
| OFF | The new POS refuses to sell. The old system runs as before. |
| TEST | The tablet can sell and close a Z. **No ERP sales day is booked. Nothing is written to v1.** Receipts are test data. |
| LIVE (from a date) | From that date, Lipa's sales days come from the new POS receipts. The v1 daily import stops for Lipa from that date. |

Test receipts are **not purged now**. They are purged by the **2027 cutover purge** (bible row 379). There is no separate purge for go-live. A live store ignores unclosed test receipts dated before its live date.

## A. Before the soak (done by Fri 20 Nov for the Sat 21 Nov soak)
Soak #1 is **Sat 21 Nov 2026 at Lipa**, in **Chrome on the tablet at `erp2.shareat.net/pos`**, with Lipa in **TEST** mode. Fallback / soak #2: **Sat 28 Nov 2026, 2-4 pm**.

Going live needs the store to be in TEST mode first; the switch refuses a store that is off.

| # | Step | Who | Done when |
|---|---|---|---|
| A1 | Merge and deploy T-533 (this PR). Check the deploy is green. | BOSS / merger | `erp2.shareat.net/admin/stores/[id]` shows a New POS card |
| A2 | Load Lipa's stands and discount presets from v1. First a **dry run** (writes nothing): `npm run pos:load-setup -- --store <id> --org <id> --actor <person uuid> --dry-run`. Read the counts and names it prints. The script runs on **Ian's PC, never the droplet** (no builds or tsx there). It needs `POS_BRIDGE_SA_KEY_FILE` (a READ-ONLY key for the v1 POS Firebase project) set in that PC's `.env.local`. This is a different setting from `POS_FIREBASE_SA_KEY_FILE`, which the pre-flight checks on the server. | Admin with `manage_store_settings` | The list looks right |
| A3 | Run the same command **without** `--dry-run`. Run it once more: the second run must change nothing. Read the gap report it prints (tenders with no v1 name, dishes with no kitchen station, packages with no refill items, staff with no badge or PIN). It never fixes these for you. | Same admin | Second run says no changes |
| A4 | Open the pre-flight page: `erp2.shareat.net/admin/stores/[id]/pos-preflight`. Fix every **blocking** item (each has a link to the screen that fixes it). Read the warnings. | Admin + Lipa manager | No blocking items |
| A5 | If the pre-flight lists the business rules (VAT, SC/PWD, start hour, table warning), fix them at Settings > Business rules. | Admin | Pre-flight no longer lists them |
| A6 | On `/admin/stores/[id]` (Lipa), New POS card: **Change POS mode** to **Test**. Type a reason, for example "Soak 21 Nov". **Confirm and switch**. | Admin / super admin | The card shows Test, who and when |
| A7 | Pair the tablet in the ERP: **Settings > POS tablet**. In the **Tills** section, choose the paired tablet for Lipa's till. Admins can also use `/admin/pos-tablets`. | Lipa manager or admin | The till shows the tablet |
| A8 | On the tablet open Chrome at `erp2.shareat.net/pos`. Sign in with **Employee ID + PIN**. | Cashier | The Orders tab opens |
| A9 | Make one quick test sale (seat a table, add one dish, pay cash), then follow `pos-soak-plan.md`. | Ian / manager | The sale shows under **Receipts** |

Notes:
- The v1 day import (the 06:00 job) **skips a live store's dates automatically** (T-533 S1). A database trigger (migration 0247) is the backstop. In TEST mode nothing changes for the import: v1 stays Lipa's sales source during the soak.
- Do **not** try to test printing in Chrome. Chrome cannot use the Bluetooth printer; the tablet only offers "Browser print". Real printing is tested in the Android app (section B).
- Two things staff can now do that the trial sheet can include: **void a table that was never paid** (T-620; a manager does it, or a cashier with the manager's PIN, and only online), and the **manager marks a GCash/Maya payment as checked** (T-623, still in review, not live yet; skip until it is merged).

## B. After the soak: the printing check (separate)
1. Install the APK shell `net.shareat.erppos` ("SharEat POS") on the tablet **beside** the old app. The signed APK is the artifact of the **POS shell build** run on GitHub (workflow `pos-shell-build.yml`). BOSS gets it and gives it to the manager. It opens `erp2.shareat.net/pos` and never replaces the old app.
2. Pair the Bluetooth printer first in the **Android Bluetooth settings**. Then in the app open **`/pos/printer`** (the Printer item in the POS header), choose the printer and tap **Print test slip**. The Printer screen only offers a printer inside the Android app; in Chrome it just uses the print dialog. Then print: a receipt, a reprint, an X slip, a Z slip, an outage kitchen ticket. Paper width (58 or 80 mm) and copies are set per till in **Settings > POS tablet > Tills**.
3. Pass mark: every slip prints, is readable, shows the right totals, and nothing prints twice.
4. Record the result in `pos-go-no-go.md`. Until it passes, Lipa does not go live.

## C. A week before go-live
- Pre-flight is green (no blocking items) and the warnings are understood.
- Menu, packages, refills, flavours, stands, tenders, discounts and kitchen stations are checked in the ERP (they are ERP-owned).
- Staff have badge codes and ERP PINs. At least one manager has a PIN and the permission "approve a POS correction" (needed for the Z).
- Every tender has a **v1 name** (needed for the December bridge). The v1 key file is on the server (the pre-flight checks it exists; it never shows it).
- Staff have used `docs/runbooks/pos-staff-sheet.md`.
- Backups verified (see `pos-go-no-go.md`).

## D. A day before go-live
| Step | Who |
|---|---|
| Pair the tablet again if it is new or was re-installed (a re-install is a new device). Settings > POS tablet. | Manager |
| Install the release APK `net.shareat.erppos` (T-532) beside the old app, and check `/pos/printer` still prints the test slip. | Manager |
| Make a test sale in TEST mode and refund it. | Manager |
| Pre-flight is green again. | Admin |

## E. Closing night on the old app (the night before go-live)
| Step | Who |
|---|---|
| Close every table. | Cashier |
| Empty the outbox (nothing waiting to send). | Cashier |
| Print the final v1 Z. | Cashier |
| Sign the trial app out on **every** tablet (guard 2 of section 8a). It must not add numbers to the same v1 document later. | Manager |

## F. Opening morning (go-live day)
| When | Step | Who |
|---|---|---|
| Before opening | On `/admin/stores/[id]`, New POS card: **Change POS mode** = **Live**, **live from** = today's business date, reason, **Confirm and switch**. The screen says exactly what will happen. It refuses if the date is in the past, a sales day for that date already exists, or pre-flight has a blocking item. | Admin / super admin, only after Ian's "go" |
| Before opening | Check the card shows Live and today's date. | Admin |
| Opening | Cashiers sign in with Employee ID + PIN on the new POS. | Cashiers |
| 06:00 next day | The v1 import skips Lipa automatically. Check the log says "skipped", not a red failure. | BOSS |

No test sales on the go-live day. Test receipts rung on the live date count as real sales in that day's Z. Finish test mode the day before, or pick tomorrow as the live date.

## G. First week: daily checks (every morning, manager or BOSS)
1. Receipt count and totals against the till count.
2. The quarantine list is empty (on the tablet: Settings > Unsent sales; nothing "Quarantined" or "Rejected").
3. Yesterday's **Z** is closed, and its sales day is **verified by a store manager or above who did not close the Z** (row 449).
4. The **bridge document** was sent to v1. Till tab > History shows the v1 status. If it says "Not yet sent to v1", a manager taps **Resend**. This runs only until 31 Dec 2026.
5. Anything odd goes in the defects register, with the receipt number.

## H. Roll-back (only if needed)
- **Next morning only, and only before any Z is closed on the new POS.** After a Z the screen refuses: "Days are already closed on the new POS. Roll back from the next day."
- Admin: `/admin/stores/[id]`, New POS card, **Change POS mode** = Test (or Off), reason, **Confirm and switch**.
- Reopen the old app. The v1 day feed resumes for those dates through the normal import.
- A business day never mixes two sources.

## I. Not covered here
- Malvar, Davao and Padre Garcia: 2027, one a week.
- Loyalty balances: not in release 1 (row 432).
- December stock usage: typed by hand in v1 (the bridge sends day totals only).
- Closing the Firebase project: 90 days after the last store (Ian).
