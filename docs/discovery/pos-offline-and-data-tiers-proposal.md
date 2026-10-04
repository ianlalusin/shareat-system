# POS 24-hour offline, device storage, and "hot and cold" Postgres: proposal

> Opus planner, 2026-10-04. Skill: `research-evaluate-propose`. Research only: it decides nothing
> and amends nothing. Draft bible and ADR text in §8 is for the orchestrator after Ian agrees.
> **Status: DECIDED 2026-10-04** — one Postgres (bible row 274), 24 h per-device offline (row 276, widens row 77),
> ADR-015 §4–§5. Firebase exit scope is PROVISIONAL (row 275). §9 Q1–Q6 still open; the recommendations stand meanwhile.
> Builds on `docs/discovery/pos-sales-usage-integration-proposal.md` (P0..P3, Lane A/B).
> Ian (verbatim): *"do we need to set up 2 db hot and cold postgres? or not? plan also that pos
> needs to be offline resilient like it can be used in basic billing and order taking for 24hrs.
> so propose if we need caching db or other technique we may use firebase as hot db if needed."*
> and *"since we are making pos as apk can we use device storage as temp storage in offline setting?"*

## Summary (read this alone)

1. **Two Postgres databases: NO.** One DO Managed Postgres (~$15/mo, 7-day PITR included) carries this business past 2028.
   Estimated POS load is under 1.5M rows and about 1 GB a year. A second database pays off only at around 100x that.
2. **Device storage as the offline store: YES. The APK already does it.** POS v1 is a Capacitor 6 APK that bundles the app (`capacitor.config.ts`).
   It keeps Firestore's persistent cache (IndexedDB inside the WebView) and a localStorage outbox on the tablet.
   **Conditions:** it survives app kill and reboot, but not "clear data", uninstall or a dead tablet. The sale outbox must move off localStorage.
   Every offline sale prints paper. A 24-hour soak test on real tablets is the acceptance gate.
3. **Firebase as the "hot db": yes, but only as the EDGE, never as the truth.** It is the device's queue (Lane B) and its menu copy (Lane A).
   That is bible §5 as it stands. Postgres stays the system of record (§2.3).
4. **The real limit is not storage. It is that two tablets cannot see each other with the internet down.**
   Each tablet holds only its own copy. Firestore, PowerSync and ElectricSQL all sync through the cloud, never tablet to tablet.
5. **Recommendation: per-device offline, plus one rule.** Offline, a table is billed only on the tablet that opened it (v1 already
   stamps `ownerTerminalId`). Other tablets may send refills and kitchen tickets, which print on the Bluetooth kitchen printer.
   Refills carry no price (package pricing), so the bill stays right.
6. **Not adopting now:** a store hub box on the LAN (Toast/Lightspeed style). It costs about ₱15k of hardware per store, about 20–30 slices,
   and adds one box whose failure stops the whole store. Revisit only if Ian needs two tablets billing the same tables offline (Q1).
7. **24 hours widens bible row 77** ("tolerance 10 minutes to 1 hour … treat as closed"). This needs an amendment.
   It also adds three things: offline PIN sign-in for shift change, a receipt number that never resets, and an offline cash refund.
8. **Effort:** about 5–7 slices on top of P0–P2. No new database, no new vendor, no hardware.
9. **BIR:** each machine needs a PTU/MIN and its own serial series. A per-device sequence that never resets fits that.
   v1's daily-reset offline counter does not (reported, §4).
10. **Six questions for Ian (§9).** The deciding one is Q1: how many tablets bill in one store, and must they share tables offline?

## 1. Verdict

- **Hot and cold Postgres: do not build.** Keep one primary and add the standard cheap layers when a number calls for them.
- **24-hour offline: build a smaller version.** Per-device offline on storage the tablet already has, with a table-owner rule and a paper trail.
- **Do not build** a LAN hub or a second local database until Q1 says it is needed.

## 2. Hot and cold Postgres

