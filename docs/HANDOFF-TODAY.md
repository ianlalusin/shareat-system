# Handoff — 2026-08-26

*Written by the `wrap-up` skill. **Overwritten every wrap-up** — for the review's separate,
defect-focused prompt see `docs/reviews/NEXT-PROMPT.md`.*

---

## Where things stand

**Wave 1 is complete and behind a real login.** Expenses (T-122) and the sales day (T-123) both
post to the ledger, both are driven end to end in a browser, and the staff-picker dropdown that
used to stand in for authentication is **gone** — a repo-wide test now fails the build if anyone
reintroduces a client-supplied actor.

**T-124 (fixed assets + depreciation) is half-built**: spec, research, schema, migration `0019`
and the pure depreciation engine are done and green. **The service layer and screens are not.**
That is where the next session starts.

## Gates at `c66f835`

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm test` | ✅ **522 / 522** (31 files) |
| `npm run test:integration` | ✅ **730 / 730** (20 files) |
| `npm run build` | ⏭️ skipped — dev server live on 9008 (bible §2.9) |

Everything is committed and pushed to `main`. `daily-review/2026-08-26` has been **merged**.

---

## What happened this session

### 1. The process correction that shaped everything after it

> **Ian:** *"Before building, as I've said before, look how v1 does it — correct if wrong, improve
> if it can be improved, research about it, so we don't break anything working. We just align and
> correct what needs alignment and correction."*

I had started T-123's schema from our own posting patterns. Reverted and read v1 first: its
`SalesDayPlain` carries ~60 fields to my 7. **I had under-scoped the task roughly eight-fold.**
Every task since has opened with v1.

⭐ It paid immediately in T-138: reading v1's auth showed the browser half was **already correct**,
which halved the task.

### 2. Sales day (T-123) — shipped

Three tables, none of v1's figure names surviving (`dineInSales` is package-only; `takeOutSales` is
a residual — see GLOSSARY). Three identities enforced, two in the schema:

```
unli + àlaCarte                = totalSales              (schema CHECK)
Σ all channels                 = totalSales              (added after Ian's correction)
collected + discounts + comps  = gross + charges         (spans two tables)
```

⚠️ **The channel identity was missing from my first cut**, and my own browser smoketest had
happily passed a ₱6,000 day carrying ₱550 of channels. Ian caught it by looking at a real sales
report. It is now a test.

**Decided:** an unverified sales day recognises **no revenue**; creating a new one is **blocked**
while an unverified one exists; revenue is dated by **sales day**, not entry date. (Bible 126.)

### 3. Service charge — five corrections, and Ian was right each time

Liability → revenue → **float**. It is now **neither revenue nor AP**, held at **2160**, and
distributed **daily or weekly** — never monthly, which is not lawful under RA 11360.
"Other charges" (leftover, packaging) are a **separate** account and *are* income. Bible 134–136.

### 4. Auth (T-138) — shipped

6-digit PIN, `scrypt` (no native dependency), store-scoped lookup hash, domain-separated HMAC keys.
`kind` is a **column** (`pin | firebase | biometric`) so adding biometrics is a row, not a
migration. Sessions end **both ways** — `expires_at` and `ended_at`/`ended_reason`.

### 5. Fixed assets (T-124) — schema + engine

**No `accumulated_depreciation` column, no `book_value` column.** Both are **derived from the
ledger**; storing them is how v1's register drifts. The schedule is a pure function so every
rounding case is proven without a database — the remainder lands on the **last** period, and
`periodDue` returns **null, never zero** (a zero entry would hide the OIL finding that catches
DEF-044).

### 6. Cash custody (T-136) and the POS/ERP seam

Pooled remittance is a **modelling change, not a setting**; per-store cadence with an un-remitted
ceiling; store imprest fund. And the seam is settled: **POS transacts, ERP accounts** — cash
handover was duplicated in both and now folds to ERP alone. Bible 127–130.

### Decisions Ian made, and where each is recorded

| Decision | Recorded in |
|---|---|
| Unverified sales day recognises no revenue; create-block; date by sales day | Bible **126** |
| Owner split (cashier/office × cash/online) retained | Bible **127** |
| Pooled remittance + per-store cadence and ceiling | Bible **128–129**, T-136 |
| POS transacts, ERP accounts; cash handover folds to ERP | Bible **130** |
| `totalSales` = Σ all channels | Bible **133**, schema CHECK |
| Service charge is a FLOAT at 2160; other charges are income | Bible **134–135** |
| Distribution daily or weekly; monthly unlawful | Bible **136** |
| 6-digit PIN retained, biometric-ready; sessions end both ways | Bible **137–138**, T-138 |
| Capitalisation threshold **₱10,000**; per-category lives | Bible **139**, discovery 25, T-124 §10 |
| *"Wrap up today's work"* is the closing ritual for every agent | `.claude/skills/wrap-up/`, CLAUDE.md, AGENTS.md |

**Nothing decided today is unrecorded.**

---

## Pick up here

**1. T-124 service layer + screens.** Schema, migration `0019` and
`packages/domain/src/fixed-assets/schedule.ts` are done and green. What is missing: the repo, the
service (acquire · post a period · dispose · the catch-up run), and the screens. Read
`docs/tasks/124-fixed-assets-and-depreciation.md` §5–7 first — §7's invariants are the test list.

⭐ **The catch-up is the point.** DEF-044 is v1's scheduler stopping for two months with nobody
noticing. Make each period's posting **idempotent on `(asset, period)`** and catching up is not a
repair script — it is running the same call again and letting the posted periods no-op.
`periodsThrough()` already returns the list.

**2. Then T-125 (prepaid + amortisation)** — the same shape as T-124 and much cheaper right after it.

**3. `docs/reviews/2026-08-26.md`** holds the review's findings; they are merged but not all acted on.

---

## Do not decide these alone — they are Ian's

| Open | The recommendation already on the table |
|---|---|
| **Service-charge float treatment** | Ian is checking with his accountant. Built as decided; do not re-litigate |
| **Per-category useful lives** | Proposed table in T-124 §10. Wants the accountant's nod **once**, then leave them — an estimate that keeps moving is one nobody trusts. ⚠️ Changing the *method* needs BIR approval; changing a *life* does not |
| **DEF-063 — sign-in has no rate limiting** | Deferred deliberately. ⛔ **Must land before a terminal reaches a real cashier** |

---

## Traps live in this area right now

- **`ERP-rebuild` is the OLD live ERP, not this rebuild.** The name lies. All four reference repos
  are read-only.
- **Piping the test run to `tail` always exits 0.** Check the pipe's first exit status — I
  committed a red suite this way.
- **Derived, not maintained.** The single most repeated correction of the session. No stored
  accumulated depreciation, no stored book value, no stored balances.
- **Read v1 as requirements, never as design** (bible §1.2b).
- **Trap names**: `dineInSales` is package-only, `takeOutSales` is a residual, `receiptSeq` is not
  monotonic. Check `docs/GLOSSARY.md` before naming anything — the banned-names test is absolute
  and will fail on your comments too.

---

## The paste-ready prompt

```
Continue Shareat System at C:\Users\ianla\webapps\shareat-system.

Read docs/RULES.md, then docs/HANDOFF-TODAY.md. PROJECT_BIBLE.md is the authority —
read its section 13 decision log (139 rows) for anything you are about to decide.

Next task: T-124 fixed assets, the service layer + screens.
Spec: docs/tasks/124-fixed-assets-and-depreciation.md, sections 5-7.
Already done and green: schema, migration 0019, and the pure engine at
packages/domain/src/fixed-assets/schedule.ts. Do not rebuild those.

Before you write anything: read how v1 does it in C:\Users\ianla\webapps\ERP-rebuild
(read-only, no permission needed — it is the OLD live ERP despite the name).
Ian's standing rule: correct if wrong, improve if it can be improved, research it —
align rather than reinvent. Under-scoping happens when you skip this.

Rules that bite here: derive from the ledger, never store accumulated depreciation or
book value. Post only via postEntry/reverseEntry. Make each period idempotent on
(asset, period) so catch-up is just re-running it — that is the DEF-044 answer.

Gates before any commit: npm run typecheck, npm test, npm run test:integration.
Never judge a run by piping it to tail — that always exits 0.
Baseline at c66f835: 522 unit, 730 integration, all green.

When I say "wrap up today's work", run the wrap-up skill.
```
