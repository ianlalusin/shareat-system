# Phase 6 — Reporting, dashboards, and the lapse-detection loop

> Written 2026-09-04. **Fed by `docs/discovery/26-reporting-dashboards-and-insights.md`** — three
> read-only passes over `ERP-rebuild` and `POS`, every claim cross-checked against live production
> Firestore with a `.get()`/`.count()`-only probe. §3.6 is satisfied by that pass; this plan
> synthesises it and does not re-derive it.

| | |
|---|---|
| **Status** | Planned 2026-09-04 (Opus planner) |
| **Governed by** | `PROJECT_BIBLE.md` §10 (Phase 6), **§4.2 rule 7** (line 626 — derived data is a view, never a maintained summary row), §16.3 (line 1575), §13 rows 83 and 163 |
| **Research** | `docs/discovery/26-reporting-dashboards-and-insights.md` — cited by section throughout |
| **Extends** | `docs/tasks/110-reporting-views-and-screens.md` (the no-maintained-summary-row rule, established for the ledger) and `docs/tasks/135-integrity-findings.md` (the findings engine — already built) |
| **Prerequisite** | Phase 2 (T-123 sales day), Phase 3 (stock ledger, commissary pipeline), Phase 5 (pay runs) for the detectors that read their data. The statement work needs only Phase 1 |
| **Exit gate** (bible §10) | *Statements tie; report figures reconcile for the same date range* |
| **In the January cutover?** | **Partly, and ADR-005 already names exactly which part**: *"Trial balance · P&L · balance sheet · AR and AP aging. Enough to **run** the books, not the full dashboard suite."* That is Wave 1 (§7) — trial balance and P&L already shipped in T-110, so the January-critical remainder is **the balance sheet and the two aging reports** |

---

## 1. ⛔ The discovery that reframes this phase

The v1 features in this area that got the **most** engineering investment are the ones with the
**least** measured use — and every one of them is either AI-shaped or incremental-counter-shaped.
The features with real, daily, unprompted use are plain, boring, deterministic SQL-shaped work.

| v1 capability | Engineering invested | Measured use, ever, across 7 live stores |
|---|---|---|
| **Sales report / sales day** | Large — 1,028 + 797 + 389 lines of actions | ⭐ **348 real documents, 5 stores** — the one proven core (§A.1) |
| **OIL — deterministic lapse detection** | Moderate, zero AI cost | ⭐ **441 findings resolved by managers** at the two engaged stores (§C.2) |
| **Shift Report** | A dedicated POS-baseline netting algorithm, its own projection writer, a shipped crash fix | ⛔ **Zero documents. Ever. At any store, including TEST's own QA fixtures** (§A.2) |
| **Manager Daily Review** | 356 lines, 8 auto-computed sections | ⛔ **1 document**, on its ship date (§A.3) |
| **Manager Daily Report** | 314 lines, admin-configurable recurring questions | ⛔ **2 documents**, both left `draft`, never submitted (§A.3) |
| **Task Inbox** | 211 lines, self-resolution guard, progress-note thread | ⛔ **4 documents**, all in the 3-day ship window, `updates: 0` on every one (§A.3) |
| **AI narrative briefing** (8 sections + Top-of-Mind + 5-provider hub) | The most complex subsystem in v1 | 240/240 store-days generated — and **Padre Garcia opened it 0 times in 88 days**, Davao 5 times (§C.2) |
| **Ask ERP** | 5-provider chat, tool-calling, prompt-injection-hardened schemas | ⛔ **13 calls ever**, all inside one 8-day window, none in the 9 days since (§C.2) |

### 1.1 And every hand-maintained counter in the area has drifted, in production, right now

Three independent confirmations of the **same** disease:

1. **`dashboardSummary/live`** (ERP) needed a dedicated **6-task hardening pass** just to make its
   own drift *visible* — failure-visibility retrofitted onto 15 of 16 `FieldValue.increment` sites
   that silently swallowed write failures, honesty-labelling for a trio of tiles that looked live
   and were rebuild-only, integrity coverage widened from 2 of 7 fields, 5 open realtime listeners
   killed including one **fully unbounded** query, and a staleness indicator that did not exist
   (§B.2). **Five separate fixes for one design choice.** And it is *still* wrong: SharEat Padre
   Garcia's summary was **123.7 hours stale** at probe time, because self-heal only fires when a
   human opens the page and nobody has (§B.2).
