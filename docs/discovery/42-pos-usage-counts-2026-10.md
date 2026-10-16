# POS v1 usage counts (PC-0), 16 Oct 2026

| | |
|---|---|
| Source | Firestore project `shareat-hub-v2` (production POS data) |
| Method | Read-only. Aggregation counts plus `select()` reads of non-personal fields. Nothing written. No names, phones, notes or free text copied; void reasons were only pattern-matched in memory |
| Window | 18 Jul to 16 Oct 2026 (91 days, Manila time, UTC+8), unless a row says "all-time" |
| Document reads | about 24,600 (budget was 150,000) |
| Stores counted | Lipa (L), Davao (D), Malvar (M), Banay-Banay (B). P. Garcia exists but has zero receipts, sessions, menu. Skipped: two stores named `TEST` (5 receipts in window) |
| Opening dates | L first receipt 16 Jan 2026, M 2 Feb, B 20 Jun, D 16 Aug. D and B are partial windows |

Receipt volume is small: 5,180 receipts in the window across the four stores. All-time: 13,561 receipts.

## 1. Receipts per day and per peak hour (non-refund receipts)

| Store | Receipts | Trading days | Avg / trading day | Median day | Max day | Peak clock-hour (max in one hour) |
|---|---|---|---|---|---|---|
| Lipa | 2,438 | 91 | 26.8 | 25 | 48 | 12 |
| Davao | 1,246 | 62 | 20.1 | 19 | 38 | 10 |
| Malvar | 1,142 | 91 | 12.5 | 12 | 25 | 9 |
| Banay-Banay | 354 | 78 | 4.5 | 4 | 10 | 6 |
| All four | 5,180 | | about 64 per day in total | | | |

Davao and Banay-Banay averages are over days they traded (they opened inside the window). One receipt per table-session, so these are also close to table counts.

## 2. Offline receipts

| Store | Offline receipts (`-OL-`) in window | Share | Longest run | Time span |
|---|---|---|---|---|
| Lipa | 0 | 0.0% | 0 | none |
| Davao | 0 | 0.0% | 0 | none |
| Malvar | 0 | 0.0% | 0 | none |
| Banay-Banay | 0 | 0.0% | 0 | none |

All-time: exactly 1 offline receipt exists (Lipa, number format `SELIP-OL-...`), and the `offlineOrigin` marker appears on 1 of the latest 800 Lipa receipts. So v1 produced almost no offline-numbered receipts. Caveat: an offline sale that synced later may carry a normal number, so this is a floor on real outages, not proof of none. Receipt number formats seen: `SELIP-#`, `SEMAL-#`, `OR-#`.

## 3. Corrections per month (all four stores, non-refund receipts)

| Month | Receipts | Voided | Refund receipts (`RF-`) | Edited after payment | Payment conversions (incl. voided) |
|---|---|---|---|---|---|
| Jul (18-31) | 589 | 0 | 0 | 0 | 60 |
| Aug | 1,729 | 3 | 0 | 7 | 104 |
| Sep | 1,871 | 1 | 0 | 4 | 112 |
| Oct (1-16) | 991 | 1 | 0 | 2 | 57 |
| Total | 5,180 | 5 | 0 | 13 | 333 |

- "Edited" = `editVersion` above 0; the `isEdited` flag gave the same 13. Lipa 8, Davao 5, Malvar 0, Banay-Banay 0.
- Voids in window: Lipa 4, Davao 1. All-time voids: 18 (L 13, D 1, M 1, B 3). Void cash disposition (`voidCashDisposition`) was never recorded on any window void.
- Refunds are not recorded as `RF-` documents in this data. Partial refunds sit on the original receipt as `refundedTotal`: 7 receipts all-time, all Lipa (D, M, B: 0).
- Payment conversions happen only at Lipa (308 in window, 25 voided) and Malvar (25, 4 voided). Davao and Banay-Banay: 0.
  - Lipa: Cash to GCash 176, GCash to Cash 129, bank transfer 3. Malvar: Cash to GCash 15, GCash to Cash 10.
  - Face amount about P256,500 (Lipa) and P24,300 (Malvar). Median P250 (Lipa), P394 (Malvar). That is about 12% of Lipa receipts; the till is mis-tagged for the payment method often.

