# POS v2 + Customer v2 — phase plan (update of the 13 Oct plan)

| | |
|---|---|
| **Status** | DRAFT by the Opus planner, 2026-10-15. Replaces the dates and task list of the "posv2" plan artifact (13 Oct); its stack, offline and feature tables stand unless changed below |
| **Authority** | ADR-015 (copy, harden, swap by owner) · bible rows 269-276, 280, 283, 307, 313-323, 331, 335 · `docs/RULES.md` |
| **Inputs** | posv2 plan data + Ian's 13 Oct answers (128 answer files) · `pos-v1-study.md` and `customer-v1-study.md` (15 Oct, read-only) · Ian's 15 Oct rulings · CI timings from GitHub (run of 15 Oct 12:15 UTC) |
| **Does not** | amend the bible or ADR-015 (task PC-1 does) · write task specs (listed in §6, written next in plan mode) |

## 0. 22 October update: Lipa on v2 by 1 January, aiming for early December (bible row 378)

Ian chose ERP v2 and POS v2 (Lipa) both live by 1 Jan, Customer v2 in P3, and "work faster to ship earlier".
§1 item 1 and the 11 Jan date below are superseded. P0 ships on v1's Firebase. It writes v1's Firestore format
unchanged, so Lipa can switch before the ERP cutover. The target is Mon 7 Dec; the deadline is 1 Jan.

| By | Step | Who |
|---|---|---|
| ~~31 Oct~~ **2 Nov** | Audit + full CI + merge `codex/pos-shared-backend` (T-425/426/427, T-456-460, T-461-463) as PR #47. Audit done 22 Oct (verdict MERGE); PR #47 ready at `ebce489`. GitHub Actions minutes ran out on 22 Oct; Ian chose to wait for the monthly reset (1 Nov) instead of paying, so no CI or deploy runs until then, and PR #47 merges only after a green run | orchestrator |
| 31 Oct | v2 APK signing key in GitHub; Lipa tablet model/Android/memory + printers; DNS `pos2.shareat.net` | Ian |
| 7 Nov | POS v2 server switched on (runbook §0 steps 3-9); manager PINs + `approve_pos_correction` at Lipa | orchestrator + Ian |
| 9 Nov | POS v1 feature freeze (row 348, unchanged) | — |
| 14 Nov | Emulator full run (T-463) + real Lipa tablet and printer check | orchestrator + Lipa staff |
| 21 Nov | PC-8 day close / X-Z slip (business day ends at closing, row 348): spec in plan mode, build, audit | POS lane |
| 23-29 Nov | Soak test, 24 h, two tablets: 0 lost, 0 doubled. A failure retries 30 Nov - 4 Dec | orchestrator |
| 1-5 Dec | Lipa staff training on the new payment and stand screens | Ian + Lipa |
| **Mon 7 Dec** | **Lipa on POS v2** (v1 stays installed as roll-back). Fallback dates: 14 Dec, then 1 Jan at the latest | — |
| 21 Dec - 10 Jan | No new store switches (holidays, ERP cutover 1 Jan) | — |
| from 11 Jan | Malvar, then Davao: one a week, each after one clean week (Banay-Banay is closing and leaves v2, row 377) | — |

**Data rule (bible row 379).** Pre-2027 POS data is test data; nothing but master data and loyalty point balances
crosses over. New task (spec to write, number at writing): **nightly per-receipt bridge**, Firebase -> Postgres, all
stores, from 1 Jan, extending the T-396 06:00 import; read-only on Firebase; spec by 13 Nov, built and dry-run on
December data by 18 Dec, live 2 Jan for 1 Jan's sales.

Faster how: the POS lane runs beside the ERP lanes; emulator checks replace the cloud TEST project (T-463);
Ian's asks are batched into the 31 Oct list above. P1 shared-backend coding (T-462) competes for the same lane.


## 0b. Owner direction — 21 October 2026 (P1 start; the Firebase-release default is overridden by row 378)