2. **POS's `dashPresets`** rolling-window tiles inflate **3×–11×** on "This Month" until a nightly
   cron corrects them, because the live delta path can only ever **add** a receipt's contribution to
   a window and never subtract one once the day ages out (§D).
3. **The ledger already taught us this.** `docs/tasks/110-reporting-views-and-screens.md` found
   **34 of 115 v1 account balances disagreeing with v1's own maintained counters.**

> ⭐ **Three domains, three teams, three eras, one failure mode.** The dashboard layer is not a new
> instance of the problem — it is the *third independent confirmation* that a maintained counter in
> this business drifts, silently, while looking authoritative.

---

## 2. ⭐ The Phase 6 invariant, stated once and enforced structurally

> **No dashboard tile, KPI, or report figure in Shareat System is ever a hand-maintained counter.**
>
> There is no `FieldValue.increment`-shaped table, no additive-only rolling window, no
> write-path-updated cache. **Every figure is a live SQL query over fact rows.** Where a specific
> query is *proven* too slow — measured, not feared — the fallback is a **materialized view
> refreshed inside the same transaction as its source write** (bible §4.2 rule 7), never a counter
> updated by application code.

**Why this is affordable here and was not there.** v1's counters exist because Firestore bills per
document read, so a 500-document `GROUP BY` is a line item on an invoice — the counter is a *cost*
optimisation that bought drift. Postgres bills nothing per row: an index scan over `journal_lines`
for one store-month is sub-millisecond, and it is cache-friendly in a way a per-store summary
document never was. **The economic reason for the counter is gone; only its failure mode would
survive the port.** Live volumes make this concrete — 14–127 `salesDays` documents per store and
2–12 `expenseSummaryMonthDays` per store (§B.5). The whole fleet's reporting corpus is smaller than
one uninteresting table.

### 2.1 One query per figure — because v1's other reporting defect was duplication

v1 enforces verified-only revenue recognition in **three separate readers** (income statement,
dashboard, month roll-up) with a source comment saying *"keep them in sync if you add a 4th"*
(T-123 §4.1). **A rule enforced in three places is a rule that will one day be enforced in two.**

So the exit gate — *"report figures reconcile for the same date range"* — is met **by construction,
not by comparison**: a dashboard tile and a statement line that mean the same thing call the **same
named query function**. A tile never re-derives a figure a statement already computes. This is the
testable form of the gate, and §9 item 3 states it as an assertion.

### 2.2 Two disciplines carried forward verbatim from v1, because v1 got these right

| Discipline | Where v1 does it | The rule here |
|---|---|---|
| **Never cap a money figure without a visible incompleteness flag** | The Cash/Online balance tiles `limit(500)`, detect hitting exactly 500, and render an amber *"this may be a floor, not the real figure"* banner (§B.1) | Any figure computed under a `LIMIT` says so on the screen. A truncated total that looks total is worse than no total |
| **When a figure cannot cheaply stay live, label its true age** | The AP trio is explicitly labelled *"as of `<rebuiltAt>`"* rather than presented as live (§B.1) | A materialized view renders its `refreshed_at`. Precision that is not there is never implied |

---

## 3. ⭐ What this phase must and must not do

| Verdict | Why |
|---|---|
| ✅ **Finish the statement set and make the dashboard exist at all** | `apps/erp/src/app/` has `/reports` (trial balance, income statement) and **no dashboard route**. T-110 explicitly left balance sheet, cash flow, drill-down and per-store comparison out. This is the phase that owns them, and the exit gate is written against them |
| ✅ **Build OIL's operational half and the scorecard** | **441 resolved findings** at two stores (§C.2) — the strongest usage evidence in the entire discovery pass. And **T-135 already shipped the engine**: 22 detector kinds, derived-not-stored, acknowledgement with a 30-day expiry, a `/findings` screen. §5 sizes what actually remains |
| ⛔ **Do NOT port any incremental summary mechanism** | §1.1, §2. `dashboardSummary/live`'s four source queries run 9–156 documents each — **cheap enough to just run live**, which is what makes the increment path pure cost with no benefit (§B.1) |
| ⛔ **Do NOT port Shift Report** | Zero documents, ever, anywhere (§A.2). §4.2 |
| ⛔ **Do NOT rebuild the three manager-daily surfaces** | 1 / 2 / 4 documents ever, clustering on ship dates (§A.3). **This one is Ian's to confirm, not mine to close** — §4.3 |
| ⛔ **Do NOT port the AI narrative briefing in this phase** | §4.5 — and the sequencing argument matters more than the adoption one |
| ⛔ **Do NOT port Ask ERP** | 13 calls ever, ~5–8 engineer-days to port (§C.3). §4.6 |
| ⚠️ **Do NOT silently absorb POS's restaurant-operations KPIs — and do not silently leave them either** | Avg spend, peak hour and sales-by-time-of-day live **entirely in POS**; a full-repo grep of ERP-rebuild returns zero matches for any of them (§D). Ownership is a cross-app decision. §6 |

