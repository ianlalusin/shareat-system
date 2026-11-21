# Go-live readiness review, as at 18 Nov 2026

Read-only review on `wt-plans` (main at 9892641, 2,564 commits). No Node, no database, no production. Method and limits are at the end.

## VERDICT: AT RISK. A full 1 Jan cutover is not on track; a narrowed one still can be, if four things happen by 4 Dec.

The code is far ahead of the rehearsal. The build is mostly done. What is missing is proof on real data and inputs only the owner can give.
1. No rehearsal of the purge and opening on a copy of production has ever run (T-394 S4/S5). The runbook still says durations `TBD`, owners `TBD`, "Signed by Ian: ____".
2. The 15 Nov go/no-go left no record in the repo (no decision, no dual-run sign-off). By ADR-005 a no-go moves cutover to 1 Apr 2027.
3. Row 452 (8 Nov) changed what "cutover" means, and nothing owns the consequences (items d and f). The wizard, purge, ADR-005 and T-119 still assume every store opens on 1 Jan.
4. POS v2 for Lipa (7 Dec) cannot sell without Lipa's menu in the ERP, and the soak has three blockers (see `2026-11-18-pos-v2-soak-readiness.md`).

Recommendation: decide the narrowed scope now (see plan, week 1). Keep 1 Jan only for books, AP, AR, payroll and expenses (org-wide) plus Lipa and the commissary. Cut or move everything else.

## 1. Status counts (approximate: by git evidence, not by reading all 473 specs)

| Bucket | Count | How decided |
|---|---|---|
| Task ids in `docs/tasks/` (T-101..T-599, sub-files merged) | 473 | file names |
| Built and merged (a non-docs commit on main names the T-number) | about 444 | `git log origin/main` subjects and bodies |
| Probably merged, no T-number in git (POS v2 trial and process tasks) | 12 | T-286, 445, 446, 447, 449, 456, 457, 458, 459, 460, 462, 463; code exists, not individually checked |
| Spec only, parked or not started (docs commits only, or none) | 12 | T-146, 206, 309, 320, 333, 363, 397, 485, 509, 313-322 stragglers, plus T-532 and T-534 which have no task file |
| Planned today, spec written, not started | 6 | T-593, 594, 595, 596, 597, 599 (uncommitted here); T-598 and T-600..603 are announced but not yet files, counted as planned |
| Open defects | not recounted | register has DEF-830..865 from the 13 Nov audit; DEF-869..893 are only in BOSS's T-593..599 specs |

