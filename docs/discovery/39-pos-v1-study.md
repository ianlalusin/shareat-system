# POS v1 study for the POS v2 phase plan

Read-only pass, 2026-10-15. Repo: `C:\Users\ianla\webapps\POS` (branch sev5_advanced, working tree as found).
Method: bible §1.2d (source -> goal -> live-data signals -> flaws). v1 owns the GOAL, never the method.
No production counts were possible. "Needs a count" marks where a number must come from Firestore/POS MIGRATION.
Note: one `git log` was run once by mistake on POS (read-only, output unused). Nothing else.

## 0. Already documented (cite, do not redo)

| Topic | Where |
|---|---|
| Entity/path inventory, sale lifecycle, void/re-ring/refund, online order state machine, sessionMode, money, receipt numbering, offline, PayMongo, analytics, 8 external routes | `docs/discovery/09-pos-system.md` (557 lines) |
| Preserve/improve/correct split; offline vs bible §5.3 rule 1 (a sale is a recorded fact); "no POS phase before Jan" | `docs/discovery/22-pos-build-assessment.md` |
| 24 h offline, device storage, one Postgres, per-device table ownership | `docs/discovery/pos-offline-and-data-tiers-proposal.md` (DECIDED rows 274-276) |
| Copy POS v1 into `apps/pos`, strangler swap, interim "day feed" | `docs/discovery/pos-sales-usage-integration-proposal.md`, ADR-015 (rows 269-273) |
| Usage pull redesign (derive usage from receipts at P2) | `docs/discovery/pos-pull-redesign-proposal.md` (PROPOSED) |
| Cash custody, till reconciliation, SC/PWD statutory discounts | `docs/discovery/24-cash-custody-and-statutory-discounts.md`, `CAPABILITY-GAPS.md` ~L244 (SC/PWD name+ID not captured, live exposure) |
| Glossary traps (dineInSales package-only, takeOutSales residual, receiptSeq two spaces, billOnServe, sessionMode) | `docs/GLOSSARY.md` L15-135 |
| Open DEFs: DEF-001/002 (receipt numbers), DEF-004/005 (sessionMode/channel), DEF-021 (refill magic numbers) | `docs/DEFECTS-REGISTER.md` |

This file adds: current size, per-capability goal/flaw view, and findings NOT in 09/22.

## 1. Tech stack and size (re-measured today)

| Item | Value |
|---|---|
| Stack | Next.js 16 (App Router) + React 18 + Firebase client SDK 10 + firebase-admin 13, Tailwind/Radix (shadcn), Capacitor 6 Android shell (app id net.shareat.pos; npm name culinaryflow), Genkit + Anthropic SDK (AI), PayMongo REST. `package.json` |
| Hosting | Firebase App Hosting (SSR + /api); APK loads static export from `https://localhost` and calls app.shareat.net cross-origin (`src/middleware.ts:1-47`); Cloud Scheduler for 10 cron jobs (`docs/CRON.md`, project shareat-hub-v2) |
| Files / LOC | 671 files, ~107k LOC under `src/` (09 measured 601 / 98.9k on 25 Aug: +70 files, +8k LOC in 7 weeks, still growing) |
| By area (non-test LOC) | components/cashier 11.1k, admin 7.3k, lib/server 7.0k, manager 6.4k, dashboard 4.9k, ui 4.6k, lib/analytics 3.2k, server 2.5k, receipts 2.2k, session-timeline 1.7k+1.0k, qr-wallet 1.4k, pins 1.3k, kitchen 1.2k, printing 1.1k |
| Pages / API routes | 49 pages, 62 API routes |
| Tests | ~87 test files; 78 of them in `src/lib` (pure logic). Only 3 under components, 5 under app, 3 rules-emulator suites (`tests/rules`). The sale engine `components/cashier/firestore.ts` (1,526 lines) has no test file beside it |
| Biggest files | `lib/types.ts` 1,869 · `cashier/firestore.ts` 1,526 · `admin/menu/products/page.tsx` 1,152 · `kitchen/page.tsx` 1,130 · `components/receipts/page.tsx` 984 |
| Repo litter | `out/` 15 MB (static export), `ds-bundle/` 4.8 MB, `firestore-debug.log`, a file literally named `git status`, empty `shareatv5`, `firestore.indexes.json.bak` |

## 2. Roles, auth, devices