### What "hot" and "cold" could mean, and whether each is needed here

| Meaning | What it is | Needed at this scale? |
|---|---|---|
| Read replica | A second node that reports read from | **No.** One small primary has plenty of headroom. Add one ($15/mo) only if reports measurably slow down the till |
| HA standby | A second node that takes over on failure | **Not now.** The till sells offline, so an hour of DB outage is survivable. Reconsider at P2 ($15/mo) |
| Archive or "cold" DB | Old years moved to another database | **No.** It breaks the ledger's single history and costs every report a join across databases |
| Partitioning | One table split by month | **No.** Worth doing at roughly 50–100M rows in one table. We reach about 1.5M a year |
| Reporting layer | Summary tables or materialized views | **Yes, when a report is slow.** It lives in the same database. This is the "hot and cold" that small systems actually use |

### Sizing (estimate, flagged)

- **Measured inputs:** main store about 33 receipts a day; 9,533 receipts in the POS archive census (discovery 22 §"What this
  research buys"). Four operating stores (`docs/STORE-ROSTER.md`). 19,358 ERP documents over v1's life.
- **Estimate:** 4 stores × ~33 receipts = ~130 a day, or ~48k a year. At ~8 lines, 1–2 payments and ~10 ticket lines each,
  that is **about 1–1.5M rows a year**. At about 300 bytes a row with indexes, **under 1 GB a year**.
  The ERP side (journal, expenses, attendance) is the same order or smaller.
- **Through 2028: about 2–4 GB in total.** That fits the smallest plan's disk with room to spare.
- ⚠️ **A number I could not reach:** the production database's size today. Run on the prod box
  `select pg_size_pretty(pg_database_size(current_database()));`. If it is under 1 GB, this section stands.

### Cost on DigitalOcean

- Today: one Basic node, 1 GiB, about **$15.15 a month**, with daily backups and **7-day PITR included**
  ([cloudcompare](https://cloudcompare.dev/digitalocean-managed-database-pricing)).
- A standby node is billed at the primary's price (+$15.15). A read-only node is similar
  ([pricing guide](https://github.com/qzdy7644/digitalocean-postgresql-pricing)).
- Bible §15.8 still wants a **tested restore**. A nightly `pg_dump` to Spaces (~$5/mo) gives a second copy outside the cluster.

### Recommendation

One primary, PITR as today, a nightly dump with a rehearsed restore, and summary tables for slow reports.
Each of these is triggered by a measured number, never by a calendar date:
- **Standby node:** when POS P2 goes live, if Ian wants failover in minutes rather than a restore.
- **Read replica:** when report queries exceed about 30% of CPU.
- **Partitioning:** when one table passes 50M rows.

## 3. What already exists

| Where | What | Source |
|---|---|---|
| POS v1 | A Capacitor 6 APK that bundles a static export and runs offline. It has no `server.url` | `POS/capacitor.config.ts` |
| POS v1 | Firestore `persistentLocalCache` with a multi-tab manager, stored in IndexedDB inside the WebView | `POS/src/lib/firebase/client.ts:18` |
| POS v1 | Offline start-session, ordering, payment and void, built by writing locally first | `src/lib/offline/commit.ts`; plans 1–5 in `POS/docs/superpowers/plans/2026-07-0*` |
| POS v1 | Offline receipt `SHT-OL-<tag>-<HHMM>-<NNN>`. The per-device counter **resets daily** and is kept in localStorage | `src/lib/offline/offlineReceiptNumber.ts:15-24,62` |
| POS v1 | An outbox for side effects (loyalty, PIN, analytics) in localStorage | `src/lib/offline/payment-queue.ts`; backlog 4B.1 |
| POS v1 | Kitchen tickets print on a Bluetooth printer during an outage | `docs/superpowers/plans/2026-07-02-kitchen-bt-printer-backup.md` |
| POS v1 | A session is stamped `ownerTerminalId` and `revision`, but nothing enforces it | `src/lib/offline/sessionOwnership.ts:8` |
| POS v1 | **Known hole:** an offline void on device A overwrites a sale already paid on device B (backlog 5b). The Firestore rule guard was never built | `POS/docs/superpowers/backlog/2026-07-03-offline-pos-deferred-work.md` |
| POS v1 | The refill modal has no price field. Refills are covered by the package | `src/components/server/RefillPOSModal.tsx` |
| v2 | The two-lane edge, device identity (T-159), the ingestor and quarantine. Built for the clock | bible §5 |
| v2 | Row 77 caps offline at POS selling plus the clock, with a 10 min–1 h tolerance | bible §13 row 77 |

**The stated reason, checked.** *"Use device storage as temp storage"* is already how v1 works, so the answer is mostly "keep it,
and make it sturdier". *"Firebase as hot db"* is already the §5 edge. What neither one gives is **two tablets agreeing on a table
while offline**. That is the part that needs a decision.

## 4. BIR and receipt numbering

- A BIR POS machine needs a **PTU** and a **MIN** for each machine. Invoices are **serially numbered for each machine**, and the
  machine must produce a Z-reading and an eSales journal. Since RR 7-2024 the receipt is a **sales invoice**
  ([Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/invoicing-requirements-under-the-eopt-act/),
  [Ablola](https://ablola.co/2024/04/08/rr-no-7-2024-new-bir-invoice-and-registration-rules/),
  [orkids checklist](https://orkids.ph/guides/bir-accredited-pos)).
- **Per-machine numbering is exactly what an offline tablet can do alone.** There is no block pre-allocation and no server round trip.
- **v2 numbering:** `(store, terminal_no, seq)`. It is continuous, **never resets**, and is used online and offline.
  This also ends discovery 22's two incomparable sequence spaces. Postgres enforces `UNIQUE (device_id, seq)`.
- ⚠️ **Reported, not verified (for the register, section A):** v1's offline counter resets every day
  (`offlineReceiptNumber.ts:62`), and its online counter lives in a separate space. If those receipts are presented as BIR invoices,
  that numbering is not a continuous machine series. Row 75 makes the ERP non-statutory, but **the receipt the diner receives is
  the POS's**, so Q5 asks whether POS is BIR-registered.

## 5. The 24-hour scope

| Works offline | How |
|---|---|
| Open a table, take an order, add-ons | Only on the table's **owner** device. Other devices see the table read-only (stale) |
| Refill request, kitchen ticket | From any device. It prints on the Bluetooth kitchen printer (v1 already does this). Refills are free, so the bill is unaffected |
| Bill, cash, split tender, change | On the owner device. Per-device receipt number. The receipt is printed |
| SC/PWD discount with name and ID | Yes. The discount rules come from the Lane A mirror. The server recomputes after sync (§5.4 rule 1 carve-out) |
| Other preset discounts | Yes, from the mirrored list |
| E-wallet (GCash/Maya QR) | **Recorded as unverified with its reference number.** It is checked against the settlement after sync (T-150). Q4 |
| Refund | Same device, same business day, cash only, manager PIN. Otherwise wait |
| Cashier change mid-outage | **Offline PIN sign-in** against a device-only verifier mirror (new; today v2 has no offline sign-in) |
| X-reading and shift close | Device-scoped. The cash count is recorded as an event, and Postgres adjudicates after sync |

| Refused offline | Why |
|---|---|
| Card, or any tender needing an online check | It cannot be verified |
| Loyalty redemption | A double spend across stores. Earning is queued |
| Anything across stores, new menu items, price changes | These are owned by the ERP and arrive by Lane A |
| A void of another device's table | The v1 backlog 5b hole. Refused by construction |
| CUSTOMER ordering and KDS screens | Online-only (row 77). The kitchen gets printed tickets |

## 6. Options against the criteria

| | (a) Device storage + two lanes (Firestore cache) ★ | (b) Local-first DB on device (SQLite + PowerSync/Electric) | (c) Store LAN hub | (d) Firestore as the truth for POS |
|---|---|---|---|---|
| Two tablets share tables, internet down | **No.** Owner rule + kitchen print | **No.** These sync through the cloud service | **Yes** | **No.** Same cache limit as (a) |
| 24 h | Yes, if the soak test passes (~2k pending writes a day for a busy store) | Yes | Yes | Yes |
| Receipt numbering | Per device. Simple | Per device | Hub sequence | Per device |
| Printing | Bluetooth, already built | Same | LAN printers | Same |
| Tablet dies before sync | That tablet's unsynced sales are lost. Paper is the backstop | Same | Hub keeps them. **The hub dying loses the store** | Same as (a) |
| Effort | **+5–7 slices** | +15–20 slices, and replaces the copied data layer | +20–30 slices and hardware ×4 | Small now; it fails later |
| Licence and cost | Already paid | PowerSync is a hosted service or self-hosted (FSL licence); Electric is Apache-2.0 | Mini PC + UPS ~₱15k a store | — |
| Fits bible §5 | **Yes** (needs the §5.4 POS carve-out already drafted) | A second edge, alongside the clock's | A third tier, against row 77 | **No: §2.3 and §2.4** |

- **Industry:** Square and Toast store and forward on each device
  ([Toast offline](https://central.toasttab.com/s/article/Offline-Mode),
  [Square offline](https://squareup.com/help/us/en/article/7777)). Where devices share orders during an outage, they do it over
  the store LAN, not the cloud. Toast's exact cross-device behaviour was not verified here; read the link before citing it. LAN-hub restaurant systems (Lightspeed Restaurant, legacy
  Micros/Aloha) put a server in the back office.
- **Open source:** [PowerSync](https://powersync.com/) and [ElectricSQL](https://news.ycombinator.com/item?id=37584049) do Postgres
  to SQLite sync, but neither syncs device to device offline. `@capacitor-community/sqlite` (MIT, optional SQLCipher) is the
  right tool if the outbox must leave the WebView (§7 P0 gate).
- **Nothing worth adopting today.** None of them solves the multi-device problem, and each one adds a second edge.

**Device storage, the details Ian asked for:**
- **Durability:** WebView IndexedDB and localStorage live in the app's private directory. They survive app kill, reboot and updates.
  They are lost on "clear data", uninstall, a factory reset, or a dead tablet.
- **Size:** 24 h is about 2k documents a day, which is kilobytes to a few MB. Firestore's default cache is 40 MB, and pending
  writes are never evicted.
- **Encryption at rest:** Android file-based encryption, on by default since Android 10, covers it when the device is locked.
  No card data is ever stored.
- **localStorage** is the weak spot. It is synchronous and a single key, and v1's own plan 1 calls for an IndexedDB single writer.
  Move the outbox and the sequence into IndexedDB, or SQLite if the soak test fails.
- **Loss window** is the unsynced sales of one tablet. **Mitigation:** the printed receipt, plus an X-reading slip printed every 4
  offline hours. A manager can re-enter a lost receipt as a late, audited entry. A second-device mirror would need (c).

## 7. Phased plan (slots into P0..P3)

| Phase | When | Adds for offline |
|---|---|---|
| **E (ERP now)** | before the 15 Nov go/no-go | Nothing. Run the prod size query from §2. No database work |
| **P0 copy and harden** | after 15 Nov; **live after 1 Jan** | O1 numbering `(store, terminal_no, seq)` that never resets, kept in IndexedDB · O2 outbox off localStorage · O3 enforce `ownerTerminalId` offline and refuse a cross-device void (closes backlog 5b) · O4 **24 h, two-tablet soak test on real APKs**, the acceptance gate: 150 sales and 2k writes offline, then reconnect, with zero loss and zero duplicates |
| **P1 reference data and auth** | Q1 2027 | ADR-015 written in plan mode · Lane A gains menu, prices, tenders, discounts and store config · O5 device-only **PIN verifier mirror** (salted hash, readable only by the provisioned device identity, like §5.3 item 2) |
| **P2 receipts** | Q1–Q2 2027 | Lane B sale event with `(device_id, seq)` key; the server recomputes and compares · O6 offline refund and X-reading as events |
| **P3 tables and CUSTOMER** | Q2 2027 | Table sessions in Postgres when online. Offline, the owner device's table events replay through Lane B · **(c) the hub is decided here, and only if Q1 says so** |

## 8. Draft amendments (orchestrator applies after Ian agrees)

- **Row 77, amend:** *"Offline scope stays POS selling + the attendance clock. POS tolerance widens to **24 hours** of basic billing
  and order taking (Ian, 2026-10-04). It is per-device: offline, a table is billed only on the device that opened it, other devices
  send kitchen tickets and refills. There is no local database per store and no LAN hub; the hub is reconsidered at P3 only if
  multiple billing devices must share tables offline."*
- **New row: one Postgres.** *"No second database (hot/cold, archive or replica) while one primary has headroom. Standby, replica
  and partitioning are each triggered by a measured threshold (§2 of this file). A nightly off-cluster dump plus a rehearsed restore
  is required (§15.8)."*
- **§5.3, add:** POS menu, prices, tenders, discounts and store config (Lane A, as already drafted), and **a POS PIN verifier
  mirror** (Lane A, device-identity only), plus **POS sale and table events** (Lane B).
- **ADR-015, extend the draft:** 24 h scope (§5), owner-device rule, per-device continuous numbering, paper trail, the soak test as
  the acceptance gate, and the option (c) trigger.

## 9. Questions only Ian can answer

- **Q1. How many tablets take orders or bill in one store, and must two of them bill the same table when the internet is down?**
  Example: table 5 is opened on the cashier tablet. A server adds a ₱180 drink on her phone during an outage. The cashier's bill does
  not show it until the internet returns.
  - (a) **Recommended:** add-ons are rung on the tablet that owns the table; servers send refills and kitchen tickets only.
  - (b) Every device must share every table offline. This means a hub box per store, about ₱15k each and 20–30 slices.
- **Q2. Do the router and Wi-Fi stay up when the ISP is down (on a UPS)?** If yes, Bluetooth printing could become network printing,
  and (b) above becomes possible. (a) **Recommended:** a router UPS, about ₱3k a store, is worth it anyway.
- **Q3. Printers:** is there a Bluetooth kitchen printer in every store today, and one receipt printer per billing tablet?
- **Q4. Which tenders must work offline?** (a) **Recommended:** cash, plus GCash/Maya recorded as unverified with the reference
  number and checked on sync. (b) Cash only.
- **Q5. Is the POS BIR-registered (a PTU/MIN per tablet), and is its receipt the customer's sales invoice?** This decides whether
  the numbering must follow BIR's serial rules exactly. (a) **Recommended:** design to BIR's per-machine series either way.
- **Q6. Offline refunds:** (a) **Recommended:** same tablet, same day, cash only, manager PIN. (b) No refunds offline.

## 10. Not adopting, and why

- **A second Postgres (hot/cold, archive, replica) now.** It costs an extra $15 a month at least, plus cross-database reporting,
  for a database under 5 GB through 2028.
- **Firestore as the POS system of record.** It breaks §2.3 and §2.4, and it is v1's dual-writer bug class (DEF-007).
- **PowerSync or ElectricSQL.** These are a second edge beside the clock's, they don't solve multi-device offline, and PowerSync is
  hosted or FSL-licensed.
- **A LAN hub per store (option c), now.** Hardware times four, a single point of failure, and 20–30 slices for a need Q1 has not
  confirmed.
- **Offline card or loyalty redemption.** These cannot be verified.
- **Block pre-allocation of receipt numbers.** A per-device series makes it unnecessary.
