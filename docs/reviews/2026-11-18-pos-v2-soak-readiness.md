# POS v2 readiness for the Sat 21 Nov 2026 soak (read-only code review)

Reviewed 18 Nov 2026 on `wt-plans` (main at 9892641). Read, not run. No Node, no database, no production. Scope: ERP `/pos` (`apps/erp/src/app/pos/**`, `packages/domain/src/pos/**`).

**VERDICT: READY WITH FIXES.** The cashier's core day exists end to end and TEST mode does not reach the real books. Three things must be fixed or confirmed by Fri 20 Nov, or the soak cannot prove or fail anything: the Lipa menu, the manager-approval link, and the Receipts screen the script relies on.

## Step table
| Step | Works? | Evidence | Gap |
|---|---|---|---|
| Pair tablet (Settings > POS tablet) | Yes | `settings/pos-tablet/actions.ts:44`, `admin/pos-tablets` | One live tablet per store: pairing a second replaces the first |
| Sign in, Employee ID + PIN | Yes | `sign-in/TabletSignInForm.tsx`, `sign-in/actions.ts:116` | 5 wrong PINs pause that ID 5 min (`_shell/messages.ts:7`) |
| Open day / till | Partly | `day-close.ts:116` (day is implicit) | No open-float step on `/pos`; drawer count lives on ERP `/till` (`till/page.tsx` comment, row 319) |
| Seat table, heads, package per head | Yes | `_orders/OrderDialogs.tsx:70-79`, `order.ts:195-240` | None |
| A-la-carte at start | Yes | `inbox.ts:107` (`stand.opened` carries `lines`), T-518 | None |
| Add items, send to kitchen | Yes | `OrderDialogs.tsx:79`, `payloads.ts:93` | Station routing needs `kitchen_station` on every item (pre-flight warning only) |
| Kitchen screen (KDS), mark served | Yes, online only | `kitchen/actions.ts:28`, `_kitchen/access.ts` | Kitchen browser needs its own sign-in and `serve_pos_ticket` (Kitchen Staff default grants it) |
| Refills, heads confirm | Yes | `_refills/access.ts`, `refills/actions.ts` | Confirm heads works only on an UNPAIRED phone (`access.ts:13`), not on the tablet |
| Cancel a line | Yes | `inbox.ts:119`, `OrderDialogs.tsx:176` | PIN only if setting On (default Off) |
| Line discount, preset, every-line | Yes | `_payment/DiscountSheet.tsx`, `discounts.ts` | Same default-Off PIN setting |
| Mark free | Partly | Only as a custom 100% line discount (`registry.ts:134` help text) | No dedicated "free" action |
| Senior / PWD | Yes | `sale.ts:232-270`, `PaymentPanel.tsx:420`, `senior-repeat.ts` | Repeat-card warning online only |
| Void unpaid table | **No screen** | `session.voided` handler exists (`inbox.ts:147`) but nothing in `app/pos` builds it | A mistaken seat stays on the stand grid; `Pay` is off with no lines (`OrdersView.tsx:147`) |
| Split payment, cash/GCash/card, change | Yes | `PaymentPanel.tsx:235,470`, `sale.ts:226` | Tender kinds are only `cash` and `wallet` (`schema/pos-v1.ts:47`); card is a wallet tender with a reference |
| Short payment | Yes | `sale.ts:342`, `registry.ts:114` (default 0.01) | None |
| Receipt on screen, reprint of THAT sale | Yes | `_payment/ReceiptScreen.tsx` | In Chrome every Finish opens the browser print dialog (`pos-print/adapter.ts:48-80`) |
| Receipts tab / old receipt reprint | **No** | `receipts/page.tsx:17` says "Receipts are not on this screen yet." `listTodaysSalesReceipts` has no caller | Soak steps 12, 13, 27, 28 and staff sheet 5 use this tab |
| Receipt identity | Yes | `receipt-identity.ts`, `pos-print/header.ts` | Prints store name only if org legal name/TIN/address are empty (no warning) |
| Receipt number | Mismatch | Paper: `T1-000123` (`_payment/logic.ts:105`). Server/register: `LIP-01-000123` (`sale.ts:253`) | Two specs disagree (T-528 line 141 vs T-524 line 145) |
| Deposits / reservations | **No** | `docs/DEFECTS-REGISTER.md` DEF-842 "ERP /pos has no reservations or deposits" | Lipa takes deposits today in v1 |
| Refund, wrong-tender correction | **No** | DEF-832, DEF-855 "no refunds yet"; offline band says refunds wait | Cashier has no way to fix a paid sale |
| Offline sell, queue, re-sync | Yes (device) | `PosShell.tsx`, `lib/pos-device/outbox.ts`, `inbox.ts:360-420` | No service worker in `apps/erp/public`; reload or tab change offline may fail (see unjudged) |
| Quarantined sale review | **No screen** | `listPosQuarantine`, `replayQuarantinedEvent` exported (`pos/index.ts:22-24`), zero callers in `apps/erp` | DEF-851 says "check the manager review path in the 28 Nov soak": there is none |
| X reading, Z close, manager approval | Yes, online | `TillPanel.tsx:182-306`, `day-close.ts:255-270` | Needs a live `pos_terminal_links` row and an approver holding `approve_pos_correction` (see blocker 2) |
| Z to ERP ledger | Live mode only | `day-close.ts:493` derives sales day only when mode is live; `verifySalesDay` by a second person | Not exercised in TEST; no stock usage is deducted from v2 receipts (runbook section I) |
| Mode switch, pre-flight | Yes | `store-mode.ts:96-150`, `preflight.ts`, `admin/stores/[id]/PosModeForm.tsx` | Pre-flight skips the link and approver checks |