Every `Status:` line in `docs/tasks/` is unreliable: many say "SPEC" or "Not built" for work that is on main (T-533 and T-551 are merged as #271 and #228). Trust git, not the status line.

### Roadmap and What's Left items (both boards are 17 to 25 Oct and wrong)
They claimed 271 done, 14 partial, 19 to build. Of the "to build" and "partial" items, since then:
- Done on main: T-190 payroll statutory (live 17 Oct), T-193 remittance (0222), T-436 leave (0205), T-390, T-391 (build), T-392, T-396 S1-S2, T-398 S1-S7, T-454, T-455 lobby, T-500, T-511 settlements S1-S8, T-523..T-531 POS v2, T-533 Lipa switch, T-550, T-551, T-564, T-581..T-592.
- Still not done: see section 2.

## 2. NOT done (id | what | size | blocks 1 Jan? | needs owner?)

| id | What | Size | Blocks 1 Jan | Owner input |
|---|---|---|---|---|
| T-394 S4/S5 | Purge and opening rehearsal on a restored production copy (13 Nov mock never evidenced; 18 Dec dress run); fill durations, owners, sign runbook | M | YES | Ian: copy, names, signature |
| New (row 452 d, f) | Opening scope per store: what v2 opens on 1 Jan for v1 stores; cash and stock accounts for v1 stores whose sales stay in v1; commissary and transfers across two ERPs; amend ADR-005, T-119, wizard | M to L (spec first) | YES | Ian: rulings |
| New | Lipa menu into ERP `/menu` (no v1 importer exists, `docs/tasks/510-menu-dayparts.md:126`); other stores' menus when each switches | M (importer) or S (hand entry) | YES for Lipa 7 Dec | Ian: who enters, by Fri 20 Nov |
| T-532 | APK shell: real Bluetooth printing for the tablet | L | Lipa go-live | Ian: tablet, printer |
| T-534 | Refund / wrong-tender correction on `/pos` (DEF-832, 855) | M | Lipa go-live | decide: cash-only or defer |
| New | Void unpaid table button; quarantine review screen (DEF-851); Receipts tab (soak steps 12, 13, 27, 28); TEST band | M | Lipa go-live | no |
| New | Pre-flight to check active `pos_terminal_links` row and an approver with `approve_pos_correction` | S | soak | no |
| New | Receipt number format: paper `T1-000123` vs server `LIP-01-000123` | S | Lipa | Ian: pick one |
| New | Deposits / reservations on `/pos` (DEF-842; Lipa takes them in v1 today) | M | Lipa go-live (or keep v1 for them) | Ian: decide |
| T-391 rollout | Staff and HR ids, Malvar and Davao master data apply (Lipa only applied 17 Oct) | S (ops) | YES | HR sheet, POS ids |
| T-396 S3/S4 | Link Malvar, Davao to POS v1 + importer (stops 31 Dec anyway, T-551) | S | no, cut | POS keys |
| T-390 S4 | Opening price list import per store | S | stock value | T-391 apply |
| T-393 | Backups switched ON in production plus one proven restore | S (ops) | YES | Ian: `systemctl is-enabled` |
| T-472 timer | Stop the nightly v1 receipt bridge (row 452 a) | S (Ian runs) | no, but stale data | Ian on server |
| T-397 | Payroll bridge fallback | n/a | not built, only if v2 payroll fails | decide by 15 Dec |
| T-593..597, T-598, T-600..603 | Money guard fixes (DEF-869..893, 904), defect sweep, others being specced; plus 3 money-wrong and 4 minor in `money-audit-part-2` (e.g. zero-value transfer line never enters branch stock) | M each | money ones YES | no |
| T-599 | Long-pages redesign | M | no, CUT | no |
| New (authz review F1-F7) | Store-scope READ gaps: `/inventory/*`, `/till`, `/remittance`, `/loans`, `/owners`, `/liabilities`, `/prepaid`, `/money-accounts`, `/trade/returns`, `/expenses` list, `/findings` readable across stores; `ROUTE_CAPABILITY` is opt-in so new pages are open (bible s7 rule 11 not true in code) | M | YES before more stores and staff are on (1 Jan adds 126 staff) | decide: deny-by-default |
| New (authz F4, F8, F9) | A manager can set a peer manager's PIN; offline POS event can name another signed-in person; `offline:true` skips the line-approval PIN | S to M | before Lipa live | no |
| New (perf 4, 5) | Indexes on `pos_sales_receipts` (store, time, day close) and `device-events`; `React.cache` on session and capabilities. Needs a migration, so before the Dec freeze | S | before Lipa live (volume) | no |
| New (perf 1-3) | Dashboard runs findings twice and aggregates the whole ledger (about 140 queries); aging CTEs scan everything. Fine while the ledger is purged and small, bites by Feb to Mar | M to L | no, CUT to Q1 | no |
| New (v1 coverage) | **Salary advance flow** (grant, per-store limits, repay ledger, void): verified missing, see below | M | YES for any advance after 1 Jan | Ian: limits (DECISIONS-LOG item 4) |
| New (v1 coverage) | Pay additions and deductions per staff (allowance, co-op, loans) | M | YES if any staff have them (payslips wrong) | Ian: count them |
| New (v1 coverage) | Print a payslip | S | YES (first pay day) | no |
| New (v1 coverage) | CSV exports for the books: journal lines, expenses, cash requests, sales days, AP/AR detail | S | accountant month-end Jan | accountant: which |
| New (v1 coverage) | Printed sales-day report; OIL weekly PDF; merge duplicate supplier; self-service PIN change; staff memo with acknowledgement (ask if still wanted); loan auto-deduct | S each, memo M | no, CUT or Jan | Ian: memo yes/no |
| New (v1 coverage, known) | All-store reports across v1 and v2 stores (row 452) | L | not for 1 Jan; monthly by hand ruled | no |
| DEF-833/851, T-561 follow-ups | Open POS defects tagged real in `/pos` | M | Lipa | no |
| T-485 | App-wide live checks | L | no, cut | Ian OK |
| T-193 loans | SSS / Pag-IBIG salary-loan deductions (unowned) | M | only if staff have loans | Ian: count them |
| Phase 7 | Activity-log viewer (T-402 S4/S5), memos, checklists, cookbook, onboarding, tutorials, T-343 remainder, T-334, T-136/T-141 | L total | no, cut | no |
| T-146, T-363, T-309, T-206, T-314 | Invoice OCR, doubtful flag, own Firebase, droplet retirement, fingerprint | various | no, cut | hardware for T-314 |

## 3. Day one table (1 Jan 2027)

Row 452 note: sales and stock per store stay in v1 until that store switches; AP, payroll, attendance, expenses, cash requests, customers/AR are org-wide in v2 from 1 Jan. Lipa runs on POS v2 from 7 Dec (go/no-go 4 Dec).

| Day-one need | Built? | Rehearsed on real data? | Owner input still owed |
|---|---|---|---|
| Opening balance sheet (cash, bank, loans, prepaid, equity, 3900 nets to zero) | Yes: `/opening-balances/balance-sheet`, T-134, T-390 S5, tie-outs | No: only synthetic and dev DB (Aug dry run); T-390 smoke left "value an asset" UNMET | Final 31 Dec balances per account; who encodes (t394-q2) |
| Opening scope per store after row 452 | NO: code posts org-wide, counts per store | No | Rulings on (d) and (f); is Malvar and Davao stock opened in v2 or not |
| Stock count load per store | Yes: count sheet, merged lines, valuation (T-390, T-591 B) | No | 31 Dec count by store; cost basis (last v1 delivery price, ruled); default room per store |
| Fixed assets (52 v1 docs) | Opening value + register shells yes; no bulk asset import | No | 31 Dec asset walk; final v1 depreciation run; asset list |
| Staff and pay rates (126 staff) | Yes: T-391 S5 staff plan, pay rates append-only | Lipa only | HR sheet: SSS, PhilHealth, Pag-IBIG, TIN for 126 staff (due 31 Oct, no evidence received) |
| Statutory rates | Seeded 2026-01-01, all `confirmed_at = null`; POST refused until confirmed | No | Accountant confirms rates, incl. what applies from 1 Jan 2027; minimum wage per store; Q5 VAT (due 13 Nov) |
| Payroll first run | Yes: T-189, T-190, T-191, T-193, T-436. Missing: payslip print, per-staff additions/deductions, salary advance grant | NO parallel run vs v1 payslips found | Pay dates; confirmation above; list of allowances, co-op and loan deductions; advance limits; decide v2 vs T-397 fallback by 15 Dec |
| AP open bills | Yes: opening party balances (step C3P) | No | v1 aged supplier lists per store, 31 Dec |
| Customer balances / AR | Yes: parties plan, AR | No | v1 aged AR list; wholesale customer list |
| Bank and e-wallet accounts | Yes: money accounts; Lipa setup load (T-533 S2) | Lipa setup only | Account list, tenders per store (Cash, GCash, Maya, card), payout samples for Grab/Foodpanda parsers |
| Fiscal periods open | Yes: seeded Oct 2026 to Sep 2027, monthly timer | Pre-flight checks it | none |
| Backups + restore proven | Built (T-393 S1/S2, weekly drill) | Not evidenced; go/no-go line "restore test dated ___" blank | Ian confirms timers enabled on 159.223.46.224; bucket and retention choice (plan-q7) |
| User accounts and roles | Yes, but store-scope READ gaps (authz F1-F7) and a manager can reset a peer manager's PIN (F4) | Lipa only | Roster of staff per store; who holds `approve_pos_correction`, verify and post; ruling: deny-by-default for pages |
| Month-end exports for the accountant | Only 8 summary reports have CSV; ledger lines, expenses, sales days, AP/AR detail do not | No | Accountant: which exports are needed on day one |
| Store settings and business rules | Yes: T-515/564 settings, T-512 rules, T-587 | Lipa partly | Rules saved (not defaults): VAT, senior/PWD, day start hour, table warn, tolerance, PIN on line actions |
| POS menu for Lipa (new, from soak review) | ERP `/menu` exists; NO importer | No | Items, packages per head, refills, flavours, stations, lunch/dinner windows entered by Fri 20 Nov |
| Lipa POS v2 live 7 Dec | Mostly (T-523..533) | Soak 21 or 28 Nov, 24 h two-tablet soak, go/no-go 4 Dec | Soak date, tablet, printer, go decision |
| Purge of 2026 pilot data | Yes: T-119, T-347, T-394 S1-S2 | Dev DB dry run only | Typed by Ian with admin string; named dump folder owner |
| v1 day import stops, bridge timer off | Yes (T-551 #228); timer is Ian's server step | n/a | Ian runs `systemctl` per row 452 (a) |

### Salary advance: verified, the gap is real (answering BOSS)

Two sources suggested staff advances exist. Evidence says only half exists.
- EXISTS, recovery: payroll nets the whole `1230` balance each run (`packages/domain/src/payroll/index.ts:573` `outstandingAdvance`; `docs/tasks/519-staff-deduction-agreements.md:9`). `1230` is posted only by shortages (`cash-requests/index.ts:487`), till and transit shortages, order-wastage charges, and moving an owner receivable (`owners/index.ts:459-510`).
- MISSING, grant: nothing creates an advance a person asked for. A cash request releases to `1120` staff float for spending (`cash-requests/index.ts:5-9`); T-519 states "Requested advances post to 1120 ... untouched" and lists "Requested cash advances (1120, choice b)" out of scope (`519...md:12,57`). Order-wastage charges to staff are still gated off (`wastage/orders.ts:65`, flag literal `false`).
- DECISION without a build: `settings-audit/DECISIONS-LOG.md` item 4 (Ian, 3 Nov): "enforce as v1" with per-store limits (per record, per day, balance per staff, allowed weekdays). Grep of `packages/db/schema` and `apps/erp/src` finds no limit table, setting, screen or task. v1 has the screen and 635 Lipa documents (5 Sep capture, per the coverage review).
- So: DEF-813 and item 4 mean the rule is decided, not that the flow exists. Sized M; it needs migration, screen, capability, audit (row "no hard-coded business settings").

## 4. Capability gaps (`docs/CAPABILITY-GAPS.md`, last real audit Aug to Oct)

The file is stale: section 1 (5 ledger modules) shipped; most of section 2 shipped (commissary pipeline, usage pull then retired, staff master, store provisioning, settings screens, budgets, leave, 13th month, separation).
- Matter before 1 Jan: (1) salary advance flow and per-staff pay additions/deductions (v1 coverage review); (2) reimbursement payout screen (`/expenses/reimbursements` exists per the coverage review, so likely closed; confirm); (3) SSS/Pag-IBIG salary-loan deductions if any staff have them; (4) the row 452 split gap: combined v1 and v2 view (monthly by hand, ruled); (5) payslip print and book exports; (6) supplier vouchers only if any recur (2 rows ever).
- v1 coverage review totals (104 rows): 52 covered, 20 differently, 6 partly, 16 missing, 10 dropped. Most "missing" are Phase 7 and stay in v1 (row 302): infractions, checklists, performance, onboarding, cookbook, notifications.
- Can wait: staff schedules, subtractive position defaults, AI brief, OIL engine, notifications, memos, checklists, infractions, cookbook, onboarding, kiosk shell, danger-zone tooling.
- Needs a verdict, not a build: wastage reasons as a constant.

## 5. Risks, ranked

1. **Scope drift after row 452.** `CONVERSION_DATE` is a single org-wide 2027-01-01 and the opening is per org. Malvar and Davao sales and stock stay in v1, yet their expenses, payroll and AP post in v2: their cash and inventory accounts in v2 will not tie, and no one has said how the trial balance reads. Docs promise "every store opens on v2" (ADR-005, remaining-build-plan, ROADMAP).
2. **Rehearsal never done on real data.** Everything destructive (purge, opening POST, rollback via predump) is proved only on synthetic and dev data. First true run would be on 1 Jan. Single person (Ian) types purge and POST; "second phone" and mirror-reset owner (DEF-643) unowned.
3. **Payroll with no real staff data.** 0 of 126 had statutory ids at last record; rates unconfirmed; no parallel run against v1 payslips. People are paid from it on the first payday.
4. **Lipa live 7 Dec with an unproven menu, printer path and approval link.** Chrome soak cannot test Bluetooth; refunds, deposits, void table, quarantine review are missing; TEST mode is invisible on screen; real senior/PWD ids typed in the soak leak into the register until the purge.
5. **Single points of failure.** Ian (every owner step, merge login); one production droplet 159.223.46.224 with 4 GB RAM and no build allowed; one live tablet per store; one Firebase project shared with v1; backups armed state not known from the repo; `/srv` group-write lost twice (DEF-655).
6. **Docs the code does not honour.** Roadmap and What's Left (stale, 25 Oct and earlier); runbook "durations TBD"; `pos2-runbook.md` and `pos2-soak.md` describe frozen `apps/pos`; soak dates disagree (row 457: #1 on 28 Nov; runbook: #1 on 21 Nov); row 473 is cited in the brief but main's bible ends at 463; task Status lines.
7. **Money guards still open** (DEF-869..893 and 904, T-593..597 specced not built; 3 more money-wrong in `money-audit-part-2`) and 13 Nov rows DEF-830..865 unrecounted.
8. **Store-scope read leaks and a PIN-reset privilege hole** (authz F1-F7, F4): org isolation is strong, store isolation on reads is weak; page gates are opt-in. Matters more once 126 staff and 5 stores are on.
9. **Performance cliff after the first months** (perf 1-3): dashboard about 140 queries, whole-ledger aggregates, 3-second POS polling (about 27 transactions a second at 40 devices). Not a 1 Jan blocker because the ledger is purged; the POS receipt indexes (perf 4) are, via a migration.
10. **Laptop and CI limits:** 5 node.exe cap, one builder at a time, full suites only in CI; a late migration (0262 next) risks the freeze.

## 6. Plan, 18 Nov to 1 Jan (priority order; CUT marks what to drop first)

**Week 1, 18 to 24 Nov: decide and unblock**
- Owner: rule row 452 (d) and (f) (recommend: v2 opens org-wide money items plus Lipa and commissary stock only; v1 stores open at their switch date). Confirm who loads Lipa's menu by Fri 20 Nov. Record the 15 Nov go/no-go result (even "deferred").
- Build: pre-flight checks link and approver; Receipts tab or rewritten soak steps; TEST band; PIN-on-line-actions on for Lipa; authz F4 (peer PIN reset, S). Specs: row 452 scope task, menu importer decision, salary advance (T-6xx), store-scope read gate sweep (F1-F7, deny-by-default).
- Ops: confirm backups timers on and run one restore; stop the bridge timer; check Lipa link at `/admin/pos-tablets`.
- Rehearse: soak #1 at Lipa (21 or 28 Nov, fix the date).
- Owner supplies: HR sheet, accountant rates confirmation, Q5 VAT.

**Week 2, 25 Nov to 1 Dec**
- Build: quarantine screen, void table, receipt number format, T-593 to T-597 money fixes (one builder at a time); payslip print (S); `pos_sales_receipts` indexes migration (perf 4) before the freeze.
- Rehearse: T-394 S4 now (the real rehearsal on a restored production copy), with Ian and one encoder; time every step; fill the runbook.
- Owner supplies: Malvar and Davao POS ids, staff roster, tenders, payout samples; decide refunds (T-534) and deposits.
- CUT: T-599, T-485, Phase 7, T-343 remainder.

**Week 3, 2 to 8 Dec: Lipa**
- Soak #2 if needed by Wed 2 Dec; go/no-go Fri 4 Dec; Lipa live Mon 7 Dec if both gates pass. Else slip Lipa and keep 1 Jan books-only.
- Payroll: run a parallel payroll against v1 for the November period (preview only).
- Build only fixes found by soak. Freeze new migrations after this week.

**Week 4, 9 to 15 Dec: freeze and data**
- Load Lipa and other stores' master data (T-391 apply). Final decision on payroll path (v2 or T-397 bridge) by 15 Dec. Fix remaining money guards. Update ADR-005, T-119, wizard for row 452. Build salary advance (M) and per-staff pay additions/deductions (M) only if Ian confirms staff use them; otherwise Jan, with advances handled by hand on 1230. Store-scope read gates (F1-F7) one PR per group. CSV exports for the books (S).
- Owner supplies: aged AP and AR lists format check, asset list, count sheets printed.

**Week 5, 16 to 22 Dec: dress rehearsal**
- 18 Dec: full dress rehearsal of purge, opening, verify, rollback-check on a fresh copy; runbook frozen and signed. Backup restore proven again. Cutover go/no-go by 22 Dec (with the narrowed-scope fallback written down).
- CUT: T-396 S3/S4 (importer stops 31 Dec anyway), T-532 if printing is acceptable via browser dialog in the short term; perf 1-3 (to Q1); printed sales-day report, OIL PDF, merge supplier, self-PIN change, memo, loan auto-deduct (Jan).

**Week 6, 23 to 31 Dec: count and close**
- 31 Dec: stock count, asset walk, final v1 depreciation, cash and bank reconciliations, aged lists from v1, export figures (steps C1 to C5 in `packages/domain/src/cutover/steps.ts`). Lipa December bridge to v1 runs until 31 Dec only.
- Owner: all counts and signatures. No code merges after 28 Dec.

**1 to 2 Jan:** purge (typed by Ian), opening POST, `verify --after-post`, trial balance ties, smoke payroll preview, sales day, backups on. Rollback = predump restore. If any gate fails: no-go, 1 Apr.

## 7. Owner owes

Rulings: row 452 (d) and (f); 15 Nov go/no-go outcome; refunds and deposits for Lipa; receipt number format; payroll path by 15 Dec; salary advance limits and whether staff use advances and memos; deny-by-default pages. Data: HR sheet (126 staff); list of allowances, co-op and loan deductions; aged AP and AR; asset list; tenders and payout samples; Malvar and Davao POS ids; Lipa menu. Actions only Ian can do: backup and bridge timers on the server, rehearsal copy and signature, soak and 4 Dec decision, accountant confirms statutory rates and VAT (Q5).

## 8. Stale docs to correct

`docs/ROADMAP.html` and `docs/WHATS-LEFT.html` (25 and 17 Oct); `docs/HANDOFF-TODAY.md` (25 Oct, says main ef1b3b0); task `Status:` lines (T-533, T-551, T-193, T-190, T-398 and 60 more); `docs/CAPABILITY-GAPS.md` section 2; `docs/ops/cutover-runbook.md` (TBD cells, §0.2 owners); `docs/ops/pos2-runbook.md` and `pos2-soak.md` (frozen app); `docs/runbooks/pos-soak-plan.md` and `pos-staff-sheet.md` (Receipts tab and Unsent sales do not exist); `docs/plans/remaining-build-plan.md` (pre row 452, pre POS v2 pivot); ADR-005 and `docs/plans/pos-customer-v2-phase-plan.md` (row 452); bible row 457 vs `pos-go-no-go.md` soak dates; `docs/RULES.md` (216 decisions; bible is at 463).

## Method and limits

Counts come from `git log origin/main` (subjects and bodies) matched to `docs/tasks/` ids; I did not read all 473 specs. Production state (timers, menu, links, data) cannot be seen from code and is marked unverified. `C:\Users\ianla\webapps\ERP-rebuild` exists on this machine; I did not need to open it. Ian's brief said row 473 exists; main's bible ends at row 463, so rows 464 to 473 are on an unmerged branch or not written. Read also: `shareat-coord\BOARD.md` and the 18 Nov reviews: pos-v2-soak-readiness, v1-coverage-review, authz-tenant-review, performance-review, money-audit-part-2 (summarised, not re-verified except the salary advance claim). `settings-audit/DECISIONS-LOG.md` is in the main checkout, not in `wt-plans`.