## 4. SC/PWD (senior citizen / person with disability)

| Measure | Result |
|---|---|
| Receipts in window with a bill discount marked `vatExempt` | 0 |
| Receipts in window with `analytics.vatExemptSales` above 0 | 0 |
| Receipts in window with any line-level discount (`discountQty` above 0) | 0 (all 4 stores) |
| Receipts in window with any bill discount | 2 (Davao 1 "CustomDiscount", Malvar 1 "PWDDiscount"), not vat-exempt |
| Discount definitions | SC and PWD exist as discounts at all 4 stores, flagged `vatExempt` only at Banay-Banay |

Per month for SC/PWD: effectively 0 at every store. The receipt records a bill discount in `billDiscount` (name, type, value, `vatExempt`) and VAT split in `analytics`. Receipt `customAdjustments` are all positive extra charges (no negative amounts, no SC/PWD labels in 3 stores checked). Either SC/PWD customers are rare, or they are rung outside the discount flow. Needs a store-staff answer.

## 5. Voids mentioning Grab / foodpanda / panda

| Scope | Count |
|---|---|
| Window | 0 of 5 voids |
| All-time | 1 of 18 voids (Lipa) |

Platform orders are not meaningfully rung on the till and later voided.

## 6. Online orders (`onlineOrders`)

| Store | All-time | In window | Avg / day | Max / day |
|---|---|---|---|---|
| Lipa | 2 (both Aug 2026) | 2 | 0.02 | 1 |
| Malvar | 1 (Aug 2026) | 1 | 0.01 | 1 |
| Davao, Banay-Banay | 0 | 0 | 0 | 0 |

Three online orders in 91 days. The online-order feature is almost unused.

## 7. Session mix (sessions started in window)

| Store | Sessions | package_dinein | alacarte | Package share | Avg guests (package sessions) | Max guests |
|---|---|---|---|---|---|---|
| Lipa | 2,451 | 2,096 | 355 | 85.5% | 3.27 | 42 |
| Davao | 1,276 | 1,129 | 147 | 88.5% | 2.68 | 12 |
| Malvar | 1,147 | 1,044 | 103 | 91.0% | 3.19 | 15 |
| Banay-Banay | 367 | 0 | 367 | 0% (no packages) | not applicable | not applicable |
| All | 5,241 | 4,269 | 972 | 81.5% | about 3.1 | 42 |

Guests = `guestCountFinal`, falling back to the cashier's initial count.

## 8. Menu size (today)

| Store | Active inventory items (of all) | of which add-ons | Packages enabled (of all) | Refills enabled (of all) | Flavours enabled (of all) | Discount defs | Payment methods active |
|---|---|---|---|---|---|---|---|
| Lipa | 145 (155) | 123 | 12 (14) | 6 (10) | 7 (7) | 6 | 3 |
| Davao | 126 (127) | 93 | 11 (13) | 7 (7) | 7 (7) | 1 | 3 |
| Malvar | 178 (178) | 104 | 15 (17) | 6 (11) | 7 (7) | 4 | 2 |
| Banay-Banay | 98 (98) | 92 | 0 | 0 | 0 | 1 | 2 |

Active = `isActive` true and not archived.

## 9. Cash handovers

0 documents at every real store, ever. One handover exists, in a `TEST` store. Per-day average and variance spread (min / median / max) cannot be computed. See "Not counted".

## 10. Loyalty (top-level `customers`, `loyaltyStats/global`)

| Measure | Count |
|---|---|
| Member accounts | 129 (matches `loyaltyStats.totalAccounts`) |
| Created in last 90 days | 70 (all 129 accounts were created in 2026) |
| Active in last 90 days (latest store visit or account update) | 85 |
| No activity for 3+ years | 0 (programme is under one year old) |
| Members with no recorded store visit | 13 |
| Points outstanding (sum of balances) | 1,980 pts, held by 116 members |
| Points earned ever / redeemed ever | 2,189 / 575 |
| Redemptions on file | 7 |
| Legacy loyalty records parked, not yet claimed (`legacyLoyaltyCustomers`) | 106 |

