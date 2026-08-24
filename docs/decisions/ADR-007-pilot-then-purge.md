# ADR-007 — Pilot then purge: run v2 for real in Oct–Dec, start clean on 1 January

| | |
|---|---|
| **Status** | ✅ **Accepted 2026-08-24.** Ian: *“agreed, no per-row flag.”* |
| **Follows** | ADR-005 (books-first cutover) · bible row 106 (v2 always assumes a zero starting point) |

## Context

Ian's brief:

> *"Design the current app so it can be used on October and November till December, then can be
> completely wiped of data except the data that should stay — staff roster, fixed assets (name
> only, amount can be configured on Jan 2027), expense entries, additions and subtractions in
> payroll. SOP, more of configuration and base data. The financial and other data that needs to be
> cut off and entered as beginning balance shall be purged for a clean start."*

This is a **dress rehearsal**, and it is the right shape. Three months of real staff entering real
data is the only way to find what a spec cannot: the field that is always blank, the workflow
nobody follows, the report everyone actually opens. And it costs nothing at the boundary, because
row 106 already says **no historical data is ever migrated** — the pilot's transactions were never
going to survive anyway.

It also directly serves ADR-005's honesty checkpoints. A pilot that has been used in anger is the
only credible input to a go/no-go decision.

---

## Decision

### 1. ⚠️ The TABLE is the mark. There is no per-row flag.

Ian proposed marking pilot rows so a script can find them later. **I recommend against a flag, and
the reason is the project's own recurring failure mode.**

A `is_pilot_data` column has to be set correctly by **every insert path that will ever exist**.
Miss one — a backfill, a cron, an import, a Phase 5 module written in November — and that row
**silently survives the purge** and contaminates the opening books. That is DEF-036 exactly: *a
guard written against the code that exists today stops guarding when new code appears.* And it
would be discovered, if ever, as an inexplicable balance in February.

**Whether data is configuration or operational is a property of the TABLE, not of the row.** There
is no row of `journal_entries` that should survive the cutover, and no row of `accounts` that
should not. A flag would be a second, hand-maintained copy of a fact the schema already states —
the exact duplication this project exists to remove.

**Exception, and it is small:** a table whose rows split by *date* rather than by kind uses the
date. `fiscal_periods` is the only current one — 2026 pilot periods go, 2027 stays.

### 2. Three classes, not two

Ian's brief already contains the third one — *"fixed assets, name only, amount configured Jan
2027"* — and naming it prevents an argument in December.

| Class | Meaning |
|---|---|
| **KEEP** | Configuration and base data. Untouched |
| **PURGE** | Operational and financial. Every row deleted |
| **KEEP SHELL** | The row survives; its **financial columns are cleared** and re-entered at cutover. Fixed assets: name, category and **remaining useful life** stay; cost, accumulated depreciation and book value are nulled |

### 3. The classification, as of today's schema

| Table | Class | Why |
|---|---|---|
| `organizations`, `stores` | **KEEP** | Configuration |
| `persons`, `person_identities` | **KEEP** | The staff roster — Ian named it explicitly |
| `accounts` | **KEEP** | The chart of accounts is configuration, and re-seeding it would risk changing ids the opening entry references |
| `fiscal_periods` | **DATE-SCOPED** | 2026 periods purged, 2027 kept |
| `journal_entries`, `journal_lines` | **PURGE** | The books. Replaced wholesale by the opening entry |
| `audit_log` | **PURGE** | It records pilot actions against rows that will not exist. An audit trail pointing at deleted ids is worse than none |
| `etl_runs`, `etl_source_documents`, `etl_quarantine`, `etl_reconciliation` | **PURGE — but not on 1 January** | See §6 |

Phase 2–5 tables get classified **when they are created**, not at cutover. See §4 — that rule is
the one that makes this design survive.

### 4. ⭐ The rule that keeps this working: classification is MANDATORY and enforced by a test

**Every table in the schema must be declared in exactly one class, and a test fails if any table is
unclassified.**

Without this, the design rots the moment Phase 2 adds a table. Someone adds `expense_documents` in
October, nobody classifies it, and the purge either deletes it (losing configuration) or keeps it
(contaminating the books) — **and both are silent.**

With it, a developer adding a table gets a failing build until they answer one question: *does this
survive the cutover?* That is the cheapest possible moment to ask, and the same technique already
used for the chart of accounts and the app-boundary rule.

**A new table defaults to nothing.** There is no default class — an unclassified table is a build
failure, not an assumption. A default would be a decision made by whoever wrote the default, for
data they have never seen.

### 5. The purge is a rehearsed procedure, not a script someone runs in January

| | |
|---|---|
| **Backup first, verified restorable** | Not "a backup was taken" — a restore actually tested. Bible §15.8 |
| **One transaction** | It commits wholly or not at all. A half-purged database is unrecoverable without the backup |
| **FK-ordered** | Children before parents; `journal_lines` before `journal_entries` |
| **Sequences reset** | Document numbers restart at 1 for 2027. A 2027 receipt numbered 4,812 invites the question "where are the first 4,811?" |
| **Post-conditions asserted, not eyeballed** | Zero journal entries; zero rows in every PURGE table; **staff roster count unchanged**; chart of accounts unchanged; the trial balance ties at zero |
| **⭐ REHEARSED IN NOVEMBER** | Against a restored copy, not production. The purge must be a thing we have already done once, not a thing we are about to try |

### 6. The ETL tables are purged, but LATER

`etl_source_documents` holds **19,358 captured v1 documents including real PII** — staff names,
customer identifiers, live figures.

It is also the **evidence** behind the opening balance. Purging it on 1 January destroys the ability
to answer *"where did this figure come from?"* in the first month, which is exactly when that
question gets asked.

**Keep through the cutover; purge once the opening balance is signed off** — target 31 January
2027, alongside the year close. That is a distinct, dated task, not an afterthought: **PII with no
remaining purpose is a liability, and "we'll get to it" is how it stays for three years.**

---

## What this changes about Oct–Dec

Nothing about how the app is built. **The pilot needs no special mode, no "test data" banner, no
separate database.** It is the real app, used normally, whose transactional tables happen to be
emptied at the boundary.

That is deliberate. A pilot mode would be a code path that behaves differently from production and
is therefore not a rehearsal of production.

## Consequences

**Good:** three months of real use before the books matter · the go/no-go decision has evidence
behind it · no migration risk, because there is no migration · the purge is proven before it counts.

**Accepted:** pilot transactions are discarded, including any genuinely useful analysis of Oct–Dec
— those months live in v1, which is where 2026 belongs anyway.

**The risk to watch:** *"this pilot data is too useful to delete."* It will be said in December, by
someone reasonable. Keeping any of it re-opens every question row 106 closed — where did it come
from, does it balance, is it complete. **The answer is no**, and it is easier to decide that now.

## Open

1. **Which Phase 2–5 tables are KEEP?** Ian named expense entries (the category master) and payroll
   additions/subtractions (the types, not the runs) — both configuration. Each Phase 2 task spec
   states its own classification.
2. **Do pilot users keep their logins?** Suggested: yes — `persons` is KEEP, so accounts and roles
   carry over. Only what they *did* is purged.
3. **Is the November rehearsal a checkpoint of its own?** Suggested: yes, folded into ADR-005's
   15 November honesty checkpoint rather than added as a new date.