Ian reviewed the phases, said **"start now"**, and requested **"use emulator to test it when build"**.
This updates the work order below; the October 15 dates remain historical draft targets, not renewed commitments.

- Deliver POS as an Android APK. Keep unsent sales and a durable outbox on the device; synchronize through
  authenticated server APIs into the **same PostgreSQL backend as ERP**. Never connect the APK directly to Postgres.
- Begin **P1 now**, preserving the tested P0 billing, receipts and offline ledger. An interim Firebase production
  rollout is no longer the default prerequisite. Firebase retirement still requires completing each ownership move.
- Device storage does not require Firebase. **SQLite adoption is undecided**: test existing IndexedDB persistence
  first, then scope any native storage change and migration separately. Do not describe SQLite as installed or approved.
- Use an isolated Android emulator and local Firebase **demo-shareat-pos2** emulators for remaining legacy paths.
  These local checks do not require a separate cloud Firebase project. A TEST store inside live Firebase remains
  prohibited; no live Firebase or production payment writes are authorized by this testing direction.
- Emulator checks cover APK installation, offline persistence, restart and reconnect where implemented. Real tablet,
  printer, payment, visual and offline-soak gates remain before release; an emulator pass does not replace them.

Current sequence: **T-463 emulator harness → P1 enrollment/shared sign-in and reference snapshots → P2 receipts,
payments and till into Postgres → P3 tables/KDS/Customer → P4 remaining rollout/extras**.
P1 must prove tablet possession rather than trust a public device UUID, reuse shared permissions/session services,
and specify offline verifier expiry/revocation behavior. Offline refunds remain prohibited by the later T-425 ruling.
See [T-462](../tasks/462-pos-shared-postgres-p1.md) and the
[bounded assessment](../discovery/pos-p1-shared-backend-start.md). This records direction, not completed migration
or POS release approval; planner synchronization of historical dates and bible decision rows remains outstanding.

## 1. Original 15 October recommendation

1. **Going live on 1 January itself is not safe. Go live in the first store (Lipa) on Monday 11 January 2027.**
   1 Jan is the ERP cutover day (purge, opening entry, first POST). Putting the first POS v2 store on the same
   day doubles what can go wrong and splits Ian's attention. The 13 Oct plan already said "live *after* 1 Jan,
   once the ERP's January close is steady" (risk `same-time-cutover`); 11 Jan is the first Monday that allows
   one clean ERP week. The build window (9 Nov - 18 Dec) is unchanged.
2. **The date is tight, not broken.** Three things make it tight: Ian chose to **redesign the payment and table
   screens before go-live** (13 Oct, `redesign` = b), the live void bug must be fixed in the copy (§3), and
   Nov-Dec is also the ERP crunch (15 Nov go/no-go, 4 Dec Padre Garcia, 18 Dec payroll). If the soak test
   fails twice, or the mock-ups are not approved by 27 Nov, first-store go-live moves to **1 Feb 2027**.
3. Customer v2 stays with P3 (Q2 2027), moving store by store together with POS (row 269).

## 2. Phases and dates

