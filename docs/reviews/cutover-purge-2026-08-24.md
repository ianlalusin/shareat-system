# Cutover purge — DRY RUN

Database: `shareat_dev` on `localhost` · as-of 2026-08-24

**Deferred by `notBefore`** — these are the evidence behind the opening balance (ADR-007 §6):

- etl_source_documents (not before 2027-01-31)
- etl_runs (not before 2027-01-31)
- etl_quarantine (not before 2027-01-31)
- etl_reconciliation (not before 2027-01-31)

## Plan

| Table | Class | Rows now | After |
|---|---|---:|---:|
| `audit_log` | purge | 0 | 0 |
| `journal_lines` | purge | 19 | 0 |
| `journal_entries` | purge | 9 | 0 |
| `fiscal_periods` | date-scoped | 1 | rows from 2027-01-01 |
| `accounts` | keep | 92 | 92 |
| `organizations` | keep | 1 | 1 |
| `person_identities` | keep | 0 | 0 |
| `persons` | keep | 0 | 0 |
| `stores` | keep | 2 | 2 |

Purge order (derived from the live FK graph): `audit_log` → `journal_lines` → `journal_entries`

**DRY RUN — nothing was changed.** Re-run with `--apply` to purge.