---

## 4. The capability-by-capability decisions

Each of these is a **decision with a stated reason**, per bible §13 row 163 — *assess before you
plan, say the number not the adjective, recommending against is sanctioned and therefore expected.*

### 4.1 ✅ Sales reporting — and Phase 2 already owns more of it than the roadmap line implies

**What Phase 2 owns and Phase 6 must not rebuild:** the sales-day document lifecycle, the
sequential-verification create-block and its three load-bearing carve-outs, the adjustment path,
the posting (T-123, `docs/plans/phase-2-source-documents.md` Wave 1).

⭐ **And the recognition-status filter is already dissolved — Phase 6 does not port it.** v1 needs
`RECOGNIZED_SALES_STATUSES` because its P&L reads `Σ salesDays.totalSales`, so a report's *status*
has to be re-checked by every reader (§A.1, T-123 §4.1, §5). **In v2, verification is what posts.**
Unverified revenue is not filtered out of a query — it is not in the ledger at all. There is no
status set to keep in sync, no fourth reader to remember. ⚠️ **This is the obvious thing to port by
reflex** — a "recognised sales" filter reads like a reporting rule and is really a workaround for a
missing ledger. It is written down as *deliberately absent* so nobody adds it back as a helpful
convenience.

**What is genuinely left for Phase 6** — T-209 and T-210:

1. **The period roll-ups** — sales by day / month / store / channel / sales-mode, as `GROUP BY`
   queries over `journal_lines`, which is the *only* place they can now come from.
2. **The sales-day register** — an operational list of which business days exist and which have
   posted, per store. This is the surface that makes an unrecognised day *visible*; it is also the
   source of the `salesDayUnposted` detector in §5.
3. **The POS-day ↔ ledger reconciliation** — `docs/CROSS-APP-MAP.md` §1 makes the POS analytics day
   document a **source document with known semantics, not raw truth**. A reporting phase that never
   shows the two side by side leaves that reconciliation to goodwill.

⚠️ **One recognition-timing rule to make explicit rather than inherit** (§A.1, last row): a
commissary branch sale posts AR and its journal immediately, but its **revenue is deferred from the
P&L until a human clicks Create + Verify for that day.** In v1 this is an emergent side-effect of a
UI-discipline commit, not a named rule. ⚠️ **It is Phase 2/3 boundary work, not Phase 6's to
decide** — discovery 26 §A.1 already flags it for Ian, and it is repeated here only because a
roll-up built over it would quietly bury it. Phase 6's job is to render the deferral, never to
smooth it.

### 4.2 ⛔ Shift Report — recommendation ADOPTED, do not port

`stores/{s}/cashRemits` and every `.../shifts` subcollection are **empty at all 7 stores, including
TEST** — zero documents, ever, including from QA's own smoke tests (§A.2). Against that: a bespoke
POS-baseline netting algorithm, a dedicated month-index projection writer, and a shipped crash fix.

⭐ **And the half of it that actually mattered is already being built elsewhere, which is why this
is a clean "no" rather than a reluctant one.** The business reason to have a shift boundary is
attributing a till variance to **one of two cashiers on a shared till** — `docs/CAPABILITY-GAPS.md`
line 256 names exactly that, and **T-186 (`till-custody-shift`) owns it**. `findings.ts` already
ships `tillCountVarianceOpen` and `openShiftsStale`. So Phase 6 declines the **parallel shift-level
reporting surface**, not the custody control. Nothing is lost.

### 4.3 ⚠️ The three manager-daily surfaces — NOT built, and this is Ian's call to close

**The finding, plainly:** across all 7 stores and roughly four months, Manager Daily Review has
**1** document (Lipa, on its exact ship date), Manager Daily Report has **2** (both left `draft`,
never submitted), and Task Inbox has **4** (all inside the 3-day ship window, `updates: 0` on every
single one — the flagship "log progress" feature has never been used once) (§A.3).

