# Remaining build plan — what ERP v2 still needs for 15 November and 1 January

> **Status:** PLAN 2026-10-10 (Opus planner), written at `main` `73a1ee8`. **Ian answered §4 on 2026-10-10 (all but
> Q5, which he asked to have expounded); recorded as bible rows 302-306 and in §0b below.**
> **Asked by Ian, 2026-10-10:** *"start planning the building of the missing pieces of ERP v2"*.
> **Sources read:** `docs/RULES.md`, `docs/WHATS-LEFT.html` (as at 10 Oct), `docs/ROADMAP.html` (7 active,
> 20 queued cards), `docs/CAPABILITY-GAPS.md`, `docs/plans/*`, task status lines T-332..T-389, bible §13 rows
> 260-297, ADR-005, ADR-007, ADR-015, `docs/decisions/OPEN-DECISIONS.md` §9-11, and the code named below.
> **Dates that do not move:** 31 Oct HR data · **15 Nov go/no-go + purge rehearsal** · 31 Dec count day ·
> **1 Jan 2027 cutover**. A no-go moves the cutover to 1 Apr 2027 (ADR-005), never to a half-built ledger.

---

## 0. The answer in five lines

1. **The ledger, source documents, inventory, attendance and payroll engines are built** (256 roadmap cards
   done). What is missing for cutover is **not modules — it is the cutover machinery and real use**.
2. **Production has 1 item and no staff (10 Oct).** The dual run that 15 Nov is judged on has not started.
   This is the critical path, and it is operational before it is code.
3. **One real code gap found while planning:** the opening stock count is recorded (`opening_counts`) but
   **nothing turns it into stock layers or a `1310` line** — `stock_usage kind='opening'` has no caller
   (T-168 §7.2, T-169 inv. 10). If found on 31 Dec it is unfixable. Planned as T-390.
4. **Ten items are missing for cutover; nineteen can safely follow it** (§1).
5. **Eight task numbers to reserve, T-390..T-397** (§3.3). **Thirteen questions only Ian can answer** (§4).

---

## 0b. Progress as at 10 Oct 2026, evening (orchestrator)

### Ian's answers are in (Open Questions page, 2026-10-10) — what changes

| Answer | Bible | What moves |
|---|---|---|
| **Q1 (a)** v2 runs everything from 1 Jan, attendance and payroll included · **Q10 (a)** HR sheet late on 31 Oct → payroll stays on v1, staff hired without ids | 302 | **Payroll path: T-190 → T-193 is PRIMARY** (T-190 specced in plan mode in wave 1, built waves 2-4); **T-397 bridge is the FALLBACK only**, built only if the HR sheet is not complete on 31 Oct. The 1 Mar payroll cutover is gone |
| **Q2 (b)** ties = cash/bank, sales by tender, expenses by category, AP per supplier, centavo per store-week; inventory/COGS a named policy difference | 303 | T-392 spec can be written (C4 unblocked) |
| **Q3 (b)** Lipa double-enters from **19 Oct**, all four from **2 Nov**, one office encoder per store · **Q12** cashiers and other staff-role positions encode, the manager verifies | 303 | **Lipa's master data and encoder must be on production by 17 Oct**, not 23 Oct (§2.1). The other three by 30 Oct |
| **Q4 (b)** the Padre Garcia franchise runs on v2 by 1 Jan | 305 | **NEW SCOPE: C11 / T-398** (§1.1). Row 246's trigger fires, so **DEF-491 and DEF-421 become cutover scope**. Biggest single item left (≈ 11 lane-days) |
| **Q6 (a)** morning import timer 06:00 Manila; submit and verify stay human | 303 | T-396 as planned |
| **Q7 (a)** existing bucket, `postgres/`, 30 days — **but** "no backup for now, we'll set up soon" on every T-393 question | 306 | **T-393 is built and tested but NOT switched on** until Ian sets it up. Open point for that day: plan-q7 (existing bucket, 30 days) vs the reviewed spec (dedicated bucket, 35 d / 13 m / yearly). ⚠️ The 13 Nov rehearsal and wizard step C1 need a restored copy: **the 15 Nov go/no-go cannot pass while it is off** (R7) |
| **Q8** "mirror v1, storage is important for commissary only; branches 1 room" · **t390-q2 (a)** last v1 delivery price · **t390-q1 (b)** a manager types items v1 never delivered | 304 | **T-390 S2 unblocked.** §16.11's "weighted average" superseded. Commissary counts per room; branches one room (R1's default room, no code change) |
| **Q9 (a)** revolving fund after cutover · **Q11 (a)** Phase 7 and theme follow cutover, v1 live for them | 302 | §1.2 unchanged |
| **Q13 (a)** T-315 moot | 302 | **T-315 closed** (status line updated) |
| **t395-q1 (a)** | — | already built |
| **Q5** item-import conflicts | — | **Still open**: Ian asked "expound this one"; five per-class questions drafted for the page. T-391 spec waits on them |