1. v1 (source): Firebase Auth login; `staff/{uid}` doc holds `role` (admin|manager|cashier|kitchen|server), `assignedStoreIds`, `status` (`context/auth-context.tsx:16,73-79`). `isPlatformAdmin = (role === 'admin')`. Page gating by `RoleGuard` (`components/guards/RoleGuard.tsx:36-43`); API gating by `requireStaffStoreAccess` (`lib/server/staff-access.ts:12-47`). Home per role: cashier /cashier, kitchen /kitchen, server /server.
2. Goal: shared tablets per station, yet every action attributable to a person; stores see only their own data.
3. Device-level "local profiles" (`serverProfiles`) with 6-digit passcode: admin/manager skip it, cashier/server/kitchen must pick one (`lib/server-profiles/localGate.ts:9-13`). Passcodes verified only server-side via `/api/server-profiles` (ops verify/create/reset-passcode/delete, `route.ts:61,141,182,217`), scrypt with legacy SHA-256 re-wrap on sign-in (`lib/server/server-profile-secrets.ts:1-70`). Attribution to the profile uses a module-level global `setActiveLocalProfile` (`lib/server-profiles/activeLocalProfile.ts`).
4. Signals: staff exist as Firebase users AND as local profiles; ERP maps POS profiles via `/api/external/staff-profiles`. Needs a count: staff docs per role, profiles per store.
5. Flaws (candidates):
   - A. Role limits on receipt void/edit are UI-only. `firestore.rules` lists locked config collections (L63-67) but NOT `receipts`; the store catch-all lets any active store staffer write them. A kitchen or server login could void a receipt from devtools. Reported, needs a rules test.
   - B. 6-digit passcode has only 10^6 values; safe only because verification is server-side. v2 must keep rate limiting and lockout (not confirmed in `verify`; needs a read).
   - C. Attribution through a global variable is fragile across async work and multi-tab.
   - D. Admin == platform admin == role 'admin' with no per-capability grants; v2 has CAPABILITY-MATRIX and positions.

## 3. Ordering, tables, packages (core selling)

1. v1: Cashier `startSession` (`cashier/firestore.ts:145-353`, a writeBatch): creates `sessions/{id}`, flips the table (two copies: `tables` and `storeConfig/current/tables`), writes the `activeSessions` projection, and for unlimited package creates the package bill line plus a kitchen ticket. Dine-in starts `pending_verification`; a server confirms headcount (`ServerPageClient.handleVerify`, `:153-193`), `guestCountFinal = max(cashier, server)`. Guest-count and package changes use a request/approve state machine (`ApprovalQueue.tsx`, `approveGuestCountChange` `firestore.ts:1083`). À la carte starts `active`. Bill lines carry qty, voidedQty, freeQty, per-line adjustments (`types.ts:690-732`). Concurrency guard `billingRevision` bumped on every line edit (`firestore.ts:1176,1320,1357`) and checked at payment (`:478-480`).
2. Goal: sell a per-head unlimited package whose real headcount is verified by the floor (no under-billing), let diners add à la carte, route to kitchen stations, and take walk-in/take-out à la carte.
3. Package shape: one `pricePerHead` per store package, optional "bundle" (flat price for N pax, extra heads on a second line) (`types.ts:357-390`). `menuScheduleId` exists for time-gated menus. No child/senior/age per-head tiers. Signals: bundle fields and `reconcileBundleLines` (`firestore.ts:1208`) show a real, recent need. Needs a count: package mix, bundle share, how often guestCountChange is requested.
4. Flaws:
   - E. Dual-write projections (`sessions` + `activeSessions` + `closedSessions`, `tables` + `storeConfig` tables, KDS fan-out `rtKdsTickets`; 09 §1.2). Every writer must keep copies in step. v2: one row plus views.
   - F. Take-out is not a thing (sessionMode has two values; DEF-004/005). Delivery is a bill line (Delivery Fee addon), not a channel.
   - G. Grab/Foodpanda orders ARE rung through POS: the double-void incident receipt had reason "grab order cancel" (`docs/void-double-count-fix.md:8`). The glossary and T-375 say platform sales are typed per day and kept outside POS. The two statements disagree. Needs Ian (Q1).

## 4. Kitchen / KDS / refills / online orders

