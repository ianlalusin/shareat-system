# POS practice copy (safe to click, nothing is real)

A fake store on your own PC. It uses the local Firebase emulators (a pretend Firebase that lives in memory and
forgets everything when stopped), project `demo-shareat-pos2`. No live data, no real keys, no real payments.
It uses spare ports so it does not disturb Docker, besh-frontend or your other servers.

| Thing | Port |
|---|---|
| Practice POS (open this) | 9019 |
| Pretend Firestore (database) | 8180 |
| Pretend Auth (logins) | 9189 |
| Pretend Storage (photos) | 9299 |

## Test logins (made-up, only exist inside the emulator)

| Who | Email | Password |
|---|---|---|
| Manager (use this one) | manager@pos.test | Practice-2026! |
| Cashier | cashier@pos.test | Practice-2026! |

Use the **manager** login. The cashier login lands on a "Sign in to the cashier station" screen that needs the
old v1 server (`/api/server-profiles`), which this app does not include. Managers skip that screen.

## Start it (3 steps, three terminal windows, from `apps/pos`)

1. Pretend Firebase (leave running):
   `cd emulator` then `firebase emulators:start --config firebase.practice.json --project demo-shareat-pos2 --only auth,firestore,storage`
   Wait for "All emulators ready".
2. Fill it with the fake store (run once each time step 1 is restarted; memory is wiped on stop):
   `set POS_EMULATOR_AUTH_PORT=9189` and `set POS_EMULATOR_FIRESTORE_PORT=8180` (PowerShell: `$env:POS_EMULATOR_AUTH_PORT=9189; $env:POS_EMULATOR_FIRESTORE_PORT=8180`), then
   `node scripts/seed-practice.mjs --confirm`
3. The POS (leave running; first page load takes about 30 seconds):
   `node --env-file=C:\Users\ianla\webapps\shareat-system\.env.local scripts/practice-start.mjs`
   (the env file is only used to find the throwaway database `shareat_test_pospractice` on port 5435).

Open **http://127.0.0.1:9019** (use `127.0.0.1`, not `localhost`: the page and the pretend servers must match).
Sign in with the manager login. Stop everything by closing the windows.

## Seeded store: Practice Branch

6 tables; packages Classic Unlimited P399, Premium P599, Supreme P799 per head; flavours Spicy, Garlic Butter, Original,
Honey Soy; refills pork, beef, chicken, rice, kimchi (+ "Lettuce extra" under Other); a la carte dishes and drinks;
add-ons (extra cheese, steamed egg, ice cream); payment modes Cash, GCash (asks for a reference), Card (shown only;
real card payment needs the internet gateway); discounts Senior Citizen 20%, PWD 20% (both VAT-exempt), Promo P50 off.
VAT-inclusive 12% store.

## 10-item practice checklist

Tick each one. Write down anything odd (screen, what you pressed, what you expected).

1. [ ] Open a table with a package: New Session, pick Table 1, 2 guests, Classic Unlimited, two flavours, Start Session.
2. [ ] Add items: open the session, add an add-on (extra cheese) and a drink.
3. [ ] Refill: Server screen, refill pork belly with a flavour, then rice.
4. [ ] Cash payment: pay a table in Cash, with change; check the receipt.
5. [ ] GCash payment: new table, pay by GCash, type any reference number (e.g. TEST123).
6. [ ] Split payment: new table, pay part Cash and part GCash.
7. [ ] Senior/PWD discount: apply Senior Citizen to a bill; check the VAT-exempt amounts.
8. [ ] Void an unpaid item (a line on an open table). Voiding a whole unpaid table needs the manager PIN (see below).
9. [ ] Refund: try on a paid receipt (needs the manager PIN step, see below).
10. [ ] X reading: Cashier screen, X reading (also needs the manager PIN step).

## Practice ERP (a fake company, safe to click)

A second local website: the back office (ERP) for a pretend company called **Practice Co**, with one store, **Practice Branch**.
It uses the same throwaway database as the practice POS (`shareat_test_pospractice`, on this PC only) and the same pretend Firebase.
No real data, no real Firebase project, no real keys, no server on the internet.

