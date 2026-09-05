# T-218 — One clock for every findings detector, and the detector Phase 6 promised

> **Status:** ✅ **SHIPPED 2026-09-05** (not pushed — Ian's call). **Closes:** DEF-172 (widened — see
> below), DEF-176. **Filed along the way:** DEF-179. **Extends:** `docs/tasks/135-integrity-findings.md` (the detector engine) and
> `docs/tasks/213-oil-wave-2-operational-detectors.md` (wave 2, whose own three date-comparing
> detectors already do this correctly and are the model).

## Why this exists

Two open register rows land in the same file, `packages/db/src/repo/findings.ts`, and one of them
turns out to be bigger and differently-shaped than it was filed as.

### DEF-172 as filed vs. what is actually there

DEF-172 says *"four T-135 findings detectors compare a business DATE against bare `current_date`"*
and names `cashRequestFloatAgeing`, `supplierCreditAgeing`, `customerCreditAgeing` and
**`reimbursablePayableOf`**. Verified against the file 2026-09-05, that is wrong in two ways, and
both matter to whoever fixes it:

1. ⛔ **Site `:317` is in `periodicPostingsMissed`, not `reimbursablePayableOf`.**
   `reimbursablePayableAgeing` contains **no `current_date` at all** — a fixer following the row
   finds nothing where it points, and the function that really has it is never visited.
2. ⚠️ **`reimbursablePayableAgeing` IS broken — by a mechanism the row does not mention.** So the
   row's instinct was right and its evidence was wrong, which is the worst combination: it looks
   verified.

**The real inventory — seven sites, five functions, three mechanisms:**

| # | Mechanism | Sites | What it costs |
|---|---|---|---|
| **A** | SQL **threshold** against session-timezone `current_date` | `supplierCreditAgeing:706` · `customerCreditAgeing:743` · `cashRequestFloatAgeing:848` | The detector fires up to a full day early or late. On a UTC server, through Manila's 00:00–08:00, `current_date` still reads *yesterday* |
| **B** | Displayed **age** recomputed in JavaScript: `(Date.now() − new Date(d+'T00:00:00Z')) / 86_400_000`, floored | `serviceChargeFloatAgeing:537` · `reimbursablePayableAgeing:815` · `cashRequestFloatAgeing:853` | The age is off by one — **and is computed from a different clock than the SQL gate that admitted the row**, so the two can contradict each other |
| **C** | SQL **age** against `current_date` | `periodicPostingsMissed:317` | The age is off by one |

⭐ **`cashRequestFloatAgeing` has both A and B.** Its gate says *"released more than 30 days ago"*
using Postgres's session clock; its badge says *"31 days"* using JavaScript's UTC clock. Nothing
makes those agree, and on a UTC server through Manila's early morning they do not.

⚠️ **Mechanism B is the same defect class as DEF-178**, filed hours earlier today against
`lane-health.test.ts` — a value stamped from one clock and judged against another. Two independent
sightings in one day is the signal that the *pattern* needs closing, not the instances.

### DEF-176 — the detector the plan already promised

`docs/plans/phase-6-reporting-and-dashboards.md` §6 Q3 answers one of Ian's open questions —
whether receiving-dispute ageing needs a backstop — by saying *"Phase 6's contribution is the
**detector** (`receivingDisputeOverdue`, T-213) — which makes the ageing visible either way."*
T-213 shipped eight detectors and that is not one of them. The gap is invisible because **both
tasks read as done.**

Live exposure: **4 of 9 open receiving disputes already exceed 15 days** (plan §6 Q3, live-probed
2026-09-04), against a v1 code comment arguing no backstop is needed because *"disputes get
resolved."* T-212 put the age on a dashboard tile 2026-09-05, which satisfies the phase's *exit
criterion* — but ⛔ **a tile is not a finding**: it cannot be acknowledged, it does not age visibly,
and it is not severity-ordered. The accountability half is still missing.

## Goal

Every ageing detector in `findings.ts` derives its threshold **and** its displayed age from **one
clock, in `Asia/Manila`, in SQL** — with a guard that makes the regression impossible rather than
merely fixed — and `/findings` gains `receivingDisputeOverdue`.

## Scope — files this task may create or modify

