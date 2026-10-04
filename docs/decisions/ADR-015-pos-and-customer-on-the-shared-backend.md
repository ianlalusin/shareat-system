# ADR-015 — POS and CUSTOMER on the shared backend: copy, harden, swap by owner; 24-hour offline selling on the device

| | |
|---|---|
| **Status** | ✅ **ACCEPTED 2026-10-04** (Ian's rulings, bible §13 rows 269–276). ⚠️ **One part is PROVISIONAL:** the Firebase exit scope (§6, row 275) is the orchestrator's working default, pending Ian's confirmation |
| **Raised by** | Ian, 2026-10-04: *"pos v1, customer v1 will also be reworked since we intend them to share same backend postgres db shared auth for 3 projects. so the shape of erp shall assume this"*; *"copying the pos v1 ... then improve that and modify so it fits the backend of erpv2"* |
| **Research** | `docs/discovery/pos-sales-usage-integration-proposal.md` (the copy-and-swap, P0–P3, the day feed) · `docs/discovery/pos-offline-and-data-tiers-proposal.md` (24-hour offline, device storage, one Postgres) · discovery 22 (POS) |
| **Drivers (Ian)** | (a) one source of truth · (c) getting off Firebase |
| **Decides for** | How POS and CUSTOMER join this monorepo; who owns each entity during the swap; how the till sells offline; receipt numbering; what the ERP builds before the till moves |
| **Does not decide** | Receipt, order and menu table columns (a P1/P2 task spec, written in plan mode) · the LAN hub (reconsidered at P3 only, §5) · POS BIR registration (open, §8) |
| **Amends** | ADR-003 "never two at once" (POS + CUSTOMER flip together) · ADR-005's sales bridge ("POSv2 is far out") · bible row 77 (24 h), §5.3, §5.4 rule 1, §8 ports, §1.2b (narrow). ⚠️ ADR-003 and ADR-005 are not edited in place by this ADR; the bible rows carry the supersession |

## 1. Context

- ADR-003 (2026-08-23) already set the end state: one Postgres for four apps, revenue posted from the receipt, the
  sales pull deleted (row 78). ADR-005 then kept a POS→ledger sales bridge "until POSv2", on the premise that POSv2
  was far out.
- Ian has now ruled that POS v1 and CUSTOMER v1 are **copied** and reworked onto the ERP v2 backend: one Postgres,
  one auth, three apps. The screens are the good part (discovery 22 §1); the work is the data layer — 139 POS files
  import client Firestore, with 233 client write sites, and the 1,526-line sale engine runs in the browser.
- The register holds 21 open POS/CUSTOMER defects (7 critical): DEF-001..005, 007..009, 012..015, 017..019,
  021..023, 025, 342, 343.
- POS v1 is a Capacitor 6 APK that bundles the app and already sells offline from on-device storage (Firestore
  persistent cache in the WebView's IndexedDB, plus a localStorage outbox).

## 2. Decision — copy, harden, swap by owner

1. **POS v1 and CUSTOMER v1 are COPIED into `apps/pos` and `apps/customer` at a pinned commit** (row 269). The
   reference repos stay read-only (row 80); the copy is this repo's code from the moment it lands.
   - **UI and interaction are copied** (§1.2c). **Rules and data layer are requirements only** (§1.2b) and are
     rebuilt in `packages/domain` behind the one `authorize()`.
2. **The swap is by entity-owner flip, never by dual-write** (§15.4, row 20). Each entity flips its owner once,
   per store, behind a flag. Before the flip Firestore is its truth; after it, Postgres is.
3. **Phases.**

| Phase | When | Delivers |
|---|---|---|
| **E: ERP now** | before the 15 Nov go/no-go | The POS v1 day feed (T-375): a stored source document; the sales day DERIVED from it and locked (row 270); tender master; usage plan read from the stored feed |
| **P0: copy and harden** | after 15 Nov; **live after 1 Jan 2027, one store first** (row 269, qa) | Copy at a pinned commit; firebase SDK aligned; CI build and APK pipeline; critical register rows fixed in the copy (DEF-001..004, 012, 014, 015, 017); **post-close edit and void removed** (row 272); SC/PWD name and ID captured (row 218); offline O1–O4 (§5). Still on `shareat-hub-v2` |
| **P1: reference data and auth** | Q1 2027 | Postgres owns stores, staff, PIN sessions, menu with depletion rule, tenders, discounts; the till reads them through the edge; O5 offline PIN verifier |
| **P2: receipts** | Q1–Q2 2027 | Sale events → `receipts`, lines, payments, refunds; server recompute-and-compare; sales day `source = pos_receipts` per store; **the day feed and the usage pull retire for that store** |
| **P3: live tables and CUSTOMER** | Q2 2027 | Table sessions, orders, KDS in Postgres (online); `apps/customer` copied and aligned to the monorepo's React; **POS and CUSTOMER tables move together per store** (row 269, qb); loyalty ledgered (row 273); `shareat-hub-v2` retired |

4. **Entity owners at the end state.**

| Entity | Owner | Note |
|---|---|---|
| Receipt, line, payment, refund | POS — immutable source documents | A refund is a new receipt with `parent_receipt_id`. No post-close edit or void (row 272) |
| Receipt numbering | POS device | `(store, terminal_no, seq)`, continuous, never resets (§5) |
| Sales day | ERP — derived closing over a `source` | `pos_v1_day_feed` until P2, then `pos_receipts`. Figures written only by the derivation (row 270) |
| Stock usage | ERP — derived | Receipts × the item's depletion rule (today's `pos_item_maps`) |
| Menu, prices, tenders, discounts | ERP reference data | Mirrored to the till |
| Retail diner, loyalty | A `person` with a `phone` identity | Not an AR customer. Not a Firebase Auth user (DEF-343). Needs a `diner` principal. One programme across orgs (row 273) |
| Table session | POS | Named `table_sessions` — `sessions` already means an AUTH session in v2 (GLOSSARY) |

## 3. The ERP side now (E) — the sales day is derived, never typed

- Ian: *"all sales data must be from pos that cant be edited if needed reversing discount must be done on POS as refund"*.
- The ERP never accepts a typed or edited sales figure. A database trigger refuses a figure UPDATE outside the
  derivation; `source` is required on a new day. Today's typed form and its unchecked "From POS" checkbox are DEF-586.
- Interim rules for the day feed (row 271): platform sales are a **separate ERP entry outside the POS-locked
  figures** (pos-q1 (b), for now); the feed's discount total posts as **one 4900 line** until receipts carry the split
  (q2 a); a POS change after verify is a **finding plus a correcting entry in an open month** (q3 a); if POS is
  unreachable **the day waits — no manual fallback** (q4 a).

## 4. Data tiers — one Postgres

- **One Postgres primary. No hot/cold split, no archive database** (row 274). Estimated POS load is under 1.5M rows
  and ~1 GB a year.
- Standby, read replica and partitioning are each added **only on a measured trigger**: a standby when P2 goes live and
  failover in minutes is wanted; a replica when reports pass ~30% CPU; partitioning when one table passes 50M rows.
- A nightly off-cluster dump with a rehearsed restore is required (§15.8).
- Firebase is **never** the system of record (§2 rule 3).

## 5. Offline selling — 24 hours, per device, on the device's own storage

**Scope (widens row 77; row 276).** 24 hours of basic ordering and billing with the internet down.

| Works offline | How |
|---|---|
| Open a table, order, add-ons, bill, cash, split tender | Only on the table's **owner device** (the one that opened it). Other devices see it read-only |
| Refill request, kitchen ticket | Any device; prints on the Bluetooth kitchen printer. Refills carry no price |
| SC/PWD and preset discounts | From the mirrored rules; the server recomputes after sync |
| Cashier change mid-outage | Offline PIN sign-in against a device-only verifier (P1, O5) |
| Same-day cash refund | Same device, manager PIN (P2, O6) |

| Refused offline | Why |
|---|---|
| Card or any online-verified tender; loyalty redemption | Cannot be verified; redemption double-spends across stores |
| A void of another device's table | v1's backlog-5b hole, refused by construction |
| CUSTOMER ordering, KDS screens | Online-only (row 77). The kitchen gets printed tickets |

**Mechanism.**
- **Storage is the tablet's own** (POS is a Capacitor APK): the outbox and the receipt sequence live in IndexedDB,
  moving to SQLite (`@capacitor-community/sqlite`) if the soak test fails. **localStorage is not acceptable** for
  either. Storage survives app kill, reboot and update; it does not survive "clear data", uninstall or a dead tablet.
- **Every completed sale leaves the device as an append-only event**, online or offline, keyed by `(device_id, seq)`.
  The server **recomputes the bill from the lines and compares**; a mismatch is a finding, never a silent accept.
  This is the §5.4 rule-1 carve-out: the device RECORDS a sale; it does not adjudicate one.
- The §5.1 Lane A / Lane B **rules** (server-only writer for mirrors, append-only idempotent inbox, raw facts, quarantine
  never drop) bind whatever the carrier is. **The carrier:** Firestore during P0–P1 (the copy already runs on it);
  the target carrier follows row 275 (§6).
- **Receipt numbering:** `(store, terminal_no, seq)`, continuous, never resets, used online and offline; Postgres
  enforces `UNIQUE (device_id, seq)`. This fits BIR's per-machine serial series (v1's daily reset does not — DEF-587).