| Phase | Dates | Delivers | Gate to finish |
|---|---|---|---|
| **E** ERP reads the v1 day feed | now - 15 Nov 2026 | unchanged (T-375 feed, locked sales day, tender master) | 15 Nov go/no-go |
| **M** ERP master lists for the till | Nov - Dec 2026 | T-401 menu (S1-S5 shipped; S6 open), tables, kitchen routing, tablet register | menu loaded for Lipa by 18 Dec |
| **S** monorepo setup (NEW) | 26 Oct - 6 Nov | `apps/pos`, `apps/customer` workspaces, per-app CI and APK build, per-app deploy (§4) | empty-shell APK installs on a tablet |
| **P0** copy, fix, harden POS | 9 Nov - 18 Dec build · 14-22 Dec soak · **11 Jan 2027 Lipa live** | v1 screens + redesigned payment/table screens; money, receipts, void, refund, SC/PWD, offline fixes; still on Firebase | 24-h soak: 0 lost, 0 doubled |
| P0 rollout | 25 Jan Malvar · 1 Feb Banay-Banay · 8 Feb Davao | `rollout-pace` = a (first store 2 weeks, then one a week) | each store 1 week clean |
| **P1** menu, staff, sign-in from ERP | Feb - Mar 2027 | PIN sign-in on a registered tablet (offline verifier), position pick (row 323), menu/tenders/discounts from ERP, Firebase staff sign-in off | per store |
| **P2** receipts into the ERP | Mar - May 2027 | receipts/payments/refunds in Postgres, server recompute-and-compare, POS till *screen* over ERP till rows (row 319), platform sales on the till, day feed + usage pull off per store | per store |
| **P3** live tables, kitchen, **Customer v2** | May - Jun 2027 | tables/KDS/diner orders on Postgres; Customer v2 live (§5); loyalty ledger; Firebase project closed 90 days after last store | per store, POS + Customer together |
| **P4** Padre Garcia + extras | Q3 2027 | franchise last (`franchise` = a); forecasting, AI hub, analysis in the ERP | all stores on v2 |

## 3. What moved since 13 October