**Modify:**
- `packages/db/src/repo/findings.ts` — the seven sites, the shared date helper, the new detector.
- `packages/domain/tests/integration/findings.test.ts` — tests for the new detector and the
  clock behaviour.
- `docs/DEFECTS-REGISTER.md` — correct DEF-172's row (wrong function named, scope understated),
  and close DEF-172/DEF-176.

**New:**
- `tests/unit/findings-single-clock.test.ts` — the standing guard (§3 below).

**Do not touch:** any detector's *business* threshold or severity, `liveAcknowledgements` /
`insertAcknowledgement` / `acknowledgementHistory` (the acknowledgement lifecycle is T-135's and is
not in question), or `apps/erp/src/app/findings/*`. ⚠️ This task changes **when** a detector fires
by at most a day and **what age it reports**; it changes no rule about *what* is a finding.

## Contract

### 1. One Manila helper, defined once

```ts
/** ⛔ Manila, never bare `current_date` — DEF-172, migration 0112's own comment. */
const MANILA_TODAY = sql`(now() at time zone 'Asia/Manila')::date`;
```

Same shape as `packages/db/src/repo/commissary-kpis.ts` (T-212) and T-213's three detectors, which
already do this correctly. ⭐ **Defining it once is half the fix** — the reason seven sites drifted
is that each spelled the date itself.

### 2. Mechanism A — thresholds

`current_date - (N days)::interval` → `${MANILA_TODAY} - (N days)::interval`. Three sites. No
change to any `thresholdDays` default.

### 3. Mechanism B — delete the second clock, do not align it

⛔ **Do NOT convert the JavaScript to Manila.** Two clocks that agree today drift tomorrow; that is
precisely how DEF-178 happened. **Compute `age_days` in the same SQL statement that applies the
gate**, Manila-based, return it as a column, and **delete the JS recompute entirely.**

```sql
(${MANILA_TODAY} - <the date column>)::int as age_days
```

⭐ This is the structural fix: after it, a detector's gate and its badge cannot disagree, because
there is only one subtraction and it happens once. Three sites (`:537`, `:815`, `:853`).

⚠️ `serviceChargeFloatAgeing:537` and `reimbursablePayableAgeing:815` compute their age from an
`oldestUncleared` value already derived in the query — check whether that value is a `date` or a
`text` before casting; do not assume.

### 4. Mechanism C — `periodicPostingsMissed:317`

`(current_date - min(pd.entry_date) ...)` → `(${MANILA_TODAY} - min(pd.entry_date) ...)`.
⚠️ This function is **not a detector** — it returns `StorePositionRow[]` consumed elsewhere. Confirm
every caller before changing the value's meaning by a day, and say in the report what they were.

### 5. `receivingDisputeOverdue` — the new detector (DEF-176)

```ts
export async function receivingDisputeOverdue(
  tx: Tx, orgId: string, thresholdDays = 15,
): Promise<DetectedFinding[]>
```

- **Set:** `trade_discrepancies` with `status <> 'resolved'` and an age past `thresholdDays`.
  ⭐ **The predicate must be character-for-character `tradeDiscrepanciesRepo.unresolved`'s**, which
  that file's header states as its own invariant (*"`blocking` and `open` are the SAME query… One
  source, two consumers"*). This is a fourth consumer, never a fourth definition.
- **Threshold 15 days** — not invented here: the same figure v1's *wastage* forced-resolution
  backstop already uses, applied to the dispute type that never got one (plan §6 Q3).
- ⚠️ **A `deferred` row still counts and still ages.** A deferral is *"a promise to decide by a
  date, not an exemption"* (T-174's schema header). ⛔ Do **not** exempt `deferred` — that would
  make the detector agree with a manager's postponement instead of observing it.
- ⚠️ **`store_id` is the COMMISSARY's**, not the branch's (T-174 invariant 11).
- ⚠️ **`value` is AT COST**, not the transfer rate (**DEF-175**, corrected 2026-09-05). Label the
  `amount` accordingly; do not present it beside a transfer-rate figure without saying so.
- `severity`: **`soft`** — it is an ageing prompt, not a books-do-not-tie fault, matching
  `supplierCreditAgeing`/`cashRequestFloatAgeing` rather than `trialBalanceDrift`.
