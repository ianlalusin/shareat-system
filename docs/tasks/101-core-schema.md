# T-101 — Core schema

> **Status:** spec ready for implementation. **Phase 1, first task.**
> **Depends on:** Phase 0 (green). **Blocks:** T-102 (COA seed), T-103 (journal tables).
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

Create the foundational tables every other table in Shareat System will reference —
organizations, stores, the identity spine, the chart of accounts, fiscal periods, and the
audit log — as a committed, forward-only migration, with the rules enforced by the database
rather than by application code.

## Why this spec differs from `phase-1-accounting-spine.md` §C

ADR-003 changed who this schema serves. It is no longer an ERP schema; it is **the single
backend for four front-ends** (ERP, POS, CUSTOMER, Website). Two consequences, and only two —
this is not licence to widen scope:

1. **`persons` splits into `persons` + `person_identities`.** The plan's
   `persons (id, org_id, full_name)` is staff-shaped. Discovery found **three incompatible
   identity schemes** in CUSTOMER alone — a hashed device id, a **phone number used as the
   document id**, and a `d_`-prefixed game device id (DEF-009) — plus staff identity in POS
   and ERP, and a `customers/{phone}` upsert from the Website. A phone number is a **natural
   key that changes**; making it a primary key is the trap. One human, many identities.
2. **`stores` becomes the single source of branch identity.** The Website alone has three
   independently-synced sources today (DEF-010).

**Deliberately NOT widened:** no POS or CUSTOMER feature columns, no menu, no sessions, no
loyalty. **Structure for four consumers; columns for one.** Those tables arrive with their
own phases and their own specs.

---

## Scope

The agent may create or modify **only** these files:

```
db/schema/organizations.ts
db/schema/stores.ts
db/schema/persons.ts
db/schema/accounts.ts
db/schema/fiscal-periods.ts
db/schema/audit-log.ts
db/schema/index.ts                     (re-export only)
db/migrations/*.sql                    (generated, then hand-augmented — see Contract §7)
tests/integration/core-schema.test.ts
```

Anything else is out of bounds. In particular: **do not touch** `src/lib/env.ts`,
`src/lib/money.ts`, `src/lib/db/client.ts`, or `next.config.js`.

---

## Contract

### 1. Conventions — apply to every table

| Rule | Implementation |
|---|---|
| Primary key | `uuid PRIMARY KEY DEFAULT uuidv7()` — **PostgreSQL 18 native**, no extension (bible §13 row 70) |
| Timestamps | `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz` |
| Actor | `created_by uuid REFERENCES persons(id)` where an actor exists |
| Foreign keys | Always declared. `ON DELETE RESTRICT` by default |
| Enums | Postgres `CHECK`-constrained text, not `pg_enum` — adding a value later is a migration, not a type rewrite |
| Store scoping | `store_id` on every store-scoped table, indexed |

### 2. `organizations`

`id` · `name` · `code` UNIQUE · `is_active` · timestamps.
One row today. **SEBN is the reserved second entity** — do not hardcode a single-org
assumption anywhere.

### 3. `stores`

`id` · `org_id` FK · `code` UNIQUE per org · `name` · `timezone` NOT NULL DEFAULT
`'Asia/Manila'` · `is_active` · timestamps.

- `UNIQUE (org_id, code)`.
- `timezone` is per-store and explicit. Business-day boundaries derive from it
  (`src/lib/datetime.ts`). Do **not** read a global constant.

### 4. `persons` + `person_identities` — the identity spine

**`persons`** — one row per *human being*, independent of how they authenticate.

`id` · `org_id` FK · `display_name` NOT NULL · `is_active` · timestamps.

**`person_identities`** — many per person.

`id` · `person_id` FK ON DELETE CASCADE · `kind` · `value` · `is_verified` ·
`last_seen_at` · timestamps.

- `kind` CHECK IN (`'firebase_uid'`, `'phone'`, `'email'`, `'staff_no'`, `'device_hash'`).
- **`UNIQUE (kind, lower(trim(value)))`** — an expression index. One phone number cannot
  belong to two people.
- A person may hold several identities of the same kind (two phones), so **no** unique
  constraint on `(person_id, kind)`.

> **This is the table that retires DEF-009.** Phone becomes an attribute that can change,
> be re-verified, or be reassigned — never a primary key. A staff member who is also a
> loyalty customer is **one** person with two identities, not two rows.

**Out of scope for T-101:** roles and permissions. Identity answers *who you are*;
authorization answers *what you may do* (bible §7 rule 3) and arrives with its own task.

### 5. `accounts` — the chart of accounts