1. v1: KDS reads `rtKdsTickets/{kitchenLocationId}` (denormalised map). Ticket status preparing -> ready -> served | cancelled | void; addon tickets support batch serve with `serveLog` (`types.ts:541-658`). `billOnServe` for diner self-orders: bill line created at serve (glossary). Refills: server taps via `RefillPOSModal.tsx` (869 lines), limited to the package's `refillsAllowed`; `lib/refill-selection.ts`, `lib/refill-visibility.ts`. The refill cooldown (60 s anchored on serve) lives in the CUSTOMER app (`CUSTOMER/src/app/api/customer/refill-options/route.ts`); POS source has no cooldown.
2. Goal: kitchen sees what to cook where, in order; refills are unlimited but paced; unserved orders never become revenue.
3. Online orders: separate collection and state machine (09 §2.9); `OnlineOrdersClient.tsx` 918 lines; completion mints a receipt with `sessionMode:'alacarte'`. The storefront menu is a rebuilt snapshot `storefrontCatalog/main` (`/api/admin/storefront-catalog`). Needs a count: online orders per day per store.
4. Flaws: KDS station-doc update is unguarded when absent from cache (09 §6.6 M1). KDS stats are rebuilt from tickets that may be purged (09 §8 risk); a retention plan exists (`docs/superpowers/plans/2026-08-22-dispensable-data-retention.md`), needs a read to see whether it purges tickets.

## 5. Payments and tenders

1. v1: Modes of payment per store (`storeModesOfPayment`: type cash|card|online|other, `hasRef`, optional `gateway:'paymongo_qrph'`, `types.ts:852-866`). Split tender in `payment-modal.tsx:119-338`. Completion (`cashier/firestore.ts:422-870`, runTransaction): checks `totalPaidCents >= amountDueCents-1`; change only allowed against cash (`:629-642`, throws if change > cash paid); stores `mop` keyed by method NAME, net of change (`:644-650,725`). Receipt number from `counters/receipts` (`:616-620`). Offline twin `offlinePayment.ts`. Static QR (GCash/Maya) shown as an image only, photo proof, no amount or reference recorded (`qr-wallet`, `paymentProofs`, 15-day TTL). PayMongo QR Ph auto-confirm via `/api/pos/paymongo/create-qr` + webhook with HMAC and `processedEventIds[]` (`api/webhooks/paymongo`).
2. Goal: take any tender the diner uses, give correct change, know per-tender totals for drawer and wallet reconciliation, never record a number nobody verified.
3. Signals: `mop` by NAME feeds `/api/external/payment-methods`, which unions configured names with names seen in the last 14 day docs "to cover legacy/renamed modes" (09 §9.2) = renames really happen. ERP maps these names to money accounts (tender master, T-375).
4. Payment conversion (NOT in 09): `components/dashboard/PaymentConvertModal.tsx` (606 lines) + `/api/analytics/payment-conversion` let cashier/manager/admin record a net-zero "conversion" that moves part of a day's payment mix from one method to another (create + void), written to the analytics doc, not to receipts (`lib/server/analytics/applyPaymentConversionServer.ts`). Goal (inferred): fix the day's tender totals when the till was rung wrong. Consequence: analytics payment mix can differ from the sum of receipt `mop`; `scripts/settle-payment-mix-drift.ts` exists to rebuild drift. Needs a count: conversions per month (per store). Candidate flaw H: a tender correction must correct the receipt (as an auditable adjustment) so every total follows.
5. Other flaws: tender keyed by display name (a rename splits history; v2 uses tender id, T-375 `tenders` master). `creditCardPayments` always 0 in ERP (glossary). Float pesos (09 §4).

## 6. Discounts, charges, voids, refunds, corrections