**`docs/CAPABILITY-GAPS.md` already deferred this**, at line 168–173: the three sit in
*"nice-to-have → deferred past cutover"*, annotated *"Consolidate, do not triple-port… One
survives; Ian picks which."* The live data does not contradict that call — it **sharpens the
question it left open.** The open question was never *which shape wins the merge*; on this
evidence it is **whether the ritual has been adopted at all.**

> ⛔ **Phase 6 does not build any of the three, and does not schedule a fourth attempt at the same
> shape.** Per bible §13 row 163, that is a recommendation stated once and plainly — and per §1.2,
> *removing a capability someone uses is Ian's call, never Claude's*, so this stands as a
> **recommendation awaiting confirmation**, not a deletion.

⭐ **And there is a reason to think the underlying need is already met, from a different direction.**
Strip the prose off the ritual and what remains is *"a manager looks at what is outstanding for
their store and accounts for it."* **That is `/findings`** — T-135's feed, with severity ordering,
an acknowledgement that expires in 30 days, a visible acknowledgement *age*, and no "resolve"
button so a finding can only leave by its condition becoming false. It already exists, it is
already better-designed than any of the three (v1 stores a `resolved` flag that outlives the
condition — T-135 §"the one gap"), and §5's scorecard closes the accountability loop it is missing.

**If Ian says the prose-and-signoff ritual IS wanted, here is the smallest version, pre-scoped so
that answer needs no second planning pass** (~3–4 engineer-days):

| | |
|---|---|
| **Shape** | **Task Inbox + Daily Report on one page** — the only shape showing any sign of a manager returning unprompted (2 reports, 6 days apart, 10 recurring answers filled each time), and the two v1 already unified onto one route |
| ⛔ **Not** the Daily Review shape | An auto-aggregated 8-section feed duplicating pages that already exist, drawing sign-offs from nobody — and in v2 those 8 sections **are** `/findings` plus the dashboard |
| **One table, not two** | v1 renders them on one page and writes two collections through two action files. One `manager_day_notes` table, `(store_id, business_date)` unique |
| **Ports verbatim** | The self-resolution guard (a raiser cannot close their own task unless admin) and *"In Progress" is DERIVED* (`pending && updates.length > 0`), never a fourth stored status (§A.3) |
| ⚠️ **Probable better home** | **Phase 7**, beside memos and checklists — the same "recurring operational discipline" family. It is not a reporting capability, and it is here only because the discovery pass found it |

### 4.4 ✅ OIL — BUILD, and it is much cheaper than the discovery estimate

Adopted from §C.4, with one correction in our favour. §C.3 sizes a native OIL build at **~4–6
engineer-days** — *13 detectors as SQL, a persisted daily-slice table, snooze/resolve/rescan, the
scorecard aggregation.* **Three of those four already exist.** T-135 shipped:

- **22 detector kinds** in `packages/db/src/repo/findings.ts` (1,120 lines) — already more than
  v1's 13, spanning ledger integrity, remittance, till, credit ageing, stock and POS-pull;
- ⭐ **the derived model that fixes v1's worst OIL defect** — the finding is recomputed, only the
  **acknowledgement** is stored, so *a finding cannot be "resolved" while it is still true*. v1's
  stored `resolved` flag suppresses the symptom and the suppression looks more confident the longer
  it lasts (T-135 §"the one gap");
- **no daily-slice table at all** — v1 writes an `oilDays` document per store per day; v2 computes
  on read, which is §2's rule applied to detection;
- **the `/findings` screen** — severity-ordered, acknowledgement age in days, close-readiness for
  the period, and deliberately **no resolve button**.

**So the remaining work is ~3–5 engineer-days, and carries no design risk** — the risky half
(derived-vs-stored semantics, the acknowledgement lifecycle, the surface) is shipped and proven.
What is left is detectors whose **data did not exist when T-135 was written** and now does, plus
the scorecard, which nothing owns. §5 details both.