| Change | Source | Effect on the plan |
|---|---|---|
| POS v2 and Customer v2 live **in this repo** as `apps/pos`, `apps/customer`; the APK is built per app with Capacitor | Ian 15 Oct | Setup phase S added (§4). Confirms ADR-015 §2 |
| **Live POS (build #238, commit `e26d0c1`) uses the UNSAFE void**: `src/app/receipts/page.tsx:514` flips status with a plain update, no transaction, no cash disposition. The fixed version (`components/receipts/page.tsx`, transaction + `VoidReceiptModal` + `ReRingLinkModal`) is imported by nothing | POS study §6.10, confirmed 15 Oct | v2 ports the **transactional** logic only; and the 27 Jun double-void (3,503 pesos) can recur in v1 until each store switches. Question Q4 |
| Paid receipts never change; a **wrong tender**: cashier marks it; a manager-PIN correction entry fixes it before shift close; after close it is refund + re-ring | Ian 15 Oct | Replaces v1's in-place edit (`EditReceiptDialog`) and "payment conversion" (`PaymentConvertModal`, analytics-only). One correction document; P0 |
| **One price per head** for packages (no child/senior/age tiers); v1's bundle rule kept | Ian 15 Oct | Package model stays simple; P0/P1 |
| Customer: **no pay-from-phone** in the first release; **on-page notices, no push**; feedback tied to table + receipt, manager alert on 1-2 stars, Google-review link on 4-5 stars; **consent tick at sign-up; delete members inactive 3 years** | Ian 15 Oct | Customer v2 scope fixed (§5) |
| Usage counts **approved** (read-only), not yet run | Ian 15 Oct | Task PC-0 (§6) runs now |
| Redesign payment and table screens **before** go-live (`redesign` = b, against the recommended a) | 13 Oct | P0 grows by a mock-up round; Ian reviews by 27 Nov |
| BIR: keep today's set-up (`bir` = b); POS stays an internal record | 13 Oct | X/Z readings stay as cash-control slips, not BIR; no per-tablet permit on the critical path |
| Keep today's tablets (`tablet-model` = b) | 13 Oct | Their model, Android version and memory must be counted before the soak (§7) |
| Warn the manager at ₱50,000 unsent, keep selling (`offline-cap` = b); router UPS + generators | 13 Oct | P0 offline slice |
| Keep all extras, AI is the hub (`keep-extras` = b); diner sign-up proves the phone by one SMS code, login phone + password (row 314) | 13 Oct | Counts now set build ORDER, not keep/drop |
| Till stays an ERP record, POS gets a till **screen** (row 319); one person one ID (row 322); position pick (row 323); store orders shown on the POS (row 318) | 14 Oct | P1/P2 scope; ADR-015 amendment (PC-1) |
| Ian's notes: dine-in tables should also take à la carte (v1 already allows it — AddonsPOSModal has no mode check; corrected 16 Oct from discovery 42); mark online-queue sales as "online"; reservation fee online and offline; SC/PWD ID read by local OCR | 13 Oct answers | Folded into PC-7 (table design), P3 and P1 (OCR via row 330) |
| **Still open:** business-day cut-off | — | Question Q1; blocks the Z-reading and the till screen |

## 4. Monorepo setup slice (phase S)

**What exists today:** `apps/pos`, `apps/customer` are README-only (and say port 9003/9004, which are v1's).
Root `package.json` workspaces list only `packages/*` and `apps/erp`. The root `tsconfig.json` includes
`apps/**/*.ts(x)`, so copying 107k lines of POS into `apps/pos` would put it inside the ERP's typecheck at once.

| Item | Decision |
|---|---|
| Workspaces | add `apps/pos`, `apps/customer`. Each app has its **own** `tsconfig.json`; the root tsconfig **excludes** both. Reason: root `tsc` already needed a 4 GB heap (DEF-631); POS adds ~27% more code |
| Versions | POS v1 = Next 16 + React 18 + Tailwind 3, same as `apps/erp`: copies cleanly. CUSTOMER v1 = Next 15.5 + React 19, `ignoreBuildErrors: true`: aligned **down** to the monorepo's React at P3 (ADR-015), type errors fixed, not hidden |
| Ports | POS v2 **9009**, Customer v2 **9010** (`ports` = a). READMEs corrected; global port table updated by Ian's CLAUDE.md owner |
| App boundary | `tests/unit/app-boundaries.test.ts` already covers every folder under `apps/`; add a test that each new app has its own tsconfig and is excluded from the root one |
| Android app id | **new id** for v2 (not v1's `net.shareat.pos` (`culinaryflow` is only v1's npm package name; corrected 16 Oct from `POS/capacitor.config.ts`)), so v1 stays installed beside it as the roll-back for that store. Same id would install over v1 and could wipe v1's unsent offline sales |
| Signing | one release keystore for v2, held as a GitHub secret. **Ian adds the secret** (an agent never handles it). Without it v1's workflow falls back to debug signing, and debug builds cannot update in place |
| CI | path-filtered jobs: `pos` (typecheck + web build + APK) runs only when `apps/pos/**` or `packages/**` changed; `customer` likewise; ERP job unchanged. APK uploaded as a build artifact with version code = run number |
| Deploy | `deploy.yml` stays the ERP's. POS: the APK is the release; in P0 its server routes (PayMongo webhook, PIN, crons) run as a second service on 159.223.46.224, built in CI. Customer: a third service from P3. Memory measured after each one starts (risk R6) |

**Turborepo assessment (with numbers).** Last green full CI run: **28 m 54 s**. Of that, integration tests
(real Postgres) **23 m 41 s (82%)**, unit 1 m 53 s, typecheck 55 s, ERP build 51 s, install 11 s. POS v1's APK
job takes **3.5 - 5.5 min** (runs #234-#238). Turborepo caches per-package tasks; here it could skip at most
typecheck + build of untouched apps, about **2 - 6 min** a run, and only on app-only changes. It cannot shrink the
23-minute integration step, because those tests sit at the root and exercise `packages/domain`, which every app
uses. A path filter in the existing `changes` job gives the same "affected only" for the APK at zero new tooling.
**Decision: no Turborepo now.** Use path filters. Revisit when per-app build + typecheck exceeds 5 min or a 4th
app arrives. The real lever on CI time is **sharding the integration step** (3 shards, each with its own
Postgres) - expected ~23 min to ~9 min; a separate task (PC-9), not part of S.

## 5. Customer v2 (P3) scope, as ruled

| Keep / change | Notes |
|---|---|
| Join by table QR or PIN, seat-limited | add PIN rate limit; drop the client-side `000000` admin shortcut |
| Refills and add-ons, priced by the server, bill-on-serve | cooldowns become per-store settings (DEF-021) |
| Running bill, order status | live on the page, no polling; **on-page notices only, no push** |
| Feedback | linked to **table + receipt**, one per participant (server-checked), **1-2 stars alert the manager**, **4-5 stars show the store's Google-review link** |
| Loyalty | SMS code at sign-up (row 314), phone + password, manager-only reset; **consent tick at sign-up**; **members inactive 3 years are deleted** by a scheduled job (logged as a deliberate deletion) |
| Not in first release | pay or split the bill from the phone; push alerts; diner reservations |
| Admin areas | none in the app; flash ads, games moderation, feedback, PINs in the ERP/POS (row 307) |

## 6. Next task specs to write (in order)

Numbers are given when each spec is written (408+ may be taken by other lanes). Specs are written **in plan mode**.

| # | Title | Size | Model | Depends on |
|---|---|---|---|---|
| PC-0 | Run the approved read-only usage counts (§7) against Firestore/POS archive; one dated report | S | Haiku (queries) + Sonnet (report) | none — **start now** |
| PC-1 | ADR-015 amendment: apps in this repo, Capacitor per app, new app id, ports 9009/9010, till screen not till entity (row 319), Firebase exit in steps (`firebase-exit` = a, closes row 275), BIR = keep, 11 Jan date | S | Opus (planner, docs only) | none |
| PC-2 | Monorepo setup slice (§4): workspaces, per-app tsconfig, root exclude, boundary test, path-filtered CI jobs, APK job, POS server service unit | M | Sonnet | PC-1; Ian adds keystore secret |
| PC-3 | Copy POS v1 at pinned commit `e26d0c1` into `apps/pos`: UI only, minus admin/manager areas and repair tools (row 307), minus the unimported receipts fork; builds web + APK; still on `shareat-hub-v2` | L | Sonnet | PC-2 |
| PC-7 | Redesign mock-ups: payment screen and table screen, incl. one table holding package + à la carte lines (Ian's note), one price per head, wrong-tender mark; shown to Ian | M | Opus (design) | PC-0 counts help; can start with PC-3 |
| PC-4 | Money and receipts in the copy: integer centavos (DEF-003), one never-resetting number per tablet `(store, terminal, seq)` (DEF-001/002/587), **transactional void before payment only**, refund with own number, method and original discounts (DEF-588/590), wrong-tender correction entry (manager PIN, before shift close) | L | Sonnet (money lane) | PC-3 |
| PC-5 | Offline: outbox and counter in IndexedDB (never localStorage), real reachability check (DEF-017), ₱50,000 warning, X-slip every 4 offline hours, update blocked while queue not empty, soak harness for 2 tablets | L | Sonnet | PC-4 |
| PC-6 | SC/PWD: name + ID per qualifying diner, discount on that diner's share only (study flaw I), printed on the receipt; OCR assist later (row 330) | M | Sonnet (money lane) | PC-4 |

Later, not yet: PC-8 Z-reading and day close (needs Q1) · PC-9 integration-test sharding · P1 PIN/tablet register.

## 7. Counts still needed, and why

| Count | Why it matters |
|---|---|
| Receipts per day and per peak hour, per store | sizes the soak test (~150 sales assumed) and server load |
| Offline (`OL-`) receipt share; longest outage per store | proves 24 h is enough; checks the ₱50,000 warning level |
| Voids, paid-receipt edits and payment conversions per month | sizes the correction flow Ian ruled on 15 Oct |
| SC/PWD receipts per month; tables where only some diners qualify | per-person discount design and the statutory register |
| Tablets in use: model, Android version, memory (Ian / store staff) | `tablet-model` = keep today's; must meet the app's minimum before the soak |
| Printers per store (brand, 58/80 mm, Bluetooth/USB) | hardware acceptance test |
| Grab/Foodpanda orders rung on the till (a "grab order cancel" void exists) | channel design at P2 (study finding G) |
| Reservations with deposit, chat, tips, targets, birthday song, forecast, data-analysis, games, flash ads | all kept; counts set build order |
| Loyalty: accounts, active 90 days, points owed, transfers; **members inactive 3+ years** | migration, liability, and how many the 3-year rule deletes |
| Feedback per month, rating spread; customer-app vs staff tickets; QR vs PIN joins | alert volume, Customer v2 load |
| Running bill: spend per head before vs after it was introduced (Ian asked) | evidence for the Customer v2 bill view |
| Menu size per store (items, packages, refills, flavours) | T-401 load for Lipa by 18 Dec |

## 8. Risks

| # | Risk | Plan |
|---|---|---|
| R1 | ERP crunch and P0 build overlap (Nov-Dec); Ian's review time is the bottleneck | P0 runs in its own lane; Ian's P0 asks are batched: mock-ups once (by 27 Nov), soak result once (22 Dec) |
| R2 | POS v1 keeps changing while we copy (+70 files, +8k lines in 7 weeks) | pin `e26d0c1`; freeze v1 to bug fixes (Q3); every later v1 fix listed and ported |
| R3 | Live unsafe void double-counts a sale before stores switch | Q4; v2 ports only the transactional path, with a test for two tabs voiding at once |
| R4 | Soak test fails | move storage to SQLite and repeat; second failure moves go-live to 1 Feb |
| R5 | Today's tablets too weak for a 24-h shift | count first (§7); buy only the ones that fail |
| R6 | 4 GB server runs ERP + POS server + (later) Customer | measure memory after each service starts; upsize only on a measured need |
| R7 | Business day differs between POS (to decide) and ERP (midnight today) | Q1 decides one rule for both, before PC-8 |
| R8 | Redesigned screens slow cashiers in a rush | mock-ups first; train Lipa 4-8 Jan; v1 stays installed as roll-back |
| R9 | Root typecheck or CI time blows up when apps land | per-app tsconfig + path filters (§4); sharding (PC-9) |
| R10 | Customer v1 has no consent and no retention today (PH Data Privacy Act) | fixed in Customer v2; exposure continues until P3 — noted for Ian |

## 9. Questions for Ian

**Q1 — When does a sales day end?** (still open) A sale at 1 AM: which day is it?
- (a) **Recommended:** at the store's closing time; late sales belong to the day the store opened. One night's
  sales stay together on one report. The ERP must use the same rule (it uses midnight today), so the ERP
  sales-day screen changes too.
- (b) Midnight, as the ERP does now. Simple, but a late shift is split across two days.
- (c) A fixed 5 AM for every store, like staff attendance. Simple, but ignores each store's hours.

**Q2 — First-store go-live: Monday 11 January instead of 1 January?**
- (a) **Recommended:** 11 Jan. The ERP switches on 1 Jan; one clean week first; staff trained 4-8 Jan.
- (b) 1 Jan. Two big switches on one day; a problem in either is harder to trace.

**Q3 — Freeze new features in POS v1 from early November?** Bug fixes still allowed.
- (a) **Recommended:** yes. We copy v1 once; every new v1 feature after that must be built twice.
- (b) No. Each change after the copy is re-copied by hand, and some may be missed.

**Q4 — Fix the unsafe void in live POS v1 now?** Today a receipt voided twice is subtracted twice (it happened
on 27 Jun: 3,503 pesos). The safe version is already written in v1, just not connected.
- (a) **Recommended:** yes, connect the safe version in v1 now. This project never edits v1, so this needs your
  exception and whoever builds the POS APK. Removes the risk for the next 3 months.
- (b) No, wait for v2 in each store (Lipa 11 Jan, the last store 8 Feb).

**Ian-only actions:** add the v2 APK signing key to GitHub · send each store's tablet model and printers ·
give each store's Google-review link.
