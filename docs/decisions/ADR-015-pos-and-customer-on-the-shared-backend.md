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

> **Amended 2026-10-15** (end of file): Ian's 13 Oct posv2 rulings and 15 Oct rulings. Where the amendment and the
> sections above disagree, the amendment wins. The accepted text above is kept as it was.

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

---

## Amendment 2026-10-15 — the posv2 plan rulings (13 Oct) and Ian's 15 Oct rulings

| | |
|---|---|
| **Status** | ✅ ACCEPTED for every item marked RULED. Items marked **OPEN** wait for Ian; the recommended option is a working default only where stated |
| **Sources** | posv2 plan artifact and Ian's 128 answers (13 Oct) · Ian's 14 Oct rulings (bible rows 318-323, 335) · Ian's 15 Oct rulings (recorded in `docs/plans/pos-customer-v2-phase-plan.md` §3) · `pos-v1-study.md`, `customer-v1-study.md` (15 Oct) |
| **Supersedes in this ADR** | §2 P0 date ("live after 1 Jan") · §5's offline tender list · §6's PROVISIONAL status · §7 "new ports assigned at P0" · §8 BIR and offline Q1-Q4, Q6 |

### A1. Where the apps live and how they ship (RULED)

1. **Same repo** (row 269, confirmed 15 Oct): POS v2 is `apps/pos`, Customer v2 is `apps/customer`, as workspaces of
   this monorepo. Each app has its **own `tsconfig.json`**; the root typecheck excludes both (root `tsc` already needs
   a 4 GB heap, DEF-631).
2. **An installed Android app (APK), not a browser web app** (`apk-vs-web` = a, `pos-apk` = yes). **Capacitor, one
   APK per app**, built in CI only, never on a droplet (DEF-238). The server receives finished artifacts.
3. **A new Android app id for v2**, not v1's `net.shareat.pos` (`culinaryflow` is only v1's npm package name; corrected 16 Oct from `POS/capacitor.config.ts`). v1 stays installed beside v2 as that store's roll-back;
   reusing the id would install over v1 and could wipe v1's unsent offline sales.
4. **One release keystore for v2, held as a GitHub secret that Ian adds.** No agent handles the key.
5. **Ports** (`ports` = a): POS v2 **9009**, Customer v2 **9010**. Closes §7's "assigned at P0". 9003/9004 stay v1's.
6. **CI:** path-filtered per-app jobs; no Turborepo now (phase plan §4 has the numbers). In P0 the POS server routes
   run as a second service on `159.223.46.224`; Customer as a third from P3; memory measured after each starts.

### A2. Firebase exit — no longer provisional (RULED)

§6's working default (row 275) was **superseded by row 280** (2026-10-05): completely off Firebase — database,
sign-in and push. The 13 Oct answer fixes the **timing** (`firebase-exit` = a): **in steps** — staff sign-in at P1,
sales at P2, tables and Customer at P3; the Firebase project is **closed 90 days after the last store** moves.
Customer v2 sends **no push**: on-page notices only (A6).

### A3. Stores, devices and offline (RULED)

| Ruling | Source | Changes |
|---|---|---|
| **One tablet per store** runs the POS; the ERP runs on any other device | row 313 (`tablets-per-store` = a) | §5's owner-device and LAN-hub concerns cannot arise in a store. The soak harness still runs two tablets to prove duplicates are refused |
| **Keep today's tablets** (`tablet-model` = b) and **Bluetooth thermal printers** (`printers` = a) | 13 Oct | Model, Android version and memory are counted before the soak; only failing tablets are replaced |
| Router on a **small UPS per store**; stores also have generators | `router-ups` = a | — |
| Offline, take **cash, plus GCash/Maya recorded with the reference number as "to check"** | `offline-tenders` = a | **Narrows §5's refused list:** e-wallets are accepted offline as unverified, checked on sync. Card stays refused |
| Offline refunds: **same tablet, same day, cash only, manager PIN** | `offline-refunds` = a | Confirms §5 O6 |
| **Warn the manager at ₱50,000 unsent; keep selling** | `offline-cap` = b | A warning in the P0 offline slice; no hard stop |

### A4. Receipts and money on the till (RULED)