## TEST mode: what it isolates
- Isolated: no ERP sales day (`day-close.ts:493`), no v1 bridge (`day-close.ts:566`), nothing to the ledger, no stock usage.
- Leaks, all purged by the 2027 cutover (`cutover/classification.ts:270,1610-1635`): every TEST sale writes `statutory_discount_records` rows (source `pos`, real-looking invoice number, `sale.ts:266`); receipt numbers and Z numbers keep counting into live; audit rows stay.
- A REAL senior/PWD card typed in the soak lands in that register (soak plan step 14 allows a real card). Use a made-up number.
- Nothing on the tablet, receipt or Z slip says TEST. A cashier cannot tell TEST from LIVE on screen.

## BLOCKERS for Saturday (ranked)
1. **Lipa's menu.** ERP `/pos` reads ONLY the ERP menu (`snapshot.ts:12` `loadStoreMenu`). `POS_MENU_SOURCE=firestore` exists only in frozen `apps/pos`. No v1 menu importer exists (`docs/tasks/510-menu-dayparts.md:126`). "Menu stays on v1 Firestore" is true for the old app, not for `/pos`. If Lipa's items, packages (per-head price), refills, flavours, kitchen stations and lunch/dinner windows are not entered in ERP `/menu`, the tablet has nothing to sell. Owner: confirm the ERP menu is loaded, or say who enters it by Fri.
2. **Manager approval link and grant.** Z, manager PIN on line actions and table void all need an ACTIVE `pos_terminal_links` row for Lipa (`pos-v2.ts:179`, `day-close.ts:255`) and a PIN owner holding `approve_pos_correction` (manager does NOT hold it by default, `capabilities.ts:928`). Pre-flight does not check either, and no soak-plan "before you start" line mentions them. Lipa's link was made 31 Oct for the old app; check it is still active at `/admin/pos-tablets` (and the terminal person still has its Firebase credential at Lipa). Without it steps 17, 20, 30, 33 fail with "tablet not registered".
3. **Receipts tab and "Settings > Unsent sales" do not exist on `/pos`.** The script and staff sheet name them (steps 12, 13, 26, 27, 28; staff sheet 5 and 7). Step 27 (sale appears once, no gaps) cannot be checked on any screen. Fix before Saturday, either way: (a) rewrite those steps to use the Till X reading (count, gross, tenders) and the top-bar pill ("N waiting to send"), plus a read-only database count by ops after the soak; or (b) build a Receipts list (small: `listTodaysSalesReceipts` already exists).