1. Discounts/charges: store and global lists (`storeDiscounts`, `globalDiscounts`, ...; fixed|percent, scope bill|item, stackable, date window `startDate/endDate`, `vatExempt`) (`types.ts:813-838`). Line adjustments with qty caps; loyalty rewards stack after (`lib/tax.ts:60-207`). Senior/PWD = a discount flagged `vatExempt`: the whole bill becomes VAT-exempt and the discount is taken on the VAT-removed net (`tax.ts:131-156`, added by CHANGELOG H-2). Charges (service charge etc.) fixed or percent of subtotal/total.
2. Goal: promos and staff discounts configurable per store without code; statutory SC/PWD (20% + VAT exemption) computed correctly; every discount auditable.
3. Signals: `discountEventIds`, `discounts` on the receipt, activity log `DISCOUNT_EDITED`. Discount math changed on 2026-06-12 (CHANGELOG): about 12% more discount on VAT-inclusive stores since the cutover, so history mixes two definitions. Needs a count: receipts with `vatExempt`, discounts by name.
4. Flaws: I. SC/PWD discount applies to the entire bill, not only the senior/PWD diners' share (`tax.ts:131-156`; no per-person split). J. No name/ID capture (CAPABILITY-GAPS ~L244, already a live exposure). K. Single flat `taxRatePct` per store, no per-item tax class (fine today). L. Receipt header prints "TIN ... VAT|Non-VAT" only (`lib/printing/receiptFormatter.ts:39`).
5. Void unpaid session: `voidSession` (`firestore.ts:877-1001`), reason required (`void-session-dialog.tsx:38-40`), cancels live tickets, frees the table, reverses loyalty redemptions.
6. Void paid receipt: manager/admin only in the UI (`app/receipts/page.tsx:736-739,755,781`); a manager cannot void an edited receipt. Cash disposition (refunded|retained|partial) and re-ring link are designed in `VoidReceiptModal.tsx`, `ReRingLinkModal.tsx`.
7. Refund: `createRefundReceipt` (`firestore.ts:1451-1520`), negative receipt, `receiptSeq 0`, number `RF-<parent>` (`:1484-1490`), so a second partial refund collides (DEF-001).
8. Receipt correction: `components/receipts/EditReceiptDialog.tsx` (524 lines) lets manager/admin edit lines, discounts, payments and customer TIN of a PAID receipt in place; reason required; keeps `editVersion`, `lastDiffSummary`, a `receipts/{id}/revisions/{v}` subcollection (rules L54) and an activity log. If the edit lowers the total, the excess is treated as a refund drained from cash first (`:36-70`). Goal: fix cashier mistakes after the fact without voiding the sale. The NEED stays; but v2's immutable-receipt rule (row 272, refund = new receipt on its own day) means this becomes adjustment/reversal documents. Biggest design tension in the POS port (Q3).
9. Live-data signal: the 27 Jun 2026 double void (SELIP-5471, 3,503 pesos) double-reversed analytics and under-reported the day (`docs/void-double-count-fix.md`). The fix is described in `components/receipts/page.tsx:517-540` (transaction + cash disposition).
10. FINDING M (reported, confirm against the deployed branch): `components/receipts/page.tsx` (the transactional void with cash disposition, VoidReceiptModal and ReRingLinkModal) is imported by NOTHING. The routed page `app/receipts/page.tsx` has its own older `handleVoidReceipt` (`:497-538`): plain `updateDoc` status flip, no transaction, no cash disposition, then analytics reversal. Two near-identical 900-line forks, and the live route lacks the fix the incident doc describes. If the deployed build matches this tree, the double-void bug and the void/cash-drawer fields are not live. Verify what shipped before porting either.

## 7. Shifts, cash drawer, Z-reading, business day

1. v1: Only a "cash handover" log: `cashHandovers` doc with startingCash, cashSales, deductions[], expectedCash = start + cashSales - deductions, countedCash, variance, outgoing/incoming names (`components/cashier/CashHandoverClient.tsx`, `lib/cash/handover.ts`). `computeCashSales` sums cash entries of receipt `analytics.mop` over a window, ignores refunds, includes cash retained on voided receipts unless re-ringed (`handover.ts:44-80`). Described in code as "purely a log for accountability".
2. Goal: cashier-to-cashier handover with a counted drawer and a visible variance; no accounting posting.
3. Signals: the ERP has its own `CashRemitShiftPlain` (opening source float|manual|handover, prevShiftId chain; CAPABILITY-GAPS ~L284), i.e. the ERP re-derives shifts that POS only logs. Needs a count: handovers per store per day, variance distribution.
4. NOT PRESENT in POS: X/Z reading, end-of-day lock, BIR sales invoice/OR series, PTU/machine ID, cumulative grand total, reprint trail. The only "BIR" match is the customer-TIN label in the edit dialog (`EditReceiptDialog.tsx:444`). Receipt numbers are `SELIP-######` (`firestore.ts:109-116`). Not found does not mean not needed: ask Ian whether POS v2 must be BIR-accredited (Q2).
5. Flaws: N. Three day boundaries around one business: analytics day = Manila midnight (`lib/analytics/daily.ts:86-110`), handover window starts 4 AM Manila (`handover.ts:11-19`, whose comment points to a `getShiftDayId` that does not exist), and the ERP shift day is 05:00 (GLOSSARY). A closing shift past midnight splits across two analytics days. v2 needs ONE named business-day rule per store (bible §5.1 shift-day vs business-date). O. Handover compares receipts by client timestamp `createdAtClientMs`, so device clock skew moves sales between windows.