| Item | State | Left (lane-days) |
|---|---|---|
| C7 PIN throttle (T-395) | **Done.** S1 live (0190, PR #8); S2 on main (PR #10) | 0 |
| C10 in-flight (T-383 S2, T-386 S5) | **Live** (PR #8). Recode applied (`801ac19`). Left: T-386 S6 CHECK (in a lane) | 0.25 |
| C1/C2 opening stock + tie-out (T-390) | S1 count per room done (0191, PR #10). S3 tie-out in a lane; **S2 unblocked (row 304)**; S4 import/price list; S5 screens | 5.0 |
| A12 keep typing (T-389) | **Done** (`435ee56`; DEF-617, DEF-633 fixed) | 0 |
| C5 backups + restore (T-393) | Spec approved with changes. **Build and test; do not switch on** (row 306). Bucket/retention open point for when Ian sets it up | 1.75 |
| C3 master data (T-391) | spec not written; **needs Q5 (being expounded), the HR sheet**; Lipa's slice by 17 Oct; must split Padre Garcia's v1 items into its own org (row 305) | 3.0 |
| C4 comparator (T-392) | spec not written; **Q2 answered (row 303)**, spec can start | 4.5 |
| C6 rehearsal + runbook (T-394), DEF-585 | spec not written; after C1, C2, C5 | 2.5 |
| C8 three stores + timer (T-396) | spec not written; needs POS ids/keys/tenders per store | 1.0 |
| C9 payroll | **Q1 (a): T-190 → T-193 primary** (HR sheet 31 Oct); T-397 bridge only if the sheet is late (Q10 a) | 5.0 (or 2.0 fallback) |
| **C11 Padre Garcia on v2 (T-398, NEW)** | not specced; DEF-491 + DEF-421 now cutover scope (row 305) | ≈ 11 |
| **Total cutover build left** | | **≈ 34** (≈ 31 if payroll falls back to T-397) |

Measured pace on 10 Oct: three lanes finished ≈ 3.25 lane-days of slices in one session day (T-395 S2, T-389 S2 + S3,
T-390 S1), each with tester-first red, an audit round and a browser smoke. At that pace the cutover **code** is
6-8 working days away, i.e. done around 20-24 Oct, ahead of the 6 Nov line in §2.1, **if** the specs are written ahead
(Opus, in parallel) and Ian's answers arrive. The binding constraints are not code: Q1, Q2, Q5, Q7 and t390-q2; master
data and staff on production by 23 Oct; at least 15 compared trading days before 15 Nov.
**After the answers (same evening, planner):** the cutover set grew from ≈ 21 to ≈ 34 lane-days, all of the growth in
work dated after 15 Nov (C9 payroll and C11 franchise, both due 18 Dec), so the 15 Nov line is unchanged. The binding
constraints are now: **Q5** (T-391); **Lipa master data + encoder by 17 Oct** for the 19 Oct double entry; the **HR sheet
on 31 Oct** (decides T-190/T-193 vs T-397); **T-393 switched on** before the 13 Nov rehearsal; and a **fourth lane for
C11** from wave 2.


## 1. Inventory

Size is **lane-days** (one lane = the Sonnet builder + tester + auditor subagents, bible row 184).
S ≤ 1.5 · M 2-4 · L 5+. "Ian" = needs a decision (D), data (Da), hardware (H) or his presence (P).

### 1.1 Missing for cutover — 11 items

| # | Item | v1 evidence (READ-ONLY) | v2 today | Goal, one sentence | Size | Depends on | Ian |
|---|---|---|---|---|---|---|---|
| C1 | **Opening stock posts from the count** (+ count sheets) | v1 holds no inventory value at all: `ERP-rebuild/src/app/inventory/*` is quantity-only; OPEN-DECISIONS §9; bible row 109 (counted value) | `opening_counts` table + `/cutover/count` screen record qty and cost **per store**; `postOpeningBalances` never reads them; `stock_layers.source='opening'` and `stock_usage kind='opening'` exist with **no writer** (T-168 §7.2) | On 1 Jan every counted item sits in the right room as a FIFO `opening` layer and the same value is one `1310`/`3900` line, so stock and books agree from the first sale | **M (3.5)** | none (cutover module) | ✅ commissary per room, branches one room; last v1 delivery price; unpriced typed by a manager (row 304) |
| C2 | **Opening subledgers tie to their control accounts** | v1 52 asset docs (`accounting/assets`, `inventory/assets`), loans (`accounting/loans`, cron `api/cron/loan-autodeduct`), prepaid (`inventory/prepaid`) | Opening figures post GL lines only (`cutover/opening.ts`); asset, loan, prepaid and advance **register rows** are created by their own screens with no check that register = opening figure | The C4/C5 wizard gates refuse to post while any control account (`1510/1590`, loans, prepaids, `1230`, AR/AP per party, money accounts) disagrees with its register | **S (1.5)**, folded into T-390 | C1 | — |
| C3 | **Production master data loaded** | 842 v1 item records → ~385 names (`scripts/import-items.ts` header); suppliers `financial/suppliers`; wholesale customers `financial/ar`; staff `manager/staff` (126 staff) | Item import script exists, **sample mode, five conflict classes unruled**; no supplier, customer or staff import (hire is one form at a time); production holds 1 item, 0 staff | Every store, money account, item, supplier, customer, position and person the pilot needs is in production once, deduplicated, before staff are asked to use v2 | **M (3)** | T-386 S5 recode; Q5 rulings | D (Q5) · Da (HR sheet) · P (dry runs) |
| C4 | **Dual-run comparator (v1 ↔ v2)** — absorbs T-114b | v1 journal/expenses/salesDays in Firestore (19,358 docs, `docs/STORE-ROSTER.md`); v1's own `api/cron/reconcile` | ETL capture, leg mapping and replay are built (T-112, T-113, T-117 done); **T-114b audit report is spec-only and on no board**; nothing compares a v1 period with a v2 period | One report per store per week that says, line by line, where v1 and v2 agree to the centavo and names every difference as a known policy class or a defect, so Ian can sign the dual run | **M-L (4.5)** | C3 (v2 needs real entries) | ✅ Q2 (b), row 303 |
| C5 | **Nightly off-cluster backup + rehearsed restore** | n/a (v1 is Firestore) | DO Managed Postgres native backups only; **no dump, no restore ever rehearsed**; bible §15.8, row 274 and ADR-002 §1-3 require both; wizard step C1 asks for it | A dump lands in Spaces every night, a failure alerts, and a scripted restore into a scratch cluster proves the trial balance ties | **S (1.5)** | none | ✅ Q7 (a) but **not switched on** until Ian sets it up; bucket/retention open point (row 306) |
| C6 | **Purge + opening rehearsal on a restored copy; cutover runbook and rollback** | n/a | `scripts/cutover-purge.ts` + `packages/db/src/cutover/purge.ts` built and tested (T-119, T-347); never run against a copy of production; no hour-by-hour runbook; no written rollback (bible §10 phase 8) | By 13 Nov the whole 1 Jan sequence has run end to end on a restored copy, timed, with the runbook and the "go back to v1" rule written down | **M (2)** | C1, C2, C5 | P: attends the rehearsal; signs the runbook |
| C7 | **PIN sign-in throttling (DEF-063)** | v1 `(auth)/login` | **Built 2026-10-10 (T-395 S1+S2; DEF-063 fixed):** wrong PINs charged before the check, 50 a day stop a store, attempt log, two findings, manager reopen on /staff. Earlier: lockout PARTLY existed (T-303, 0147) | Repeated wrong PINs at a store or device lock that pairing for a while and raise a finding, before the first cashier gets a PIN | **S (1.5)** | none | — |
| C8 | **Other three stores linked to POS + automatic morning import** | POS `external/sales/route.ts`; `docs/ops/lipa-pos-link-runbook.md` | Lipa linked (row 284); import is a button; DEF-586 stays partly open until every store is linked | Malvar, Banay-Banay and Davao import their closed days like Lipa, and every linked store's day is fetched by a timer each morning so a human only submits and verifies | **S (1)** + runbook × 3 | C3 (tenders, money accounts) | Da: POS store ids, keys, tenders · D (Q6) |
| C9 | **Payroll on 1 Jan, one way or the other** | v1 `operation/payroll`, `operation/attendance/time-clock` | Phase 5 16/18: **T-190 not specced**, T-193 after it, both gated on HR data (0 of 126 staff); T-314 fingerprint blocked on hardware; no bridge entry exists (ADR-005 "Temporary bridges") | The first 2027 payday is computed and posted correctly: either by v2 (T-190, T-193, terminals live) or by v1 with one monthly summary entry in v2 citing the v1 register | **M (2)** bridge · or **M+M (5)** T-190/T-193 + T-314 | Q1; HR data 31 Oct; tablets | ✅ Q1 (a): T-190/T-193 primary, T-397 fallback (row 302) · Da (HR, 31 Oct) · H (tablets, reader) |
| C11 | **Padre Garcia franchise on v2 as its own organisation** (NEW, Q4 b, row 305) | v1 models it as a **branch** (ADR-008 §7): store `SharEat Padre Garcia` `y1DMgfisuTHBF57cNL6i` (`docs/STORE-ROSTER.md`: 0 documents at the roster; v1 items exist, e.g. `white onion` in PCS there, `scripts/import-items.ts` header) | **Designed, not onboarded.** Exists: `organizations` is a real boundary with RLS (T-120/T-121); `createOrganization` / `createFirstAdmin` / bootstrap (`packages/domain/src/organizations/index.ts`, `/setup`); one person row per org (row 175); a franchise owner is a `manager` (row 114, T-121 A.1); `customers.counterparty_org_id` + `customer_group='franchise'` derive the inter-entity treatment (ADR-008 §2); capability `view_franchise_sales` (super-admin only, `packages/auth/src/capabilities.ts:988`). **Missing:** (1) **DEF-491**, ≈ 360 + 79 same-org FKs, persons and stores first (row 246's gate) · (2) **DEF-421**, ~60 `tx: Tx \| null` sites with no org principal · (3) the inter-entity sale: `createTradeOrder` refuses another org (`packages/domain/src/trade/index.ts:203`, "no second org exists"); the commissary's revenue + COGS and the franchisee's inventory + AP, both sides reconciling (ADR-008 §4, `phase-3-inventory.md:394`) · (4) the franchisor's **sales-only** view: the capability has no reader and no screen; break-glass logging (T-121 A.3) · (5) onboarding: Padre Garcia's org, Ian's org-admin person row there (T-121 A.4), its store, money accounts, items (split out of the T-391 import, which today reads every v1 store into one org), staff, POS link, its own opening count and figures | Padre Garcia trades on v2 from 1 Jan in its own books, the commissary sells to it as a real sale, Ian sees its sales and nothing else, and no row of one org can point at a row of another | **L (≈ 11)**: DEF-491 4.5 (Workflow sweep, row 298 #5) · DEF-421 1.5 · inter-entity sale 2 · sales-only view + break-glass log 1.5 · onboarding + POS link + split import 1.5 | DEF-491/421 before any Padre Garcia row is written in production; C3 (split import); C1 (its count) | D: the franchise agreement's sales visibility (ADR-008 §5); who holds its org-admin (T-121 A.4) · Da: owner, staff, POS store id/keys/tenders · P: its count on 31 Dec |
| C10 | **In-flight finishing** — T-386 S5/S6, T-383 S2, DEF-585 (no fiscal period before Oct 2026) | — | On main or specced; DEF-585 open | Item codes final, retire/restore live, every cutover-dated posting has a period | **S (1.5)** | — | P: recode dry run |

### 1.2 Safely after cutover — 19 items (v1 covers each until it ships, or nothing posts)

| # | Item | v1 evidence | v2 today | Goal | Size | Ian |
|---|---|---|---|---|---|---|
| A1 | ADR-015 P0-P3: POS and CUSTOMER on the shared backend | `POS`, `CUSTOMER` repos | Planned; P0 live after 1 Jan (row 269) | One Postgres, one auth, three apps | L (phase) | H: tablets, printers (ADR-015 §8) |
| A2 | Activity-log viewer (+ its writers) | `ERP-rebuild/src/app/activity-log` | `audit_log` schema, partial writers, no screen | Anyone authorised can see who changed what | M | — |
| A3 | Memos with roster sign-off | `manager/memos`, `api/memos` | none | A memo reaches every current staff member and records who read it | M | count first |
| A4 | Performance and team view | `performance`, `insights/performance`, cron `rebuild-performance` | none | Fix v1's shift-attribution defect, then score | M | count first |
| A5 | Opening/closing checklists | `operation/checklist`, `/settings` | none | Daily store checklists with evidence | M | count first |
| A6 | Infractions with a real capability row | `operation/infractions` | none | Discipline records managers can enter, staff cannot | S-M | — |
| A7 | Onboarding as one gated track | `onboarding`, `admin/onboarding` | none (redesign decided 2026-09-05) | A new hire cannot skip steps | M | — |
| A8 | Cookbook and recipes | `cookbook`, `branch-cookbook` | none | Reference recipes per store | S-M | count first |
| A9 | Tutorials | — | assessment `docs/discovery/30-tutorials-assessment.md` | On-demand walkthroughs | M | count first |
| A10 | Remaining reference-data screens (salary-advance policy, positions, wastage-reason verdict) | `manager/settings/*` (13 screens) | `/settings` hub + 6 screens | No engineer needed to add a position or category | S-M | D: wastage reasons stay a constant? |
| A11 | T-343 remainder (S5.4, S8, S9; ~180 refusals naming ids) | — | in progress | Every refusal in words | M | — |
| A12 | T-389 keep-typing on 33 forms (DEF-617) | — | specced, 5 slices | A refused save never loses typing | M | — (pilot-helpful: run in Lane 4 if capacity) |
| A13 | T-334 S3 / T-387 theme and dark toggle | — | specced | Brand look (ADR-013 A7) | M | — |
| A14 | ~~T-315 pre-fix staff store access~~ **closed as moot (Q13 a, row 302)** · T-320 non-position access | — | reserved | — | S | — |
| A15 | T-136 §2 revolving fund · T-141 upload UI | — | open / service built | — | S-M | ✅ after cutover (Q9 a) |
| A16 | ~~DEF-491 / DEF-421 same-org checks~~ **moved into C11** (Q4 b: a second org by 1 Jan, row 305) | — | — | — | — | — |
| A17 | Small follow-ups DEF-373, 548, 549, 608, 609; T-308 B | — | open | — | S | Da: T-308 B token |
| A18 | Supplier vouchers home (CAPABILITY-GAPS 2026-10-04) | v1 `other` method: 2 staff rows ever | none | A voucher held is an asset | S-M | count first |
| A19 | Later by ruling: T-363 doubtful flag, T-309 own Firebase project, T-146 OCR, AI brain phase 0, smart-reorder revival, notifications, T-206 droplet retirement | — | rulings recorded | — | — | — |

---

## 2. Critical path

### 2.1 What must exist, by when

| By | Must be true | Items | If it slips |
|---|---|---|---|
| **16 Oct** | Lipa's closed days import daily; T-386 recode applied ✅; Q1, Q2 answered ✅; Q5 answered | C8 (Lipa), C10, Q5 | Every later date slides one-for-one |
| **17 Oct** | Lipa's master data (items, suppliers, money accounts) and its office encoder + verifier on production | C3 (Lipa slice) | The 19 Oct double entry starts late, one-for-one |
| **19 Oct** | **Lipa double-enters expenses and deliveries in v2** (Q3 b) | operational | Fewer compared days by 15 Nov |
| **23 Oct** | PIN throttling live ✅; master data for all four stores in production | C7, C3 | The 2 Nov start for the other three slips |
| **31 Oct** | All four stores linked and importing; **HR sheet received → T-190/T-193; not complete → payroll stays on v1, T-397 instead (Q10 a)**; backups nightly with one restore proven **if Ian has switched T-393 on** | C8, C5, HR | ADR-005 31 Oct checkpoint fails: escalate to Ian that day |
| **2 Nov** | All four stores double-enter (Q3 b), one office encoder per store | operational | Comparator covers Lipa only |
| **6 Nov** | Opening stock and subledger tie-out built; comparator produces its first week report | C1, C2, C4 | Rehearsal runs without the opening stock: a no-go risk on its own |
| **13 Nov** | Rehearsal on a restored copy: purge, opening figures (Lipa test count), trial balance ties, timed; runbook and rollback written. DEF-421 and DEF-491 persons + stores done (C11 part 1) | C6, C5, C11 | **No-go** — ADR-007 makes the rehearsal part of the gate; **needs T-393 switched on** |
| **15 Nov** | **Go/no-go pack:** ≥ 15 compared trading days, every difference classed; rehearsal report; open-defect list | C4, C6 | 1 Apr 2027 |
| **4 Dec** | Padre Garcia org onboarded on production (all of DEF-491 in; inter-entity sale; sales-only view); its staff and POS link | C11 | Padre Garcia stays on v1 past 1 Jan; your org cuts over alone |
| **18 Dec** | Payroll path built (T-190/T-193, or T-397 if the HR sheet was late); runbook frozen; second rehearsal on a fresh copy **with two organisations** | C9, C6, C11 | Payroll stays on v1 with a manual bridge entry typed on 31 Jan |
| **31 Dec** | Count day, asset walk, final v1 depreciation run (wizard A2, B1-B3) | operational | Opening inventory unknowable afterwards |
| **1 Jan** | Purge, opening entry, 3900 = 0, trial balance ties, POST | C6 | Roll back to v1 per the runbook |

### 2.2 What can slip past January safely

Everything in §1.2. The test applied: **nothing in it posts to the ledger, and v1 keeps covering it** (v1 stays
live for memos, checklists, infractions, cookbook, onboarding and performance until each ships). A1 (POS
shared backend) is dated after 1 Jan by row 269 anyway. **Payroll and attendance no longer slip by design** (Q1 a,
row 302): they slip only if the HR sheet is late on 31 Oct, and then by T-397's bridge entry (Q10 a). **Padre Garcia
(C11) is the one cutover item that can be dropped alone** without moving your org's date: if it is not onboarded by
4 Dec it stays on v1 and your organisation cuts over without it.

### 2.3 The one thing nothing can compress

The dual run is measured in **trading days with real entries in v2**. Code finishes early or late; a day not
entered in v2 cannot be compared later. Every day before 23 Oct without staff on production is a day lost from
the 15 Nov evidence.

---

## 3. Build order

### 3.1 Lane partition — no two lanes share a module, a table or a migration in the same wave

| Lane | Owns (write) | Never touches in the same wave |
|---|---|---|
| **L1 Cutover** | `packages/domain/src/cutover/**`, `packages/db/schema/cutover.ts`, `packages/db/src/repo/cutover.ts`, the `opening` writer into `stock_layers` / `stock_ledger` / `stock_usage` (that kind only), `apps/erp/src/app/cutover/**`, `scripts/cutover-*` | items, persons, auth, ETL |
| **L2 Data** | `scripts/import-*`, `scripts/recode-items.ts`, `items`, `suppliers`, `customers`, `persons`/`employments` import paths, T-383 S2, T-386 S5/S6, then payroll T-190/T-193 if Q1 = (a) | stock tables, cutover, ETL |
| **L3 Ops** | `packages/etl/**`, `packages/auth/**` (throttle), `docs/ops/*.service`, `*.timer`, `scripts/backup-*`, `scripts/restore-*`, the POS feed timer (`pos-feed` import entry point only) | items, cutover, stock |
| **L4 Org** (from wave 2; was "Screens") | **T-398**: DEF-421 (domain signatures), DEF-491 (composite same-org FK migrations, one table family per migration), the inter-entity sale in `packages/domain/src/trade/**`, the franchisor sales view; T-343 remainder only when idle | `cutover/`, `items/`, `staff/` while L1 or L2 has it open; **its FK migrations are serialised by the orchestrator against every other lane's migration** |

**Migrations are serialised by the orchestrator:** a lane takes the next free number **at merge, never at
spec** (next free is **0190**). Expected in wave 1: L1 opening-layer guard (if any), L3 `sign_in_attempts`,
L2 the T-386 S6 item-code CHECK. Each new table is classified in `classification.ts` and `rls/registry.ts`
(the build refuses otherwise) and hand-authored per ADR-012.

### 3.2 Waves

| Wave | Dates | L1 Cutover | L2 Data | L3 Ops | Ian / ops (no code) |
|---|---|---|---|---|---|
| **0** | 12-16 Oct | T-390 S2, S3 | T-386 S6; **T-391 Lipa slice** (after Q5) | T-393 build (not switched on) | Lipa tenders + first imports; answer Q5; Lipa encoder named (Q12) |
| **1** | 13-24 Oct | **T-390** S4, S5 | **T-391** master data load (items full, suppliers, customers, staff; Padre Garcia's split out) | **T-393** S2 drill → spec T-392 | **Lipa double-enters from 19 Oct**; HR sheet by 31 Oct; spec T-190 and T-398 (Opus, plan mode) |
| **2** | 26 Oct-7 Nov | DEF-585; spec T-394 | **T-396** link 3 stores (data + runbook); **T-190** build if the HR sheet is in | **T-392** dual-run comparator (+ T-114b) → T-396 06:00 timer | **L4: T-398** DEF-421 → DEF-491 persons + stores · all four double-enter from 2 Nov; weekly comparator review |
| **3** | 9-14 Nov | **T-394** rehearsal on a restored copy + runbook | T-190 | comparator week 3 report; go/no-go pack | **L4: T-398** DEF-491 rest · rehearsal (present; T-393 must be on), **15 Nov go/no-go** |
| **4** | 16 Nov-18 Dec | second rehearsal (two orgs); count sheets printed (commissary per room, branches one room) | **T-193** (or **T-397** only if the HR sheet was late) | DEF follow-ups (A17) | **L4: T-398** inter-entity sale, sales view, Padre Garcia onboarded by 4 Dec · count-day team per store |
| **5** | Q1 2027 | — | Phase 7 (A2-A10) by count-first order (Q11 a) | ADR-015 P0 | Revolving fund (Q9 a) |

L4 is now the Org lane (T-398) from wave 2 (T-389 is done). It never takes a builder from L1-L3 before 15 Nov; T-343 runs in it only when T-398 is idle.

### 3.3 Task numbers to reserve (do not create the files yet)

| T- | Title | Lane | Wave | Size |
|---|---|---|---|---|
| **T-390** | Opening stock from the count into FIFO `opening` layers per room + `1310`/`3900`; opening subledger tie-out gates (assets, loans, prepaids, `1230`, AR/AP per party, money accounts); printable count sheets | L1 | 1 | M 3.5 + S 1.5 |
| **T-391** | Production master-data load: full item import with Ian's conflict rulings, supplier and wholesale-customer import, staff roster import with statutory ids (one HR sheet), money-account and POS-map checklist per store | L2 | 1 | M 3 |
| **T-392** | Dual-run comparator v1 ↔ v2 per store per week, with named difference classes (absorbs T-114b) | L3 | 2 | M-L 4.5 |
| **T-393** | Nightly off-cluster `pg_dump` to Spaces `postgres/`, failure alert, scripted restore into a scratch cluster with a trial-balance tie check | L3 | 1 | S 1.5 |
| **T-394** | Purge + opening rehearsal on a restored copy; the 31 Dec-2 Jan runbook; the rollback rule; DEF-585 | L1 | 3 | M 2 |
| **T-395** | PIN sign-in throttling and lockout per store and device, failed-attempt finding (DEF-063) | L3 | 1 | S 1.5 |
| **T-396** | Link Malvar, Banay-Banay, Davao to POS (runbook ×3) and a morning import timer for linked stores; submit and verify stay human | L2 + L3 | 2 | S 1 |
| **T-397** | Payroll bridge entry: one monthly summary posting per store citing the archived v1 payroll register, idempotent per period. **FALLBACK ONLY** (Q1 a, Q10 a): built only if the HR sheet is not complete on 31 Oct | L2 | 4 | M 2 |
| **T-398** | Padre Garcia on v2 as its own organisation: DEF-421, DEF-491 (persons + stores first), the inter-entity sale both sides, the franchisor's sales-only view with break-glass logging, onboarding (org, Ian's org-admin row, store, accounts, split item import, staff, POS link, its opening) (Q4 b, row 305) | L4 | 2-4 | L ≈ 11 |

Total cutover build ≈ **21 lane-days** across three lanes ≈ 7 lane-days each, against ~24 working days to
15 Nov. The slack is real but small; it is spent if master data or the HR sheet arrive late.
**After Ian's answers (10 Oct):** ≈ **34 lane-days** across four lanes; the added ≈ 13 (T-190/T-193 instead of the
bridge, T-398) is due 18 Dec, not 15 Nov.

---

## 4. Questions only Ian can answer (for the Open Questions page)

> **ANSWERED 2026-10-10, all but Q5** (Ian asked to have it expounded; five per-class questions go to the page).
> Q1 a · Q2 b · Q3 b · Q4 **b** · Q6 a · Q7 a, but T-393 not switched on yet · Q8 commissary per room, branches one
> room, last v1 delivery price · Q9 a · Q10 a · Q11 a · Q12 staff-role positions encode, the manager verifies ·
> Q13 a. See §0b and bible rows 302-306. The table below is kept as asked.

| Id | Question | Options | Recommended |
|---|---|---|---|
| **Q1** | Which modules does v2 run from 1 Jan? | (a) everything built: books, sales, expenses, AP/AR, inventory, attendance, payroll · (b) books, sales, expenses, AP/AR **and inventory** on 1 Jan; attendance and payroll stay on v1 until **1 Mar** with a monthly bridge entry (T-397) · (c) ADR-005 as written: books only, inventory and payroll by bridge | **(b).** Perpetual inventory cannot be fed by a monthly summary without a second count (row 165), so inventory goes in. Payroll depends on HR data that does not exist yet, on T-190/T-193 that are not specced, and on clock tablets that are not bought; a 15 Jan payday is the worst first test. |
| **Q2** | What must "tie" for you to sign the dual run? | (a) the whole trial balance · (b) cash and bank, sales by tender, expenses by category, AP per supplier, to the centavo per store-week; inventory and COGS shown as a named policy difference · (c) totals only | **(b).** v1 expenses stock on purchase (no inventory asset); v2 is perpetual FIFO. A whole-TB tie is impossible by design and would turn the sign-off into an argument. |
| **Q3** | Dual-run scope: who double-enters expenses and deliveries in v2? | (a) Lipa only, from 19 Oct · (b) Lipa from 19 Oct, all four from 2 Nov, one office encoder per store · (c) all four from 19 Oct | **(b).** Sales come from the feed with no typing; expenses and deliveries are the only double entry. Lipa first finds the friction cheaply. |
| **Q4** | Does any franchise (Padre Garcia) run on v2 by 1 Jan? | (a) no, your organisation only; franchises after DEF-491/421 in Q1 · (b) yes | **(a).** DEF-491/421 (~360 links, ~60 functions) are the price of a second organisation; your ruling of 29 Sep already defers them to that day. |
| **Q5** | Item import conflicts (five classes in `scripts/import-items.ts`) | per class: (1) same item, different unit per store · (2) a box/pack as base unit · (3) pack→pack ≠ 1 · (4) punctuation twins · (5) the rest | (1) the unit most stores use, others get a conversion; (2) base unit becomes the piece/kg inside, box as a conversion; (3) drop the conversion; (4) one sheet of pairs for you to tick merge or keep; (5) report only. |
| **Q6** | Should each linked store's closed day be fetched automatically each morning? | (a) yes, 06:00 Manila, submit and verify stay human · (b) keep the button | **(a).** Four stores × import + submit + verify is twelve clicks a day; only the two human checks carry control. |
| **Q7** | Backups: a nightly dump to the existing `shareat-erp-backups` bucket under `postgres/`, plus a monthly restore into a temporary cluster? | (a) yes, prefix-scoped 30-day retention, never touching the Frappe objects · (b) separate bucket · (c) rely on DO's built-in backups | **(a).** Uses what exists (ADR-002); the restore rehearsal is what the 15 Nov gate needs. Needs you to place a Spaces key in the droplet env (an agent may not handle it). |
| **Q8** | Count day: per room or per store, and whose unit cost? | rooms: (a) per room · (b) per store, then placed in the main room · cost: (c) last v1 delivery price · (d) supplier catalogue price | **(a) + (c).** Stock lives per room in v2 (T-160); a per-store count would put everything in one room and the first transfer would refuse. The last delivery price is the closest to FIFO cost that exists. |
| **Q9** | Revolving fund (T-136 §2): before or after cutover? | (a) after; standing floats (T-366) cover store cash on 1 Jan · (b) before | **(a).** No defect or gap depends on it; floats already hold store cash. |
| **Q10** | If the HR sheet is not complete on 31 Oct, what then? | (a) payroll stays on v1 (Q1 b) and staff without ids are hired without them · (b) delay staff onboarding | **(a).** Staff can sign in and work without statutory ids; only payroll needs them. |
| **Q11** | Confirm Phase 7 (memos, checklists, infractions, performance, onboarding, cookbook, tutorials, activity-log viewer, remaining settings) and the theme work all follow cutover, with v1 kept live for them | (a) yes · (b) pull named ones forward | **(a)**, except the activity-log viewer if you want an audit screen on day one (one M task). |
| **Q12** | Who owns pilot onboarding at each store (who signs staff in, who encodes, who verifies)? | names per store | One encoder and one verifier per store, different people (row 293). |
| **Q13** | T-315 (store access for staff hired before the fix): close as moot? | (a) close: production has no pre-fix staff · (b) keep for dev databases | **(a).** Your option 2 answered a problem production never had. |

---

## 5. Risks to 1 January

| # | Risk | Likelihood · impact | Mitigation |
|---|---|---|---|
| **R1** | **The pilot has not started** (1 item, 0 staff on production, 10 Oct), so 15 Nov has too few compared days and is a no-go by default | High · fatal to the date | Wave 0 is operational: Lipa imports daily from this week; T-391 by 23 Oct; a daily "v2 entries yesterday" count on the board; escalate on 31 Oct per ADR-005, not in December |
| **R2** | **Opening stock has no posting path** (found 2026-10-10); discovered on 31 Dec it is unfixable | Certain if not built · fatal to the books | T-390 first in L1; rehearsed on 13 Nov with a real Lipa test count, not a fixture |
| **R3** | **Payroll chain** (HR data → T-190/T-193 unspecced → tablets → fingerprint) meets a 15 Jan payday | High · high | Ian chose Q1 (a): T-190 specced in wave 1, built from wave 2; **31 Oct is the decision point** — HR sheet incomplete → T-397 bridge (Q10 a) built by 18 Dec |
| **R4** | **No rehearsed restore**: the 15 Nov rehearsal needs a restored copy and the 1 Jan purge is irreversible | Medium · fatal | T-393 in wave 1; wizard C1 refuses until a restore is rehearsed; second rehearsal mid-December |
| **R5** | **The dual-run sign-off becomes an argument**: v1 is periodic and has its own imbalances, v2 is perpetual | High · delays the sign-off | Q2 fixes the definition now; T-392 names every difference class; T-114b's v1 imbalance list feeds your 2026 close |
| **R6** | **A second organisation by 1 Jan** (Q4 b): DEF-491's ≈ 440 FK changes touch every table family and every lane's migrations; the inter-entity sale has never posted | Medium · high (to Padre Garcia only) | T-398 in its own lane (L4) with orchestrator-serialised migrations; a Workflow sweep per table family (row 298 #5); persons + stores first; Padre Garcia is dropped alone, not the cutover, if 4 Dec is missed |
| **R7** | **Backups not switched on** (row 306): no restored copy for 13 Nov | Certain until Ian acts · fatal to the 15 Nov gate | T-393 built and drilled locally; the go/no-go pack names it on 1 Nov if still off |

Also watched: screen polish (T-389, T-343, T-387) consuming the lanes the cutover needs. Rule for the
orchestrator: L4 never takes a builder from L1-L3 before 15 Nov.
