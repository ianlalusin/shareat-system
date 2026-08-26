# File map — where everything lives

> **This is a routing index, not documentation.** Every row POINTS — to the owning
> code and the governing doc — and explains nothing, so it cannot drift into a
> second source of truth (the DEF-034 lesson: a doc that restates state goes
> stale and misleads). The pointed-to file and the bible are always the
> authority. If a row and reality disagree, the row is stale and fixing it is a
> 🔸 finding.
>
> **Maintained by `/daily-review`**: when a diff creates, moves, deletes, or
> renames files, or opens a new domain, the reviewer updates the affected rows
> and bumps the line below in the same run.
>
> **Verified against:** `main @ 0948e8e` (2026-08-26)

How to use this: find your topic, open the code paths it names, and read the
governing docs **before** changing anything. `docs/RULES.md` §5 routes
questions; this file routes *code*. Read `docs/GLOSSARY.md` before trusting any
field name.

---

## Money and accounting core

| Topic | Code lives in | Governed by |
|---|---|---|
| Money arithmetic (integer centavos, the ONLY implementation) | `packages/core/src/money.ts` · tests `tests/unit/money.test.ts` | Bible §6 · DEF-003 |
| Chart of accounts — definition & seed (95 accounts) | `packages/db/seed/chart-of-accounts.ts` · schema `packages/db/schema/accounts.ts` | `docs/decisions/COA-ALIGNMENT.md` · T-102/T-102b · DEF-035 |
| Journal tables (entries, lines, triggers) | `packages/db/schema/journal.ts` · SQL repo `packages/db/src/repo/journal.ts` (the ONLY place journal SQL is written) | T-103 · bible §16 |
| Posting an entry (draft-first, idempotency) | `packages/domain/src/ledger/post-entry.ts` | T-105 · DEF-031 |
| Reversing an entry | `packages/domain/src/ledger/reverse-entry.ts` | T-106 · DEF-036 · migration `0005` |
| v1 in/out → debit/credit adapter | `packages/domain/src/ledger/legacy-adapter.ts` | T-107 |
| Subledger — party on the line (AP/AR control accounts) | `packages/db/schema/journal.ts` (`party_type`/`party_id`) · `accounts.requires_party` | T-118 · DEF-037 · DEF-040 |
| Fiscal periods | `packages/db/schema/fiscal-periods.ts` | ADR-006 · DEF-038 (no close routine yet) |

## Expenses, sales, and the ETL from v1

| Topic | Code lives in | Governed by |
|---|---|---|
| **Expenses / AP** — how a v1 expense becomes journal legs | conversion `packages/etl/src/convert.ts` · leg mapping `packages/etl/src/leg-mapping.ts` · category taxonomy `packages/etl/src/taxonomy.ts` · specimens `packages/etl/corpus/expense.ap/`, `expense.cash/`, `expense.capex/` | T-113 · T-107 · COA-ALIGNMENT §4 · DEF-042 (reason codes missing) |
| **Sales** — how a v1 sale becomes journal legs | same converter · specimens `packages/etl/corpus/sale.*/` | T-113 · GLOSSARY (`dineInSales` trap) · DEF-004/DEF-005 |
| ETL framework — land, convert, quarantine, run | `packages/etl/src/run.ts`, `source-reader.ts`, `capture.ts`, `pseudonymise.ts` · landing table `packages/db/schema/etl.ts` + repo `packages/db/src/repo/etl.ts` | T-112 · DEF-041 (landing immutable, migration `0009`) |
| Reconciliation & audit of the replay | `packages/etl/src/reconcile.ts` · `packages/etl/src/audit/` (balances, compare, groups, report) | T-114a · T-117 |
| Firestore reading (v1 source) | `packages/etl-firestore/src/` (client, reader, plan) | T-114a · bible §11 |
| **Sales day** — a day's selling, per store; verification is what POSTS | schema `packages/db/schema/sales-days.ts` · repo `packages/db/src/repo/sales-days.ts` · routing `packages/domain/src/sales-days/routing.ts` · services `create.ts`, `verify.ts` · screens `apps/erp/src/app/sales-days/` | T-123 · bible rows 126, 133, 134, 135 · POSTING-PATTERNS `sale.*` |
| **Fixed assets & depreciation** — accumulated and book value are DERIVED, never stored | schema `packages/db/schema/fixed-assets.ts` · repo `packages/db/src/repo/fixed-assets.ts` (`accumulatedFromLedger` is the whole point) · pure engine `packages/domain/src/fixed-assets/schedule.ts` · services `policy.ts` (the fail-closed read), `capitalize.ts`, `depreciate.ts`, `dispose.ts` · screens `apps/erp/src/app/fixed-assets/` | T-124 · bible rows 139, **140** · discovery 25 · DEF-044 |
| **Capitalisation seam** — an approved CAPEX expense becomes a register row | `packages/domain/src/expenses/approve.ts` calls `capitalizeApprovedExpense` — ⚠️ the NON-authorizing entry point, because `manage_fixed_assets` is admin-only and `approve_expense` is a manager's | T-124 §6 · T-122 |