## 8. Offline

1. v1: Firestore persistent cache (multi-tab) + localStorage queue; `completePaymentOffline`, `voidSessionOffline`, per-device-per-day receipt counter `<store>-OL-<device>-<HHMM>-<NNN>` (`lib/offline/offlineReceiptNumber.ts`), deferred-effects queue (loyalty, analytics, KDS) drained on reconnect; kitchen backup printing to a Bluetooth/USB printer on outage (`lib/printing/kitchenBackupPrint.ts`, `kitchenBackupDeps.ts`). Mode picked by `navigator.onLine` only (`hooks/use-online-status.ts`).
2. Goal: never stop selling; 24 h per device is now the target (row 276).
3. Full detail: 09 §6, 22 §4, offline proposal. Not repeated.
4. Extra flaws: P. The APK is the only shipping target; the CORS allow-list is `https://localhost` (`middleware.ts:19-23`), so app and API versions must stay compatible after every deploy; no forced-update path seen (needs a read of `scripts/build-capacitor.mjs`). Q. A 15-minute janitor cron (`/api/cron/reconcile-analytics`) sweeps receipts left `analyticsApplied:false`, proof the delta path fails often enough to need one. Needs a count of receipts swept per day.

## 9. Printing and hardware

1. v1: ESC/POS text built locally (`lib/printing/receiptFormatter.ts`, `kitchenTicketFormatter.ts`, `salesReportFormatter.ts`, `pinSlipText`), sent through `printHub.ts` over native Bluetooth (Capacitor plugin), WebUSB (`webusbPrinter.ts`) or the browser. 58/80 mm, 3 font modes, cached logo, per-store receipt template (`ReceiptTemplateSettings.tsx`, `manager/store-settings/receipt-settings.tsx`), a printer test tool (`/admin/tools/printer-test`). Prints: receipt, kitchen ticket (also as outage backup), diner PIN slip with QR, daily sales report (`PrintSalesReportDialog`).
2. Goal: paper receipt in the customer's hand every time, kitchen paper when the screen is down.
3. Signals: three print paths (native BT, WebUSB, browser) = real hardware variety. Needs a count: printer models per store.
4. Flaws: R. Receipt text omits SC/PWD name/ID and BIR fields (7.4). S. Printing is client-side only; no REPRINT action seen in a quick grep (needs a check of `components/cashier/activity-log.ts` action list).

## 10. Menu and pricing source

1. v1: Global `products` (kind single|group|variant, option groups, photos; admin only); per-store `inventory` = activation of a product with `cost`, `sellingPrice`, `isActive`, `isAddon`, `onlineEnabled`, `onlinePrice`, `customerEnabled`, `kitchenLocationId` (`types.ts:256-329`). Global `packages`, `refills`, `flavors` + per-store `storePackages/storeRefills/storeFlavors` with denormalised name and price. Managers change things by request: `productRequests`, `productPhotoRequests`. The cashier reads a denormalised cache `storeConfig/current` rebuilt by `rebuildStoreConfig` (rules comment L60-66). The customer app reads a `customer-catalog` snapshot rebuilt by cron `rebuild-customer-catalog`.
2. Goal: one brand catalog, per-branch price and availability, online price allowed to differ (delivery cost) but dine-in price never moves; managers propose, admin approves.
3. Signals: three published copies of the menu (storeConfig, storefrontCatalog, customer catalog) with three rebuild paths = drift risk; the repo has `scripts/backfill-*.ts` for each. Needs a count: products, inventory rows per store, archived vs active.
4. Flaws: T. `inventory` is a mis-name: no quantities (see 11). U. Price edits are not versioned; a receipt carries its own line prices (good), but there is no price history table. V. Denormalised name/price in `storePackages` can go stale.

## 11. Inventory depletion

1. POS v1 has NO stock counts and no depletion. A grep for onHand/qtyOnHand/stockQty/decrement finds only a fractional-serve comment (`components/kitchen/kds-item-card.tsx:94`). `stores/{id}/inventory` is a sellable catalogue only. `/api/admin/products/inventory-counts` exists (meaning not checked, needs a read).
2. Depletion happens in the ERP: the ERP pulls `/api/external/sold-items` (per POS inventory doc id, from a bounded receipts scan, 09 §9.2), maps through `pos-item-map` and recipes, then posts usage (`ERP-rebuild/src/lib/financial/posUsagePull.ts`, `lib/actions/pos-usage-pull.actions.ts`, `app/inventory/pos-usage/page.tsx`).
3. Goal: on-hand stock stays honest against sales without cashiers entering anything.
4. v2: on one backend this is derived from receipt lines (pull-redesign proposal). Open there: does a refund put stock back, when usage posts.
5. Flaw W: the `sold-items` scan is bounded (cap not verified); a day above the cap would silently under-report. Needs a read of the route cap. POS MIGRATION census says main store ~33 receipts/day, so low risk today.