- `drillTo`: `/commissary/discrepancies`.
- Register it in whatever list `findingsFor` iterates — ⛔ **a detector that exists and is not
  registered is `reference_shareat_done_but_uncalled` exactly**: green tests, zero callers.

## Invariants

1. **No bare `current_date` anywhere in `findings.ts`.** Enforced by §3's guard test, not by review.
2. **No detector computes an age in JavaScript.** Same guard.
3. A detector's gate and its reported age come from **one** expression evaluated **once**.
4. `receivingDisputeOverdue`'s set is `tradeDiscrepanciesRepo`'s predicate, not a copy.
5. No `thresholdDays` default changes; no severity changes; no detector gains or loses a rule.

## Tests

### The standing guard — `tests/unit/findings-single-clock.test.ts`

⭐ **This is the deliverable that outlives the fix.** A pure-text test over `findings.ts` source:

- asserts **zero** occurrences of bare `current_date` (allowing it inside a `--` comment or a JS
  comment, which is where the explanatory notes live);
- asserts **zero** occurrences of `Date.now()`.

Precedent: `tests/unit/no-client-supplied-actor.test.ts` and
`packages/db/tests/migration-journal.test.ts` are both grep-shaped guards in this repo. ⚠️ **Confirm
it FAILS before the fix** — a guard that only ever passed proves nothing (§3.2). It should report 4
and 3 hits respectively on the current file.

### `receivingDisputeOverdue` — T-135 invariants 1–2, both directions

1. A dispute aged **20 days** fires; the finding carries the right `key`, `storeId`, `amount` and
   `drillTo`.
2. A dispute aged **3 days** does **not** fire.
3. A **resolved** dispute does not fire regardless of age.
4. ⭐ A **deferred** dispute past 15 days **does** fire — the deferral does not silence it.
5. It is reachable through `findingsFor`, not merely exported.

⚠️ **Pin ages to Manila noon**, as `tests/integration/commissary-kpis.test.ts` does — a fixture
stamped `now() - interval '20 days'` and asserted against a floor is DEF-178's bug in a new file.

### The three converted ageing detectors

For `cashRequestFloatAgeing` (the one with both mechanisms): a row released **exactly at the
threshold boundary** reports an `ageDays` **consistent with the gate that admitted it**. That is the
assertion mechanism B exists to make possible and is impossible to write today.

⚠️ Run integration on an **isolated lane DB** (`shareat_test_lane25` exists, migrated) — not shared
`shareat_test` — if any peer session is active. `ListAgents` first.

## Out of scope — with reasons

- **A forced-resolution backstop for receiving disputes.** Plan §6 Q3: the *control* is T-174's.
  This task makes the ageing visible; it does not force anything. ⚠️ Still Ian's call.
- **DEF-178's `lane-health.test.ts` fix** — same defect class, different file and lane. Filed, not
  fixed here; folding it in would make this task's diff span two unrelated areas.
- **The other 20-odd detectors' thresholds and severities** — untouched, deliberately.

## Done when

- [x] Guard test exists and was **confirmed failing first** — exactly **4** `current_date` and **3**
      `Date.now()` hits, at the seven predicted lines. Re-verified after the fix by reintroducing
      one of each in real code and watching it bite with correct line numbers.
- [x] All seven sites converted; the guard passes.
- [x] `receivingDisputeOverdue` ships, is **registered** in `findingsFor`, and has five tests.
      Verified by breaking it both ways: unregistering fails exactly the 3 positive tests; flipping
      `>` to `>=` fails the boundary test alone.
- [x] DEF-172's row corrected and closed. ⚠️ **The row was wrong about one of its own four
      functions and understated the scope by nearly half** — recorded in the row itself.
- [x] DEF-176 closed.
- [x] ⚠️ **DEF-179 filed** — found building the guard: this repo checks out CRLF, and JS `.` does
      not match ``, so the comment stripper silently stripped nothing. The two existing
      grep-shaped guards were checked and are safe.
- [ ] typecheck · unit · integration (lane DB, stated) · build with the dev server stopped.
- [ ] Smoketested on 9008: `/findings` renders, and the new detector's row appears if the dev data
      has a qualifying dispute — if it does not, **say so** rather than implying it was seen.
- [ ] `docs/ROADMAP.html` updated. This file's status line updated.