`id` · `org_id` FK · `code` · `name` · `type` · `normal_balance` · `parent_id` self-FK ·
`is_postable` · `is_system` · `legacy_code` · `status` · timestamps.

- `type` CHECK IN (`'asset'`,`'liability'`,`'equity'`,`'income'`,`'expense'`).
- `normal_balance` CHECK IN (`'debit'`,`'credit'`) — **a declared column, never inferred
  from a code prefix** (bible §13 row 39; v1 inferred it from an `accountId` string prefix).
- `status` CHECK IN (`'active'`,`'reserved'`,`'archived'`) — bible §13 row 37.
- `UNIQUE (org_id, code)` and `UNIQUE (org_id, legacy_code) WHERE legacy_code IS NOT NULL`.
- `is_system` rows may be deactivated but **never deleted**; their `code` is stable forever
  (bible §4.4).
- A postable account may not have children: enforce that a row with `is_postable = true` is
  not referenced as any other row's `parent_id`.

### 6. `fiscal_periods`

`id` · `org_id` FK · `starts_on` date · `ends_on` date · `status` · `closed_at` ·
`closed_by` · timestamps.

- `status` CHECK IN (`'open'`,`'closed'`,`'locked'`).
- `CHECK (ends_on >= starts_on)`.
- **No overlapping periods per org**, enforced by an `EXCLUDE` constraint:
  ```sql
  EXCLUDE USING gist (
    org_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  )
  ```
  ⚠️ This requires **`CREATE EXTENSION IF NOT EXISTS btree_gist`** — the `org_id WITH =`
  operator is not available to gist without it. Put the extension in the same migration.

### 7. `audit_log`

`id` · `actor_person_id` FK nullable · `action` · `entity` · `entity_id` uuid ·
`before` jsonb · `after` jsonb · `source` · `occurred_at timestamptz NOT NULL DEFAULT now()`.

- `source` CHECK IN (`'web'`,`'pos'`,`'customer'`,`'website'`,`'apk'`,`'kiosk'`,`'cron'`,
  `'ingestor'`,`'etl'`) — **the four front-ends are named here**, which is the first place the
  schema admits it serves more than the ERP.
- `actor_person_id` is nullable **only** so a system/cron action can be recorded; a
  user-initiated action without an actor is a defect.
- Index on `(entity, entity_id)` and on `occurred_at`.

### 8. Migration

`npm run db:generate` produces the SQL; **hand-augment it** for what Drizzle cannot express —
the `btree_gist` extension, the `EXCLUDE` constraint, and the expression-based unique index on
`person_identities`. Once applied anywhere, the file is **never edited** (bible §2 rule 8).

---

## Invariants the tests must prove

Each is a database guarantee, not a convention. If application code could violate it, the
schema is wrong.

1. Two people cannot share a phone number — `UNIQUE (kind, lower(trim(value)))` rejects it.
2. The same phone in different case/whitespace is **the same identity** and is rejected.
3. One person can hold several identities, including two of the same `kind`.
4. Deleting a person cascades their identities and nothing else.
5. Two overlapping fiscal periods in one org are rejected by the `EXCLUDE` constraint.
6. Two non-overlapping periods in one org are accepted; overlapping periods in *different*
   orgs are accepted.
7. An account with an invalid `type` or `normal_balance` is rejected.
8. `(org_id, code)` is unique for accounts; the same code in a different org is fine.
9. A store's `code` is unique per org, not globally.
10. `uuidv7()` produces time-ordered ids — two rows inserted in sequence sort by creation.
11. Deleting an org with dependent stores is **restricted**, not cascaded.

## Tests

`tests/integration/core-schema.test.ts`, against real Postgres (never a mock — bible §9
rule 3). Write them **before** the implementation. One test per invariant above, each
asserting the **database** raises the error, not application code.

Follow the existing harness in `tests/integration/database.test.ts` and its
`tests/integration/setup.ts`.

## Out of scope

`journal_entries` / `journal_lines` (T-103) · the chart-of-accounts seed data (T-102) ·
roles and permissions · any POS, CUSTOMER, or Website feature table · the posting engine ·
reporting views · anything under `src/`.

## Done when

- [ ] Six schema files created; `db/schema/index.ts` re-exports them.
- [ ] `npm run db:generate` produces a migration; it is hand-augmented per Contract §7.
- [ ] `npm run db:migrate` applies cleanly to an empty database.
- [ ] Re-running `db:migrate` is a no-op.
- [ ] All 11 invariants pass in `tests/integration/core-schema.test.ts`.
- [ ] `npm run typecheck` clean · `npm run test` green · `npm run test:integration` green ·
      `npm run build` succeeds with the dev server stopped.
- [ ] No file outside **Scope** modified.