## 12. Sync to Firestore and to the ERP

1. v1 has no sync problem inside POS (Firestore is the store). To the ERP: 8 read-only key-protected GET routes (09 §9.2; auth `lib/server/external-auth.ts`, timing-safe, fails loudly). ERP-side cache: `ERP-rebuild/src/lib/server/pos-sold-items-cache.ts`. Day figures come from the baked analytics doc, usage from receipts: two sources for one day.
2. Goal: the ERP closes the books from POS sales without retyping.
3. A metrics digest `dailyMetrics/{dayId}` is computed nightly for every store (cron `generate-daily-insight`, `docs/erp-daily-metrics-forwarding.md`) for the ERP's AI brief; display-ready strings, not numbers. Nothing read says the ERP consumes it today. Needs a check.
4. Flaw X: the same PayMongo account feeds POS and the Website; webhooks are told apart by an index doc (09 §7). v2 must keep one webhook owner.
5. Flaw Y: the analytics doc is a second source of truth beside receipts, kept consistent by deltas, a 15-minute reconcile cron and a destructive `merge:false` rebuild (09 §8). v2: derive, never maintain (22 §2).

## 13. Reports staff actually use

1. Dashboard (`/dashboard`, roles admin|manager|cashier): sales stat cards, weekly and monthly trend, top packages/refills/category, peak hours, payment mix, voided orders card, item adjustments card, package-count check, customer feedback, forecast and forecast accuracy (`components/dashboard/*`).
2. `/sales-report` (`SalesReportPageClient.tsx`, 635 lines) + printable sales report; `/receipts` list with Excel export (summary + itemised sheets, `app/receipts/page.tsx:586+`, includes a TIN column); `/cashier/handover` history export; `/admin/daily-session-timeline` (seat-to-pay timing, ~2.7k LOC in `session-timeline`); `/kitchen/history`; `/admin/data-analysis` (`hooks/use-data-analysis.ts`, 691 lines, AI chat via Anthropic SDK, `/api/analytics/chat-response`); `/weather-calendar`.
3. Goal: managers see today vs forecast and spot leaks (voids, discounts, payment mix, slow serve) the same day.
4. Signals: the AI daily brief was retired 2026-08-08 to the ERP; forecasting (Gemini, weather, holiday calendar, learned-model plan 2026-10-08) is still in POS and still being built (newest plans 5 and 8 Oct) = active use or active interest. Needs a count: dashboard sessions, data-analysis use.
5. Flaw Z: every report reads the analytics doc, so one bad delta (double void, purged tickets) shows in all of them; v2 reports should read the ledger/receipts.

## 14. Other capabilities in v1 (outside the brief, live code)

| Capability | Evidence | Goal |
|---|---|---|
| Diner PINs / customer session join (QR + 6-digit PIN, revive/repair/finalize) | `/pins`, `api/pins/*` (7 routes), `components/pins` 1.3k LOC, `lib/server/finalize-pin.ts` | diners order from their phone at the table (CUSTOMER app); cashier issues/ends it |
| Loyalty ("Sharelebrator") earn/redeem/vouchers/legacy claim, cashier link to session | `api/loyalty/*` (13 routes), `lib/server/loyalty.ts`, plan 2026-10-05 | repeat visits, rewards stacked after discounts |
| Reservations + waitlist + park walk-in | `/reservations`, `WaitlistCard`, `ParkWalkInModal` | seat management |
| Cashier chat inbox with diners | `ChatInbox`, `ChatThreadPane`, `analytics/chat-response` | service requests from the CUSTOMER app |
| Cashier tips, targets, birthday song | `CashierTipModal`, `CashierTargetProgressCard`, `BirthdaySongButton` | staff motivation and guest touches |
| Customer feedback | `api/external/feedback`, `customerFeedbackDays` | quality signal, also pulled by an external aggregator |
| Online orders / storefront | see §4 | delivery and pickup revenue |
| Option groups / modifiers | `api/admin/option-groups`, `modifier-picker.tsx` | item customisation with price delta |
| Data management tools (backfill, reconcile, collections rebuild, sync sessions/KDS tickets) | `/admin/backfill`, `/admin/reconcile`, `SyncSessionsTool`, `SyncKdsTicketsTool`, `manager/data-management` | manual repair of dual-written copies: a symptom, not a feature |