All made up. They only exist in the throwaway database:

| Who | What they are | PIN |
|---|---|---|
| Ian Practice | administrator (can do everything, approves refunds by default) | 135790 |
| Practice Manager | manager, holds "approve a POS refund or correction" at Practice Branch | 246801 |
| Practice Cashier | staff | 112358 |
| Terminal - Practice Branch | the practice tablet, registered as terminal 1 (login below) | none |

ERP "tablet" sign-in (the first screen): email **terminal@erp.test**, password **Practice-2026!** (a pretend account in the practice Firebase).
Then pick the person and type the PIN. The pretend Firebase forgets this account when it is stopped; run step 2 below again and it comes back.

Also seeded: chart of accounts, expense categories, 12 open months, and sales channels **Cash**, **GCash**, **GrabFood**, **Foodpanda**.
The practice POS store id is `practice-store`; the ERP store is linked to it, and the tablet is linked by its device id.

### Open it

1. Pretend Firebase and the practice POS must already be running (steps 1 to 3 above).
2. Fill the fake company (once; safe to repeat; run from the repo root, in a normal terminal):
   `node --env-file=C:\Users\ianla\webapps\shareat-system\.env.local scripts/practice-erp-start.mjs seed`
3. Start the ERP (leave running; the first page takes a few minutes the first time on this PC):
   `node --env-file=C:\Users\ianla\webapps\shareat-system\.env.local scripts/practice-erp-start.mjs dev`
   (the env file is only used to find the local database server; the starter refuses anything that is not a local `_test` database).
4. Open **http://127.0.0.1:9008**, sign in as above (Ian Practice, PIN 135790).
5. First time only, so refunds and readings on the POS work: the ERP must know the tablet. Easiest way: in the practice POS browser tab press F12, open Console, paste
   `localStorage.setItem('pos_device_id','00000000-0000-4000-8000-000000000c71'); location.reload()`
   (or copy the real id from POS Settings > Terminal and run step 2 again with `--device=<that id>` on the end).
6. The practice POS reads the company id from `apps/pos/emulator/.practice/org-id.txt` when it starts. If the POS was started before step 2 ran the first time, close it and start it again (step 3 of the POS list).

### What to try in the ERP

- **Record an expense:** Expenses > new expense. Pick Practice Branch, any category, an amount, save it. It should appear in the Expenses list.
- **Look at the sales day:** Sales days. After you sell something in the practice POS (checklist items 4 to 6), the day's sales show up here for Practice Branch (Cash, and GCash as a receivable).
- **See the receivables report:** Channel settlements (money that GCash, GrabFood and Foodpanda still owe the store). It is empty until a sales day with those channels exists; that is normal.

### Restart commands

- ERP: stop it (close its window, or end the program that listens on port 9008), then run step 3 again.
- Fill the company again after the pretend Firebase restarted: step 2.
- Check that a manager PIN is accepted, without touching the POS: `node --env-file=C:\Users\ianla\webapps\shareat-system\.env.local scripts/practice-erp-start.mjs check-approval`
- Log in without the sign-in screen (for scripts): `... scripts/practice-erp-start.mjs session <person id>` prints a one-hour cookie value (ids are in `apps/pos/emulator/.practice/practice-erp.json`).

## What works with the Practice ERP running

Items 1 to 8 only use the pretend Firebase. Items 9 and 10 call the POS server (`/api/pos2/*`), which checks the manager PIN and the tablet link in this database: with the practice ERP seeded and the tablet's device id registered (step 5) a manager PIN (246801) or the admin PIN (135790) is accepted and the cashier PIN or a wrong PIN is refused ("That PIN cannot approve this. Ask a store manager."). In this code the X reading itself asks for no PIN (only the Z reading, the day close, does); do not press Z unless you want a Z number used up in the pretend store.
Five wrong PINs from the tablet in one day lock it for 24 hours (re-run step 2 will not clear that; restart is not enough either, tell the orchestrator).

## What will NOT work here, and why

Card payment, printing, online orders, loyalty, AI insights, the SMS/QR gateways and the cashier "who is at the till" profile (v1 server) do not run.
