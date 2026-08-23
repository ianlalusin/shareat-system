# Shareat System — Backend Orientation

How the server side is organised, and what happens when someone clicks Save.

---

## 1. The shape in one picture

```
  ┌──────────────────────────────────────────────────────────────┐
  │  UI — apps/*/src/app/**, apps/*/src/components/**                          │
  │  React. Knows nothing about SQL. Ported from v1.             │
  └──────────────────────────┬───────────────────────────────────┘
                             │  calls a server action
  ┌──────────────────────────▼───────────────────────────────────┐
  │  SERVER ACTIONS — apps/*/src/lib/actions/                           │
  │  THIN. Exactly four jobs:                                    │
  │    1. resolve the actor from the session (never a parameter) │
  │    2. authorize(actor, action, resource)                     │
  │    3. validate input with zod                                │
  │    4. call one service function                              │
  │  No SQL. No business rules. No journal building.             │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌──────────────────────────▼───────────────────────────────────┐
  │  SERVICES — packages/domain/                                │
  │  Where the business lives. Owns the transaction.             │
  │  Business rules, posting patterns, orchestration.            │
  │  Calls repositories. Never writes raw SQL itself.            │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌──────────────────────────▼───────────────────────────────────┐
  │  REPOSITORIES — packages/db/src/repo/                             │
  │  The ONLY place SQL is written. Dumb by design:              │
  │  no business rules, no authorization, no orchestration.      │
  │  Every store-scoped function filters on store_id — always.   │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌──────────────────────────▼───────────────────────────────────┐
  │  SCHEMA — packages/db/schema/ (Drizzle)                              │
  │  The ONLY place tables are defined.                          │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌──────────────────────────▼───────────────────────────────────┐
  │  POSTGRES — constraints and triggers are the last line       │
  │  Balanced entries · min 2 lines · closed-period rejection    │
  │  Posted-record immutability · FKs · CHECKs · UNIQUEs         │
  │  Application code cannot forget to call these.               │
  └──────────────────────────────────────────────────────────────┘
```

**The one rule that keeps it honest:** each layer may only call the layer directly below
it. An action never touches a repository. A repository never enforces a rule.

---

## 2. Traced example — "record a ₱5,000 cash expense for Rent"

### Step 1 — UI
A form in `apps/erp/src/app/financial/expenses/` calls the server action. It passes *what happened*,
never *who did it*.

```ts
await createExpense({ storeId, entryId: "sys_rent", amount: 5000,
                      paidFrom: "cash__cashier", documentUrl, date })
```

### Step 2 — Server action (`apps/erp/src/lib/actions/expense.actions.ts`)

```ts
export async function createExpense(input: unknown) {
  const actor = await requireActor()                    // 1. from the SESSION, not the args
  const data  = createExpenseSchema.parse(input)        // 2. zod, always
  await authorize(actor, "expense.create", { storeId: data.storeId })  // 3. server-side gate
  return expenseService.create(actor, data)             // 4. delegate — and stop
}
```

Four lines of real work. Notice `actor` is *derived*, never accepted — that is the fix for
v1's client-asserted identity (§7.1).

### Step 3 — Service (`src/lib/services/expense/create.ts`)

Everything below happens inside **one transaction**:

```ts
return db.transaction(async (tx) => {
  await assertPeriodOpen(tx, data.storeId, data.date)     // business rule
  await assertDocumentPresent(data)                        // no posting without a document

  const expense = await expenseRepo.insert(tx, { ...data, createdBy: actor.personId })

  const pattern = postingPatterns.cashExpense(expense)     // ← from POSTING-PATTERNS.md
  //   Dr 6200 Rent          5,000
  //       Cr 1110 Cash on hand — cashier   5,000

  await ledger.postEntry(tx, {
    sourceType: "expense", sourceId: expense.id,
    idempotencyKey: `expense:${expense.id}:post`,
    lines: pattern.lines,
  })

  await audit.write(tx, { actor, action: "expense.create", entity: "expense",
                          entityId: expense.id, after: expense })
  return expense
})
```

The posting pattern is **looked up, not invented here.** One canonical pattern per event
(§16.10) — that is what stops two code paths posting the same thing differently.

### Step 4 — Postgres has the last word

At `COMMIT`, deferred constraint triggers check:

- Do the lines balance? (Σ debit = Σ credit)
- Are there at least two lines? *(no single-leg escape hatch — v1's core defect)*
- Is the period open?
- Are all accounts postable, and do the FKs resolve?

**If any fail, the whole transaction rolls back** — expense, journal, and audit row
together. There is no state where the expense exists but the posting does not.

That last sentence is the entire point of the re-platform.

---

## 3. The read path

Reads skip the service layer when there is no rule to apply:

```
  Server Component  →  repository (or a view)  →  Postgres
```

- **Simple lists and detail pages** query a repository directly, read-only.
- **Reports** query a **view** — `v_trial_balance`, `v_income_statement`,
  `v_account_balances`, `v_subledger_reconciliation`. The SQL lives in a migration, not in
  a page.
- **No projection documents.** v1 maintained summary docs by hand and they drifted. Here a
  report is a query; it cannot be stale.
- Reads are still authorized, and still store-scoped at the repository.

---

## 4. Background work

Three kinds, all sharing the same services — never their own private logic:

| Worker | Direction | Job |
|---|---|---|
| **Publisher** `src/lib/sync/publisher` | Postgres → Firestore | Pushes the hot set (roster, biometric templates, attendance config) into the read-only mirror. Version-stamped, idempotent |
| **Ingestor** `src/lib/sync/ingestor` | Firestore → Postgres | Drains the append-only inbox of offline punches. Idempotency key is a UNIQUE constraint, so replay is a silent no-op. Adjudication (late/OT/hours) happens **here**, server-side, never on the device |
| **Crons** `src/app/api/cron/*` | — | The 9 scheduled jobs, called by Cloud Scheduler. Each authenticates, then calls a service |

**Rule:** a cron or worker calls the *same* service function the UI does. If a background
job has its own copy of a posting rule, that is a second writer, and one of them is wrong.

---

## 5. Folder map

```
src/
  app/                    routes + pages (ported from v1)
  components/             UI (ported)
  lib/
    actions/              thin server actions          ← authorize, validate, delegate
    services/             business rules + transactions ← the real backend
      ledger/               postEntry, reverseEntry
      expense/  ap/  ar/  inventory/  payroll/ ...
    posting/              POSTING-PATTERNS as code — one per business event
    db/
      repo/               the ONLY place SQL is written
      client.ts           connection + transaction helper
    sync/                 publisher (mirror) + ingestor (inbox)
    auth/                 requireActor(), authorize()  ← one module, no exceptions
    money.ts  datetime.ts validation/
db/
  schema/                 Drizzle tables — the ONLY table definitions
  migrations/             committed SQL, forward-only, never edited after apply
  seed/                   reference data, idempotent by code
etl/                      Firestore → Postgres, read-only on the source
tests/
  golden/                 captured real inputs/outputs (operational parity)
  invariants/             the ten accounting invariants, run in CI
  worked-examples/        hand-computed postings, written before the code
```

---

## 6. What is actually different from v1

| | v1 | Shareat System |
|---|---|---|
| Business logic | 144 action files talking to Firestore directly; rules scattered across them | Services own rules; actions are 4 lines |
| SQL / data access | Firestore calls inline in actions, pages, and hooks | One repository layer; nothing else touches the DB |
| Transactions | Hand-rolled `runTransaction`, and a **fake distributed transaction** across stores | One real ACID transaction. Cross-store is just two rows |
| Who is acting | Client-supplied parameter on ~24 actions | Derived from a signed session, server-side |
| Authorization | Client gates, ad hoc per-page checks, store-membership rules | One `authorize()` call at the top of every action |
| Invariants | Held by remembering | Held by database constraints |
| Reports | Hand-maintained projection docs + scan lists | Views over the ledger |
| Money | JS float, rounded at every write | `numeric`, exact |
| A failed write | Can leave a partial state | Rolls back whole |

---

## 7. The rules a new contributor must not break

1. An action never writes SQL. A repository never enforces a rule.
2. `authorize()` is the first statement of every action. No exceptions.
3. The actor comes from the session. Never from a parameter.
4. Every mutation is in one transaction, or documents why it cannot.
5. Posting patterns are looked up from `src/lib/posting/`, never written inline.
6. Every store-scoped query filters on `store_id` in the repository.
7. Derived numbers are views. Never a hand-maintained summary row.
8. `undefined` never reaches the database — normalise with `?? null` at the repo boundary.
9. No `toLocaleString` family in server code without an explicit timezone.
10. If two code paths write the same table, stop — one of them is wrong.