## 15. Most used vs dead (judged from code, no usage counts)

Likely core and heavily used: cashier session + payment + receipt, kitchen KDS, server verify/refill, receipts list/void/edit, handover, dashboard, collections (discounts/charges/MOP), menu admin, PINs/loyalty (plans through 5 Oct), online orders, forecast (active development).

Likely dead or duplicated:
- `components/receipts/page.tsx` (984 lines, unimported) vs live `app/receipts/page.tsx` (6.10).
- `app/cashier/receipts/page.tsx` is a redirect stub to `/receipts`.
- AI daily brief UI (retired); the digest is still computed nightly and `generate-daily-insight` fires 5 times each night.
- Repair/sync admin tools exist only because of dual writes.
- `docs/superpowers/specs/2026-06-11-native-rn-rewrite-design.md` (React Native rewrite design; no RN code seen).
- Legacy single-discount fields on bill lines (`tax.ts` "Legacy fallback"), legacy SHA-256 passcode records, legacy loyalty import.
- `users` collection (09 §1.1 could not trace); `purge-customer-auth-users` cron PAUSED (`docs/CRON.md`).
Needs a count to be sure: per-route hits (hosting logs) and per-collection doc counts.

## 16. Ranked flaw candidates (log to DEFECTS-REGISTER A-D after Ian reads)

1. M: live `/receipts` route likely lacks the transactional void and cash disposition the incident doc says were fixed (`app/receipts/page.tsx:497-538` vs unimported `components/receipts/page.tsx:517`). Failure: a second tab voids the same receipt and analytics is subtracted twice (27 Jun, 3,503 pesos).
2. A: void/edit/refund role limits are UI-only; receipts are not in the rules' locked list (`firestore.rules:63-67`). Failure: a server-role login rewrites a receipt.
3. H: payment mix corrected in analytics only (`applyPaymentConversionServer.ts`); receipts keep the old tender. Failure: handover cash and per-tender ERP totals disagree with receipts.
4. N: three day boundaries (midnight, 4 AM, 5 AM). Failure: a post-midnight close lands on the next day's analytics and the wrong handover.
5. I: SC/PWD discount on the whole bill (`tax.ts:131-156`). Failure: over-discount when only some diners qualify; no ID captured (known gap).
6. 6.8: in-place edits of paid receipts (`EditReceiptDialog.tsx`). Conflicts with immutable receipts (row 272).
7. E/Y: dual-written projections and a maintained analytics doc; whole families of repair tools exist.
8. G: platform orders rung in POS vs documented as typed outside POS.
9. Q: the 15-minute janitor cron implies frequent failed delta writes.
10. Already in 09/22 (not repeated): receiptSeq spaces, refund number collision, float money, navigator.onLine, multi-tab counter, no server guard on offline overwrite.

## 17. Capability list for the v2 phase plan

Format: capability · goal · v2 note.