## Should fix (before go-live; some before Saturday)
- Switch ON `pos.require_pin_line_actions` for Lipa before the soak (default Off, `registry.ts:134`): today a cashier can cancel a line or mark an item free with no PIN (DEF-833). It is not in the pre-flight list either.
- Add a visible TEST band on the tablet and a TEST line on receipts and Z slips (mode is already in the snapshot, `snapshot.ts:63`; nothing reads it).
- Build a manager screen for quarantined sales (`listPosQuarantine` and `replayQuarantinedEvent` are ready). Required before go-live; DEF-851 and the go/no-go both lean on it.
- Add a void-unpaid-table button (server path exists, `sale.ts:49-82`), a refund / wrong-tender flow (T-534, not started), and decide on deposits.
- Decide the receipt number format (`T1-` vs `LIP-01-`) and make paper, register and audit say the same.
- Make the pre-flight check the active terminal link and at least one approver holding `approve_pos_correction`.
- Retire or relabel `docs/ops/pos2-runbook.md` and `docs/ops/pos2-soak.md`: they describe frozen `apps/pos` (Firebase, "Settings > Terminal", APK) and are not the `/pos` soak. Staff sheet Tagalog lines are still blank.
- Chrome prints through the browser dialog on every Finish and every outage kitchen ticket; warn staff to cancel the dialog. Real printing needs T-532.

## Pre-soak checklist for Lipa (owner = needs Ian or an admin)
| # | Item | Where | Owner |
|---|---|---|---|
| 1 | Lipa menu loaded in ERP: items, packages with per-head price (and extra-head price), refills, flavours, stations, lunch/dinner windows | `/menu` | Ian |
| 2 | Lipa stands and discount presets loaded (`npm run pos:load-setup`, dry run first, key `POS_BRIDGE_SA_KEY_FILE`) | Ian's PC | Ian or admin |
| 3 | Pre-flight shows no blocking items | `/admin/stores/<id>/pos-preflight` | Admin |
| 4 | Four rules saved (not defaults): VAT, senior/PWD 20%, business-day start hour, table warning minutes. Also set sale tolerance, repeat-card days, and PIN-on-line-actions to On | `/settings/business-rules` | Admin |
| 5 | Lipa set to TEST with a reason (admin or super admin only) | `/admin/stores/<id>` | Admin |
| 6 | Tablet paired with email sign-in, then linked to Lipa's till (till number set) | `/settings/pos-tablet` | Manager or admin |
| 7 | Active `pos_terminal_links` row for Lipa | `/admin/pos-tablets` | Admin |
| 8 | A manager or admin with a PIN and `approve_pos_correction`, DIFFERENT from the cashier who closes the Z | Staff, access grid | Ian |
| 9 | Cashier, server and kitchen people have Employee ID + PIN and the right position (Cashier: `record_sale`; Server: refill, heads; Kitchen Staff: `serve_pos_ticket`) | `/staff` | Manager |
| 10 | Tenders for Lipa: Cash (kind cash), GCash, Maya, card, each kind correct and active | `/settings/pos-link` | Admin |
| 11 | Receipt issuer: org legal name, TIN, store branch code, address, phone; VAT-registered flag | Settings > Organization, store page | Ian |
| 12 | Receipt paper width and copies per till | Settings > POS tablet > Tills | Manager |
| 13 | Kitchen browser (phone) signed in and open at `/pos/kitchen`; server phone at `/pos/refills` | devices | Manager |
| 14 | Made-up senior/PWD card number for steps 14 to 16 | soak bag | Ian |
| 15 | Soak plan and staff sheet amended for blocker 3 | `docs/runbooks/` | Planner |

## Open DEF rows tagged POS (`docs/DEFECTS-REGISTER.md`)
- Real in ERP `/pos`: DEF-833 (no PIN on line actions unless the setting is On; T-576 built, setting Off), DEF-851 (manager review path missing), DEF-832 and DEF-855 (no refunds).
- Real only in frozen `apps/pos`: DEF-835, DEF-837, DEF-842, DEF-844. DEF-652 (loose v1 Firestore rules) stays until v1 retires.
- Closed or by design in `/pos`: DEF-831, DEF-852, DEF-853, DEF-854.

## Could not judge from code
- Whether production already holds Lipa's ERP menu, stands, presets, tenders, rules, link row and grants (all data).
- Offline behaviour in plain Chrome: there is no service worker, so reloading the page or moving between tabs while offline may fail. Watch steps 21 to 26; the script already says do not reload.
- Real tablet speed and memory, Chrome IndexedDB eviction, the print dialog on the actual tablet.
- The Z to sales day to ledger posting with real money (live only); the printing path (T-532) and the 24 h two-tablet soak.
- Whether a stuck stand clears itself on the next business day.