⚠️ **`CAPABILITY-GAPS.md` classifies OIL under *"nice-to-have AI, deferred past cutover"* and that
is wrong on both halves** — it is not AI (v1's own `types/integrity.ts:1-3`: *"**Deterministic**
integrity findings… pure observation layer — never touches the GL"*), and it is the best-evidenced
capability in the whole discovery pass. Flagged per bible §13 row 164 and recorded in an **appended**
section of that file rather than by editing its existing classification table.

### 4.5 ⏸️ The AI narrative briefing layer — DEFERRED past Phase 6

§C.4's deferral is adopted, and the sequencing argument is stronger than the adoption one.

**The adoption argument** (§C.2): generation is flawless — 240/240 possible store-days over 60 days
across all 4 enrolled stores. **Reading is not**: Lipa 76 opens, Malvar 84, Davao **5**, Padre
Garcia **0** — zero, across 88 days of faithfully generated briefings. Half the enrolled fleet does
not read it. Cost is a non-argument in either direction: **₱45.81 measured over 60 days across 4
stores**, annualising to ~₱280/year now and ~₱500/year at all 7 (§C.2). The case against is **5–7
engineer-days for a thin single-provider port, 15–20 for a faithful multi-provider one** (§C.3) —
never the peso cost.

⭐ **But the decisive argument is order of construction, and it makes deferring strictly cheaper
rather than merely later.** v1's briefing is expensive largely because of its **8-module signal
extraction layer** — sales deltas against a 4-week baseline, OIL findings, checklist completion,
food-cost ratio — which exists to assemble numbers Firestore could not aggregate. **Phase 6's
entire job is to produce exactly those numbers as named SQL queries.** Build the briefing now and
you build the extraction layer twice; build it after Phase 6 and it is *"call one model with
numbers the dashboard already computed"* — roughly a day, not five to seven.

**Two v1 designs to preserve for whoever builds it later**, both genuinely good: the **per-store
master AI kill switch** with per-section gating (3 of 7 stores currently have it off), and the
**local non-AI short-circuit** that skips the model call entirely when a section has no signal —
measured at no customer feedback on 89% of days (§C.1). ⛔ **Do not port the 5-provider hub**
(§C.1): it is the most provider-quirk-laden code in v1, for a feature 2 stores read.

### 4.6 ⛔ Ask ERP — NOT ported

**13 calls, ever**, across a 7-store system in ~4 months, all inside a single 8-day window
(2026-08-19 → 2026-08-26), only 3 of 7 stores, **zero in the 9 days since** (§C.2). Against ~5–8
engineer-days to port (§C.3). This is the textbook *"tested at rollout, then abandoned"* shape this
project explicitly watches for, and the number is not ambiguous enough to need judgement.

**The observed demand is 13 questions in four months, and a searchable static help page satisfies
it** at a fraction of the cost, with no tokens, no provider, and no prompt-injection surface (§C.3).
⚠️ **It is not a Phase 6 slice either** — a help page belongs with **Phase 7's** admin/onboarding
surfaces. Named here so it is a placement rather than an absence.

> ⭐ One thing worth harvesting even though the feature is not ported: v1's manual-retrieval fix.
> The full ~18,600-token manual **was** inlined on every call (~₱0.32/question, 55% over Groq's
> 12k TPM cap) before being replaced by a compact section-title index plus an on-demand
> `searchManual` tool capped at 3 sections / 12,000 chars (§C.1). **If an LLM ever reads a document
> in this system, that is the shape.**

---

## 5. What an OIL detector looks like as a Postgres query

Not a Firestore integrity sweep writing a daily slice — **an exported function returning rows**,
run on read, exactly as T-135's 22 already are:

```ts
// packages/db/src/repo/findings.ts — the established shape, not a new one
export async function <name>(tx: Tx, orgId: string): Promise<DetectedFinding[]>
//   → { kind, key, severity: 'hard' | 'soft', amount?, storeId?, drillTo }
```

**One SQL statement per detector. No sweep, no cron, no slice table, no stored state** — the only
thing persisted is an acknowledgement, and it expires in 30 days. A detector "clears" when its
query stops returning the row, which is §2's rule applied to accountability.

**The kinds Phases 2–5 have now made computable** — not an exhaustive design, the pattern plus the
cases that matter (T-213):

| Detector | The query, in one line | Why it is *easier* here than in v1 |
|---|---|---|
| `salesDayUnposted` | A business day with POS activity and no posted `source_type='sale'` entry, older than N days | v1 needs a status filter over a mirror collection; here the ledger's silence **is** the finding (§4.1) |
| `expenseMissingCategory` | `expenses` with no category, above the materiality threshold | v1 already gets materiality right (`orphanExpenseMaterialityPesos`) — port the threshold, not the sweep |
| `orphanExpense` | An approved expense with no linked `supplier_invoice` / delivery | Reads T-130's real FK instead of v1's hand-set flags |
| ⭐ `receiptPriceSpike` | A receipt line whose unit cost exceeds the trailing-N-receipt median for that item by X% — **one window function** | ⭐ **The clearest case for the platform.** v1 must read the history into the app and reduce it there, which is why it needs a baseline to be maintained. In Postgres it is `percentile_cont(...) OVER (PARTITION BY item_id ...)` in the same statement — **no baseline exists to drift** |
| `newVendorFirstPurchase` | A supplier's first receipt inside the window | A `NOT EXISTS` over prior receipts |
| `advanceUnliquidated` | A `1230` party balance open past N days | Partly shipped as `cashRequestFloatAgeing`; extend, do not duplicate |
| `usageRecordMissing` | A store-day with posted sales and no usage record, department-aware | Complements the shipped `posUsagePullNotRun` |
| `meatSlabStale` | An open FIFO layer for a `meat_slab` item older than N days | T-162's layers make this a join; v1 has no layer to age |

**Thresholds are per-store, and a missing or invalid config falls back to the code default and can
never disable detection** — v1's rule, already an invariant in T-135, restated because it is the
control that stops a misconfiguration silently switching a detector off.

### 5.1 The scorecard — port it, and it is only safe because of the derived model

v1 scores manager responsiveness as a composite 0–100 (40% action rate / 30% briefing-open coverage
/ 30% speed-to-resolve) and logs whether the report was opened at all (§C.1). **That closes the
loop; a finding nobody is accountable for is a finding nobody clears.**

> ⚠️ **A score people are measured on is a score people manage**, and the failure mode is resolving
> findings without fixing causes. T-135 already made that **impossible**: a finding cannot be
> resolved at all, only acknowledged, and the acknowledgement is counted, ages visibly, and expires.
> **The scorecard is safe here in a way it is not in v1** — and that is the second reason T-135's
> design was right.

⛔ **The briefing-open component has no input in Phase 6** (there is no briefing — §4.5). The
composite is built as **two components re-weighted**, not three with a permanently-zero term. A
permanently-zero line in a score is the same class of defect as a permanently-zero line in a
report (bible §16.9: *"report noise is a real control weakness, not a cosmetic one"*).

---

## 6. ⚠️ Open questions — Ian's, with a recommendation each

Recorded here rather than assumed, exactly as phase-2 §7 and phase-4 §5 do. **Auto mode proceeds on
the recommendation; none of the three is mine to close.**

### Q1 — Do POS's restaurant-operations KPIs move to the ERP, or stay in POS?

Avg spend (split by session mode), peak hour, and sales-by-time-of-day exist **only in POS** — a
full-repo grep of ERP-rebuild returns zero matches for `avgBasket`, "Avg Spending", `peakHour` or
`dashPreset` (§D). Silence here reproduces the current split by default, which is why it is asked.

**Recommendation: leave them with POS until POS v2, then revisit.** They are computed from
**receipt- and session-grain** data that never crosses the seam — `docs/CROSS-APP-MAP.md` §1 shows
the ERP consuming a *day-level* analytics document, which carries neither headcount nor hour
buckets. Absorbing them today means either replicating receipt-grain data into Postgres or building
a second aggregation over a feed that cannot support it. ADR-005 already names the POS→ledger seam
as surviving the cutover until POSv2 — **that is the natural trigger**, and at that point the KPI
is nearly free because the receipts are already in Postgres.

⭐ **Two v1 design rules to restate verbatim if it ever moves**, because both were bug fixes:

1. ⛔ **Never build one blended "avg spend."** `avgDineIn` is net dine-in sales ÷ **headcount**
   (package mode, per guest); `avgAlacarte` is net walk-in sales ÷ **transaction count** (per bill —
   à la carte has no headcount). The old single blended metric read **0** on any à-la-carte-only
   day. The two populations are not comparable and forcing one number reintroduces the bug in a new
   codebase (§D).
2. **Peak hour is keyed to ARRIVAL day** (session start), not payment day — deliberately, so a
   cross-midnight session's hour reflects when guests actually arrived (§D). ⚠️ Note this is a
   **third** calendar beside the midnight financial day and the 05:00 shift day (phase-4 §4.3).

### Q2 — Is the manager prose-and-signoff ritual wanted at all?

§4.3. Recommendation: **no rebuild in Phase 6.** If yes, §4.3's table is the pre-scoped smallest
version (~3–4 days), and **Phase 7 is its better home**.

### Q3 — Does commissary/branch-order receiving-dispute ageing need a backstop?

Found in passing (§B.2, §E). v1 has a **15-day forced-resolution cron for order/channel *wastage*
disputes** and **nothing equivalent for *receiving* disputes** — while a code comment argues one is
unnecessary because *"disputes get resolved."* Live: **2 of 5 open disputes at Lipa and 2 of 4 at
Malvar already exceed 15 days.** The self-bounding assumption is ~40–50% false today.

**Recommendation: yes, and it is T-174's, not Phase 6's.** T-178 already carries the wastage
backstop; the asymmetry is that the same business judgement was never applied to the other dispute
type. Phase 6's contribution is the **detector** (`receivingDisputeOverdue`, T-213) — which makes
the ageing visible either way, and is worth having even if Ian decides manual follow-up suffices at
9 open disputes. Logged as a capability gap, not a defect, per the three-doors rule.

---

## 7. The slices

Numbers verified free 2026-09-04: `docs/tasks/` runs to **208**, so Phase 6 starts at **T-209**.
⚠️ Concurrent sessions can claim a number between this being written and a spec being opened —
check before writing `docs/tasks/209-*.md`.

### Wave 1 — the statements and the exit gate *(the ADR-005 subset that crosses into January)*

> ⚠️ **This wave has a date and the rest of the phase does not.** ADR-005's subset is *"trial
> balance · P&L · balance sheet · AR and AP aging — enough to **run** the books, not the full
> dashboard suite."* T-110 shipped the first two. **The balance sheet and the two aging reports are
> the January-critical remainder**, and the 15 November go/no-go is judged partly on them.
> ⛔ ADR-005's own precedence rule stands: if this competes with Phase 2's remainder, **Phase 2 wins.**

| # | Task | State / depends on |
|---|---|---|
| **T-209a** ✅ | **The balance sheet.** Shipped 2026-09-05 (`docs/tasks/209-reporting-read-model-and-statements.md`) — `v_balance_sheet` (a fourth view, type-signed like `v_income_statement`, never per-row `normal_balance` like `v_trial_balance`), `getBalanceSheet`, `/reports/balance-sheet`. ⭐ Folds unclosed net income into Equity as a derived "Current period earnings" line so the equation ties on any date, not only right after a year-close — found live while implementing, not planning: a first draft without it failed its own contra-account test the moment an entry touched an expense account | done |
| **T-209b** ✅ | **AR aging and AP aging reports**, reconciled to their control accounts (`1210`/`2110`) with no tolerance. Shipped 2026-09-05 — a new `orgAgingTotal` query per side, straight off `journal_lines`, independent of the bucketed subledger total (`apRepo.aging`/`arRepo.aging`, T-130/T-131) and asserted to agree to the centavo; `getApAgingReport`/`getArAgingReport`, `/reports/ap-aging`, `/reports/ar-aging` | done |
| **T-209c** | **Cash flow, per-store P&L comparison, drill-down from a report line to its journal entries, and one shared CSV export path** | not started; needs T-209a/b |
| **T-210** | **Sales reporting over the ledger** — day / month / store / channel / mode roll-ups, the sales-day register, and the POS-day ↔ ledger reconciliation (§4.1) | after T-209; needs T-123 |

### Wave 2 — the dashboard

| # | Task | State / depends on |
|---|---|---|
| **T-211** | **The manager/owner dashboard** — the KPI tiles as live queries, each stating its basis and its date range; §2.2's incompleteness flag and age labelling; **no counter, no cache, no realtime listener.** `apps/erp` has no dashboard route today | after T-209/T-210 |
| **T-212** | **Commissary and inventory KPIs** — in-flight orders, open disputes with **age**, month received. ⚠️ Inherited explicitly: phase-3 §5.3 row 27 and §8 both defer *"commissary dashboard KPIs"* here. **Fix v1's carried quirk**: a received order with a discrepancy still holds its *dispatched* amount, so `monthReceivedTotal` overstates on any month with one (§B.4) | after T-211; needs Phase 3 Wave 2 |

### Wave 3 — the lapse-detection loop closes

| # | Task | State / depends on |
|---|---|---|
| **T-213** | **OIL wave 2 — the operational detectors** (§5). Every kind gets a test that makes the condition true and proves it fires, **and** one proving it does not fire when absent (T-135 invariants 1–2) | after Phases 2–5 land their data |
| **T-214** | **The manager responsiveness scorecard** (§5.1) — two components re-weighted, not three with a zero term; the view log; `/findings` gains the accountability half it was specced without | after T-213 |

### Wave 4 — the two financial capabilities `CAPABILITY-GAPS.md` assigns to Phase 6

⚠️ **Neither is a reporting capability.** They are here because `docs/CAPABILITY-GAPS.md` line 159
assigns them to Phase 6 and phase-2 §5 explicitly excludes them. Named rather than dropped — *a gap
being deferred is a decision; a gap being unclassified is not.* **They may move to Phase 7 without
argument** if capacity is short; they do not gate the exit.

| # | Task | State / depends on |
|---|---|---|
| **T-215** | **Expense budgets** — budget vs. actual as a query over `journal_lines`, per store per period | after T-209 |
| **T-216** | **Recurring-expense automation** — the scheduler and its safe-default routing | after T-215; T-140's month-end scheduler is the precedent |

> ✅ **`CAPABILITY-GAPS.md`'s other Phase 6 row — *"books-tie-out audit · depreciation-gap
> watchdog"* — is already CLOSED**, by T-135's `trialBalanceDoesNotTie`, `depreciationNotBooked`
> and `amortisationNotBooked`. No slice needed. Recorded so nobody re-plans it.

---

## 8. Deliberately out of scope

| Not built | Why |
|---|---|
| **Any incrementally-maintained summary table, counter, or rolling-window cache** | §2. The invariant, not a preference |
| **Shift Report as a reporting surface** | §4.2 — zero documents ever; the custody control it existed for is T-186's |
| **Manager Daily Review · Manager Daily Report · Task Inbox** | §4.3 — 1 / 2 / 4 documents ever. ⚠️ **Awaiting Ian's confirmation, not deleted** |
| **The AI narrative briefing, Top-of-Mind, and the 5-provider hub** | §4.5 — deferred so it is built *over* Phase 6's queries instead of duplicating them |
| **Ask ERP** | §4.6 — 13 calls ever. A static help page is the substitute, and it belongs to Phase 7 |
| **Avg spend · peak hour · sales-by-time-of-day** | §6 Q1 — POS-owned today; ownership is Ian's call, and the recommendation is to leave them until POS v2 |
| **In-app notifications (the 8-event bell)** | `CAPABILITY-GAPS.md` defers it past cutover. Adjacent to `/findings` and repeatedly mistaken for it — named so it is not folded in |
| **A receiving-dispute forced-resolution backstop** | §6 Q3 — the *control* belongs to T-174. Phase 6 builds only the detector that makes the ageing visible |
| **`voidSalesDayAction`'s missing snapshot cascade** | A v1 defect found in passing (§A.4). Belongs in `DEFECTS-REGISTER.md`, not in this phase's task list |
| **The Firestore read-cost fixes** (the redundant rolling-30-day/month-to-date double fetch, the `localStorage` attention cache) | §B.1, §B.5 — artifacts of per-read billing. They do not survive the platform change; there is nothing to port |

---

## 9. What "done" looks like for the phase

Observable outcomes, not implementation steps.

1. **A balance sheet, an income statement and a trial balance render for the same date range, and
   they tie** — the bible §10 gate, met on screen and not only in a test.
2. **The AP and AR aging reports foot to their control accounts** — `2110` and `1210` — with no
   tolerance, which is invariant 6 rendered rather than merely asserted (ADR-005's January subset).
3. ⭐ **A dashboard tile and the statement line that means the same thing produce the same number,
   for every range tried — because they call the same query.** Not reconciled by comparison;
   *unable* to disagree (§2.1).
4. **A `grep` for an incrementally-maintained reporting table returns nothing.** No counter, no
   rolling window, no write-path cache — and any materialized view that exists renders its own
   refresh time on screen.
5. **Every money figure computed under a cap says so where it is shown** (§2.2).
6. **A manager opens `/findings` and sees operational lapses, not only ledger ones** — an
   unliquidated advance, an uncategorised expense, a price spike, a sales day that never posted.
7. **A finding still cannot be "resolved."** It leaves the list when its condition stops being
   true, and an ageing acknowledgement is visible as an ageing acknowledgement.
8. **A manager's responsiveness is a number somebody can look at**, computed from findings that
   cannot be cleared without fixing their cause.
9. **A commissary dispute's AGE is on a screen** — the thing whose absence let 4 of 9 pass 15 days
   unnoticed (§B.2).
10. ⭐ **Nothing in this phase went stale while nobody was looking**, because nothing in this phase
   stores a number that could.