1. Seat a party / table lifecycle · track who sits where, avoid double seating · one table row with status; no mirrored copies.
2. Unlimited package with headcount verification · bill the real head count · keep the cashier-then-server verify and approve flow; add per-head tiers only if Ian wants them (Q5).
3. Bundle package (flat price for N pax + extra heads) · group deals · keep; server computes.
4. À la carte, take-out, delivery as a real sales channel · channel-correct revenue and settlement · `sales_channel` column (DEF-004/005), not sessionMode.
5. Add-ons and modifiers with price delta · customisation · keep option groups; price read from menu tables at the server.
6. Refills and flavors, per-package allowed list, pacing · unlimited but controlled · keep; cooldown values become settings (DEF-021).
7. Kitchen routing, KDS, ticket states, batch serve · cook the right thing at the right station · keep screens; one ticket row, KDS reads a view; bill-on-serve rule preserved.
8. Diner self-order and PIN join (CUSTOMER) · phone ordering at the table · same backend; the PIN is an auth credential with expiry.
9. Bill computation (discounts, charges, VAT modes, SC/PWD) · correct totals · one server-side pure function; recompute and compare on offline sync; per-person SC/PWD with ID capture (T-137 gap).
10. Payment taking: split tenders, change only vs cash, reference numbers · correct tender totals · tenders by id (T-375 master), integer centavos.
11. E-wallet: static QR (no amount recorded) and PayMongo QR Ph auto-confirm · verified money only · keep both; one webhook owner shared with the Website.
12. Receipt issue and numbering · proof of sale, unique number · real key + human number; decide BIR need first (Q2).
13. Void unpaid session · cancel before payment with reason and ticket cleanup · keep; server transaction.
14. Void paid receipt with cash disposition and re-ring link · reconcile the drawer when a sale is cancelled but cash stayed · keep the need; express as a reversal document (row 272), role enforced server-side.
15. Refund as a new negative receipt · money back, audit · unique numbers; dated on its own day.
16. Post-payment correction (edit paid receipt) · fix cashier mistakes without voiding · redesign as an adjustment document with reason, before/after, manager capability (Q3).
17. Payment-mix correction (conversion) · fix a wrong tender · merge into the adjustment document of item 16 so receipts and totals agree.
18. Cash handover and drawer count · accountable shift change · becomes the shift record: opening, sales, deductions, counted, variance, chain to previous; ties to ERP custody.
19. End-of-day close (X/Z) · lock the day · does not exist in v1; decide with Q2; one business-day rule per store (Q8).
20. Offline selling 24 h per device, offline receipts, kitchen backup print · never stop selling · ADR-015 / row 276; server recomputes the bill; fixes DEF-001/002.
21. Printing (BT, USB, browser; receipt, kitchen, PIN slip, sales report) · paper in hand · keep the formatters; log reprints; hardware acceptance test.
22. Menu: global product + per-store activation + online price + customer flag · one brand menu, branch control · tables with price history; one published view instead of three rebuilt copies.
23. Discount and charge configuration (store + global, date windows, stackable, suspend) · promos without code · keep; admin override stays.
24. Staff identity: user + device local profile + passcode · attribution on shared tablets · one principal across ERP/POS/CUSTOMER (ADR-015); rate-limited passcode; capability-based roles.
25. Online orders and storefront · delivery and pickup sales · same receipt table with channel; state machine kept; delivery fee as its own line.
26. Loyalty earn/redeem/link · repeat business · keep; earn after sync, not offline (v1 already defers).
27. Reservations, waitlist, park walk-in · seat planning · low priority, keep screens.
28. Cashier chat with diners · service requests · rides on the CUSTOMER app.
29. Dashboard, sales report, receipts export, session timeline, kitchen history · same-day management view · read from ledger/receipts, no maintained analytics doc.
30. Forecast + weather + holidays · staffing and prep planning · keep out of the sale path; decide whether it lives in POS or ERP.
31. Usage/stock depletion from sales · honest on-hand stock · derived from receipt lines (pull redesign); no pull at P2.
32. Staff performance metrics (serve timing, per-staff sales) · coaching and incentives · derive from tickets and receipts; keep tickets (do not purge).
33. Cashier tips and targets, birthday song · staff and guest touches · confirm use before building (Q6).
34. Admin repair tools · fix drift · not carried; the dual-write causes disappear.
35. Customer feedback capture · quality signal · keep, small.

## 18. Open questions for Ian

1. Grab/Foodpanda: are those orders rung through POS (a "grab order cancel" void exists) or typed per day in the ERP? Decides whether channel and platform-fee handling belong in POS v2.
2. Does POS v2 need BIR-style receipts (OR/invoice series, X/Z reading, accredited machine)? v1 has none of it. This changes receipt numbering, day close and reprint rules.
3. Corrections: may a manager still edit a paid receipt in place (v1 does), or only void/refund and re-ring? Recommended: keep the capability but as a recorded adjustment, never an overwrite.
4. Which build is live? Does production's `/receipts` void have the transaction and cash disposition, or the older version in this checkout (6.10)? Ask the POS owner or the deploy log before porting.
5. Package pricing: any need for child/senior/age tiers or per-day prices beyond the bundle rule?
6. Which small features are truly used: tips, targets, birthday song, reservations/waitlist, cashier chat, weather calendar? Unused ones can wait.
7. Are payment conversions (tender corrections) frequent? If yes, the till needs a tender-change step at close, not an after-the-fact tool.
8. Business day: is the sales day midnight-to-midnight, or does a late close belong to the previous day (4 AM / 5 AM)? One rule per store is needed.
9. Counts to pull before design (I cannot query production): receipts/day per store, share of offline (OL-) receipts, voids and edits per month, conversions per month, SC/PWD receipts, online orders/day, staff and local-profile counts, printers per store.