1. **The unsafe v1 void must not be ported.** Live POS (build #238, commit `e26d0c1`) voids with a plain status
   update in `src/app/receipts/page.tsx:514`: no transaction, no cash disposition; the 27 Jun double-void (₱3,503)
   came from it. v2 ports **only the transactional logic** (a void before payment, in one transaction, tested with two
   tabs voiding at once). Paid receipts stay immutable (row 272).
2. **Wrong tender on a paid receipt** (Ian, 15 Oct): the receipt never changes. The cashier marks it; **a correction
   entry approved by manager PIN fixes the tender before shift close**. After close it is refund + re-ring (row 272).
   One correction document replaces v1's in-place edit (`EditReceiptDialog`). No receipt figure is edited, so row
   272 holds. ⚠️ **Corrected 17 Oct (bible row 359):** v1's `PaymentConvertModal` ("Convert") is NOT a wrong-tender
   fix; it is a GCash cash-in/cash-out service and stays a SEPARATE feature (T-427).
3. **One price per head** for packages (Ian, 15 Oct): no child, senior or age tiers. v1's bundle rule is kept.
4. **Redesign the payment and table screens before go-live** (`redesign` = b, against the recommended a; row 283).
   Mock-ups go to Ian first. A dine-in table may also take à la carte lines (Ian's 13 Oct note).
5. **BIR: keep today's set-up** (`bir` = b). The POS stays an internal record; X/Z readings are cash-control slips,
   not BIR documents. Closes §8's BIR item. Numbering stays per-machine (§5), so registering later needs no rework.
6. **Keep all extras; AI is the hub of the app family** (`keep-extras` = b). Usage counts set build order only.

### A5. The till and stock usage (RULED)

1. **The till stays an ERP record; POS v2 gets a till SCREEN over the ERP's till rows** (row 319, worklist row 319).
   Open shift, count, close, shortage and remittance stay ERP actions (T-186, T-153, T-143, T-366); the POS shows and
   drives them. There is no separate POS till entity. The wrong-tender correction (A4.2) is gated on that shift
   still being open.
2. **POS sales create pre-filled stock-usage drafts** (Ian, 15 Oct; T-401 S6): each sale's expected usage (sold x
   rule) pre-fills a draft; staff adjust it; the manager posts (rows 318, 335). **A draft not posted by 14:00 the
   next day posts automatically**, logged as an automatic posting. Row 335 stands: the v1 usage pull becomes a check
   only (±10% gap flagged) once S6 lands. Specced as T-401 S6, not yet built.
3. Store orders addressed to a store show on the POS screen (row 318). One person, one ID (row 322); a person with two
   or more positions picks one at sign-in, and the pick only narrows (row 323).

### A6. Customer v2 scope (RULED)

| Ruling | Source |
|---|---|
| **No pay-from-phone and no bill split from the phone in the first release** | Ian, 15 Oct |
| **On-page notices only, no push** | Ian, 15 Oct; row 280 |
| **Feedback** tied to table + receipt, one per participant; **1-2 stars alert the manager; 4-5 stars show the store's Google-review link** (Ian supplies each link) | Ian, 15 Oct |
| **Privacy: a consent tick at sign-up; members inactive 3 years are deleted** by a scheduled job, logged as a deliberate deletion (PH Data Privacy Act; Customer v1 has neither today) | Ian, 15 Oct |
| Diner sign-up proves the phone with one SMS code; login is phone + password; only a manager resets, in person | row 314 |
| No admin areas in the app; admin work lives in the ERP/POS | row 307 |

### A7. Stores and rollout (RULED unless marked)

| Item | Ruling |
|---|---|
| First store | **Lipa** (`first-store` = a) |
| Pace | first store 2 weeks, then one store a week (`rollout-pace` = a): Malvar, Banay-Banay, Davao |
| Padre Garcia | same apps, its own org and books, **goes last** (`franchise` = a; row 305 covers its ERP) |
| Customer v2 | P3 (Q2 2027), moving store by store with POS (row 269) |
| First-store date | **OPEN** — A8 Q2 |

*Note, 2026-10-30: Banay-Banay dropped, row 377 (T-454). It closes 31 Dec 2026 and is not in this rollout; the pace line above is kept as it was ruled.*

### A8. Still OPEN for Ian

| # | Question | Recommended | If not answered |
|---|---|---|---|
| Q1 | **When does a sales day end?** (a 1 AM sale) | **(a) at the store's closing time**: late sales belong to the day the store opened, and the ERP sales day uses the same rule. (b) midnight; (c) a fixed 5 AM | Blocks the Z-reading, day close (PC-8) and the till screen's day boundary |
| Q2 | **First-store go-live date** | **(a) Monday 11 January 2027**: one clean ERP week after the 1 Jan cutover; Lipa staff trained 4-8 Jan. Moves to 1 Feb 2027 if the soak fails twice or the mock-ups are not approved by 27 Nov. (b) 1 Jan | The 9 Nov - 18 Dec build window is unaffected |
| Q3 | **Freeze new features in POS v1 from early November?** (bug fixes allowed) | **(a) yes**: v2 copies v1 once at `e26d0c1`; every later v1 fix is listed and ported | Each later v1 feature is built twice |
| Q4 | **Fix the unsafe void in live POS v1 now?** | **(a) yes**: connect v1's already-written transactional void. Needs Ian's exception (this project never edits v1) and whoever builds the v1 APK | The double-void risk stays until each store switches (Lipa to Davao) |