- **Paper is the backstop.** Every offline sale prints; an X-reading slip prints every 4 offline hours. A lost tablet's
  unsynced sales are re-entered by a manager as a late, audited entry.
- **No LAN hub and no local database per store.** Reconsidered at P3 only if two devices must bill the same table offline.

**Acceptance gate (P0, O4):** a **24-hour soak on two real tablets** running the APK — about 150 sales and 2k writes
offline, then reconnect — with **zero loss and zero duplicates**. P0 is not done until it passes.

## 6. Firebase exit — ⚠️ PROVISIONAL (row 275)

Ian named getting off Firebase as a driver but has not picked the scope. **Working default, pending his confirmation:**
**(b) off Firebase as database and auth; keep only FCM push for the customer app; the clock terminal moves to the
same on-device offline approach as POS.** Consequences if confirmed: the §5 Firestore carrier is replaced by the
device outbox posting to the shared backend under the same Lane A/B rules; Firebase Auth stops being a credential
kind (rows 2, 4, 10, 11 and 202's target change). Until Ian confirms, nothing is built that assumes either answer
beyond P0.

## 7. Consequences

- **Ports:** `apps/pos` and `apps/customer` cannot use 9003/9004 — those are POS v1's and CUSTOMER v1's reserved
  ports. New ports are assigned at P0; the two apps' READMEs (which still say 9003/9004) are corrected then.
- **Hot set (§5.3):** gains, at P1, menu, prices, tenders, discounts, store POS config and a device-only PIN verifier
  (mirror), and POS sale and table events (inbox).
- **No float money:** §2 rule 5 is not waived. P0 is not done while float money remains in the copy (DEF-003).
- **Nothing built in E is torn out:** the lock and the derived-closing contract are the end state; the tender master
  is the till's tender list; the feed table freezes as archived source documents. Only the feed fetcher and the usage
  pull's fetcher are deleted at P2.

## 8. Open

- POS BIR registration (PTU/MIN per tablet): numbering is designed to the per-machine series either way.
- Offline-proposal Q1–Q4, Q6 (tablets per store, router UPS, printers, offline tenders, offline refunds): the
  recommendations above stand until Ian rules.
- Firebase exit scope (§6).