## 11. Feedback (`customerFeedbackDays`, all-time, Mar to Oct 2026)

| Month | 2026-03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 (to 16th) | Total |
|---|---|---|---|---|---|---|---|---|---|
| Entries | 4 | 9 | 10 | 20 | 12 | 20 | 21 | 13 | 109 |

| Rating | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Entries | 8 | 7 | 3 | 6 | 85 |

By store: Lipa 61, Malvar 33, Davao 15, Banay-Banay 0.

## 12. Reservations (all-time; created month)

| Month | 2026-05 | 06 | 07 | 08 | 09 | 10 | Total |
|---|---|---|---|---|---|---|---|
| Reservations | 3 | 7 | 7 | 4 | 6 | 2 | 29 |

- By store: Lipa 15, Malvar 12, Davao 2, Banay-Banay 0.
- With a deposit (a non-voided payment above 0): 4 of 29 (Lipa 2, Malvar 2).
- Source: POS 19, website 10. Status: seated 12, cancelled 6, confirmed 6, handled 4, no_show 1.

## What these numbers mean for POS v2

- Soak size is small. The busiest till (Lipa) rings about 27 receipts a day and peaks at 12 in one hour (max 48 in a day). A 4-store chain-wide soak is roughly 64 receipts a day, so load is not the risk. Correctness is.
- Offline matters less than planned: 1 offline-numbered receipt in 13,561 all-time and none in 91 days. A 24-hour offline limit is not under pressure from real outages in v1. Keep the guarantee (it is cheap insurance) but do not design around it. Confirm with store staff whether outages happen and sales are re-keyed.
- Correction flow volume is low: 13 post-payment edits and 5 voids in 91 days across all stores (about 1 correction per week). The edit and void flows need to be correct but not fast.
- Payment conversion is the real correction habit: 333 in 91 days (about 3.7 a day), nearly all Cash/GCash swaps at Lipa. Ian's 15 Oct ruling (receipt never changes; cashier marks, manager PIN approves a correction entry before shift close) will therefore run about 4 times a day at Lipa, so that flow must be one quick step, and the payment screen should make the wrong tap less likely.
- SC/PWD showed 0 recorded uses in 91 days, even though SC and PWD discounts are configured at every store. Statutory discount compliance (BIR) is a legal risk if these are being rung another way. Ask store staff how SC/PWD sales are handled before sizing that work.
- Online orders are almost unused (3 all-time) and platform orders (Grab/foodpanda) are not rung on the till. Online ordering is low priority for POS v2.
- Package dine-in is 81.5% of sessions with about 3.1 guests per table (max 42), so the package and guest-count flow is the core path. Banay-Banay is 100% à la carte.
- Menus are small (about 100 to 180 active items, 11 to 15 packages, 7 flavours), and there are only 129 loyalty members, so no big-data design is needed for menu or customer lookups.

## Not counted

| Item | Why | What would get it |
|---|---|---|
| Cash handover per day and variance | No handover documents exist at any real store | Store staff: is the handover screen used, or is cash reconciled elsewhere (paper, ERP)? |
| Refund receipts (`RF-`) | None exist; partial refunds only as `refundedTotal` on 7 Lipa receipts | Confirmed as zero in this data |
| True outage length | Only 1 `-OL-` receipt; later-synced offline sales cannot be told apart | Staff recollection, or tablet connectivity logs |
| SC/PWD actual volume | Not recorded as discounts in the window | Staff, plus BIR discount booklets from the stores |
| Tablet models, printers, network, Wi-Fi | Not stored in Firestore | Store staff |
| Per-month SC/PWD for older months | Window was 90 days | Only the window was approved |
| Hourly peaks by time of day | Only the maximum count was kept | Re-run with hour buckets if needed |
| TEST stores and P. Garcia | Skipped (test data) or empty | Not needed |