## Schema, migrations, and data rules

| Topic | Code lives in | Governed by |
|---|---|---|
| Table definitions (the ONLY place) | `packages/db/schema/` | Bible §4 |
| Migrations — applied SQL, never edited | `packages/db/migrations/0000`–`0009` + `meta/_journal.json` | Bible §2 rule 8 · DEF-039 (`when` ordering, guarded by `packages/db/tests/migration-journal.test.ts`) |
| DB client / connection | `packages/db/src/client.ts` | DEF-030 (redaction) |
| Orgs, stores, persons spine | `packages/db/schema/organizations.ts`, `stores.ts`, `persons.ts` | Bible §4 · DEF-009 |
| Audit log | `packages/db/schema/audit-log.ts` | Bible §4 |

## Cross-cutting and apps

| Topic | Code lives in | Governed by |
|---|---|---|
| Env validation | `packages/core/src/env.ts` | DEF-028 |
| Logging | `packages/core/src/logger.ts` | Bible §15 |
| Datetime | `packages/core/src/datetime.ts` | Bible §6 |
| ERP front-end (port 9008) | `apps/erp/src/app/` · health route `apps/erp/src/app/api/health/` | DEF-029 · bible §8 |
| **Authorization** — the single `authorize()` gate, enforced in every domain service | `packages/auth/src/authorize.ts` (the ONLY gate; `Actor`, `AuthorizeContext`, `AuthorizationError`) · `capabilities.ts` (`ROLES`, the `Capability` union, `CAPABILITY_MATRIX`, `CAPABILITY_SCOPE`) · `roles.ts` (`assignRole`, `elevateManager`) · tests `packages/auth/tests/integration/authorize.test.ts` | Bible §7 · T-138 |
| **Role / user MANAGEMENT UI — DOES NOT EXIST YET.** `assignRole()` exists but no screen calls it; its caller must `authorize()` for `manage_users` | — no admin console under `apps/erp/src/app/`; do not invent one without a spec | Bible §7 |
| **Firestore sync (mirror + inbox) — DOES NOT EXIST YET.** Planned as `packages/domain/sync/` | — | Bible §5 |
| POS / CUSTOMER / Website apps — placeholders only | `apps/pos/`, `apps/customer/`, `apps/website/` (README each) | ADR-003 |
| **Identity & sessions** — the ONLY way an `Actor` is produced | schema `packages/db/schema/sessions.ts` · repo `packages/db/src/repo/sessions.ts` · crypto `packages/auth/src/credentials.ts` · services `packages/auth/src/sessions.ts` · request boundary `apps/erp/src/lib/session.ts` · sign-in `apps/erp/src/app/sign-in/` | T-138 · bible §7.1, row 138 · DEF-062 · DEF-063 |

## Tests and gates

| Topic | Where | Governed by |
|---|---|---|
| App-boundary rule (apps never imported) | `tests/unit/app-boundaries.test.ts` | ADR-004 |
| Secrets guard | `tests/unit/no-committed-secrets.test.ts` | Bible §15 |
| Ledger invariants / worked examples / golden | `tests/invariants/`, `tests/worked-examples/`, `tests/golden/` (being populated — T-108/T-109) | Bible §16 |
| Integration suites (real Postgres, 5435) | `packages/*/tests/integration/` | Bible §9.3 — DB tests must live under `tests/integration/` |
| No server action accepts a client-supplied actor | `tests/unit/no-client-supplied-actor.test.ts` — repo-wide scan; the exemption list is EMPTY | T-138 invariant 1 · bible §7.1 |

## Docs and governance

| Question | File |
|---|---|
| The rules / the authority | `docs/RULES.md` (digest) → `PROJECT_BIBLE.md` (wins) |
| Why decided | `docs/decisions/ADR-001…006`, `COA-ALIGNMENT.md`, `OPEN-DECISIONS.md`, bible §13 |
| What's broken / flagged | `docs/DEFECTS-REGISTER.md` — the single list |
| What the business does that the plan misses | `docs/CAPABILITY-GAPS.md` |
| How the four apps connect | `docs/CROSS-APP-MAP.md` |
| Field-name traps | `docs/GLOSSARY.md` |
| Work queue | `docs/plans/phase-1-accounting-spine.md` · `docs/tasks/1xx-*.md` |
| Daily review output | `docs/reviews/YYYY-MM-DD.md` · `docs/reviews/NEXT-PROMPT.md` |
| Cold start | `HANDOFF.md` |
