# 29 — RLS enforcement assessment (DEF-209)

> **Read-only pass.** No code, no migration, no schema change. Method: bible §1.2d / RULES §3 —
> what exists at source → the goal it was built for → the measured state → the options.
> Every claim carries a `file:line`. The live probe ran against the lane database
> `shareat_test_t228` only; every write inside it was rolled back.
>
> **Commissioned by:** Ian's decision of 2026-09-07 (bible §13 row 180's bundled decisions;
> `docs/DEFECTS-REGISTER.md:279`) — *"a dedicated assessment, neither a reflex fix nor a defer."*

---

## 0. Verdict first (RULES §4 / `/research-evaluate-propose`)

**DEF-209's premise is wrong, and the corrected picture is more actionable than the original.**

RLS is not a dormant net with zero production callers. It is **built, wired into 310 request
paths, and exercised by 68 of the 99 integration test files on every CI run**. The probe proves
policies bite the moment the app switches role, which it does on essentially every authenticated
screen.

What is actually true is narrower and sharper:

| | |
|---|---|
| **Verdict** | **Build the small version, not the big one.** Do **not** route every `transaction()` through a principal. Close the **34 authenticated request paths that skip it**, and add **one line to an existing guard test**. |
| **The real defect** | **5 server actions read `orgId` out of client-supplied `FormData`** and run on the 3 files that never take a principal — so the one control that would refuse a forged tenant id is not armed there. Filed below as **DEF-210**. |
| **Cost of the recommendation** | ~**1.5–2 days**, no migration, no schema change. |
| **Cost of the maximal option** | ~**8–13 days** and a new class of loud production failure, for defence the store gate already provides on 188 of 265 `authorize()` calls. |
| **What gets worse if nothing is built** | A staff member with `transfer_stock` or `apply_supplier_credit` can post journal entries into another organisation's books. Padre Garcia is a live franchise with a separate owner (`0011_row_level_security.sql:4-6`). |

⛔ **One thing genuinely cannot be answered from this repo** — the role production connects as.
It lives in `/srv/shareat-shared/.env.local` on the droplet, which no agent can read, and no
provisioning file creates a role. **§7's FOR IAN block carries the one read-only query Ian runs
himself.** Until it is answered, *both* failure directions are open, and they are opposite.

---

## 1. What exists at source

### 1.1 The machinery

| Piece | Where | What it is |
|---|---|---|
| `app_current_org()` / `app_principal_kind()` | `packages/db/migrations/0011_row_level_security.sql:38-48` | `STABLE` SQL functions reading transaction-scoped GUCs |
| Role `shareat_app` | `0011_row_level_security.sql:57-63` | **NOLOGIN by design** — sessions connect as the owner and `SET LOCAL ROLE` into it |
| Policies | `0011` and every later migration | `USING (org_id = app_current_org()) WITH CHECK (…)`, no `TO` clause, so they apply to `PUBLIC` |
| The registry | `packages/db/src/rls/registry.ts` | **125 tables** — `org_column` 92, `derived` 27, `self` 1, `system_only` 5. An unlisted table **fails the build** (`tests/unit/rls-registry.test.ts`) |
| The canonical helper | `packages/db/src/rls/principal.ts:38,69` | `applyPrincipal` / `withPrincipal` |
| The helper actually used | `apps/erp/src/app/expenses/lib.ts:134-141` | `withOrgPrincipal` — `set local role` + two `set_config` inside one Drizzle transaction |

### 1.2 ⭐ Why `withPrincipal` has no callers — and why that is *not* the defect DEF-209 described

`withPrincipal` (`principal.ts:69-77`) takes `sql.begin` — a **postgres.js** handle. The
application's `transaction()` (`packages/db/src/client.ts:80-82`) is **Drizzle's**. The two are
type-incompatible, so `withPrincipal` is unusable from any application code as written.

The result is not an unused feature — it is **the same five-line idiom re-implemented three times
in source and 68 times in tests**:

| Copy | Location |
|---|---|
| The app helper | `apps/erp/src/app/expenses/lib.ts:136` |
| The scheduler's package-local copy | `packages/domain/src/scheduler/index.ts:348`, and again at `:684`, `:725` |
| The canonical, uncallable one | `packages/db/src/rls/principal.ts:43` |
| Test `asOrg` helpers | 68 integration test files (`packages/db/tests/integration/rls.test.ts:37`, …) |

The scheduler's own comment already names this (`scheduler/index.ts:317-323`): *"this is the third
independent copy of an identical five-line idiom, which might be worth centralising in
`@shareat/db` someday."* **DEF-209 grepped for the canonical name, found two files, and concluded
there were no callers. There are 310.**

### 1.3 The real wiring, counted

Commands are in `§8 Method`, so every number here is reproducible.

| | Count |
|---|---|
| `withOrgPrincipal(` invocations — **RLS enforced** | **310** (308 in `apps/erp`, 2 in `packages/domain/src/scheduler`) |
| Plain `transaction()` invocations in `apps/erp/src` — **RLS off** | **38** |
| … of which are legitimately pre-authentication | **4** (`sign-in/actions.ts:36,53`, `sign-in/page.tsx:30`, `lib/session.ts:62`) |
| … leaving **authenticated paths running with no principal** | **34** |
| Request-path call sites passing `null` for `tx` (so the domain opens its own unprincipalled transaction) | **6** (`cutover/actions.ts:42,59,76,93,109`; `fixed-assets/actions.ts:149`) |
| `transaction()` invocations in `packages/domain/src` | **123** across 31 files — but **150 of the 154** `tx: Tx \| null` signatures are `if (tx) return run(tx)` fallbacks that the app path does not take |
| `transaction()` in `packages/auth/src` | **6**, all in `sessions.ts` — **structurally cannot have a principal** (see §5.2) |
| Scripts with any role switch | **0 of 15** (`scripts/*.ts`) |

---

## 2. The goal RLS was built for (bible §1.2d step 2)

Migration `0011`'s own header states it, and it is worth quoting because it is the bar every
option below is measured against — not *"have RLS"*, but this:

> *"`WHERE org_id = :org` on every query works until the one query that forgets, and that query
> WILL exist. A franchise with a separate owner is already live (Padre Garcia), so the failure
> mode is not a broken page — it is showing one business owner another business owner's books."*
> — `0011_row_level_security.sql:3-6`

Bible §13 row 112 says the same and adds the binding half: *"application discipline, and
discipline is not a control."*

⭐ **The goal is therefore explicitly about the query nobody reviewed** — a report, a script, a fix
at 11pm. Any option that only re-checks the queries we already read has not met it. Keep that in
view at §6: it is what separates option (b) from option (c).

The migration also names, in advance, the three ways this goes silently wrong
(`0011:8-24`). **Trap #1 is the one this assessment is about:** *"A SUPERUSER BYPASSES RLS
ENTIRELY… Running the app as `postgres` disables every policy below while all the tests still
pass."*

---

## 3. The measured state — Q1: does the connecting role bypass RLS?

**Answer: yes, and it does not matter on 310 of 344 request paths, because they switch role.**

Both facts are true simultaneously, and holding only one of them produces a wrong conclusion.
That is why the head-start hypothesis (*"the app runs as a superuser, so RLS is entirely off"* —
`docs/HANDOFF-TODAY.md:78-84`) is half right.

### 3.1 Local and CI connect as `postgres` — confirmed

`.env.local` was parsed with `new URL()` (never string surgery — the password contains `@`) and
**no secret was printed**:

```
DATABASE_URL      -> user=postgres  host=localhost  port=5435  db=shareat_dev
TEST_DATABASE_URL -> user=postgres  host=localhost  port=5435  db=shareat_test
```

CI is the same, in the clear, in the repo:

```yaml
# .github/workflows/ci.yml:37-38
DATABASE_URL:      postgresql://postgres:postgres@localhost:5435/shareat_test
TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5435/shareat_test
```

### 3.2 The probe, verbatim (redacted; run on `shareat_test_t228`, all writes rolled back)

```
### A. who am I (connecting role, no SET ROLE)
[ { "current_user": "postgres", "session_user": "postgres",
    "current_database": "shareat_test_t228",
    "pg": "PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit" } ]

### B. role attributes — connecting role and the app role
[ { "rolname": "postgres",     "rolsuper": true,  "rolbypassrls": true,  "rolcanlogin": true  },
  { "rolname": "shareat_app",  "rolsuper": false, "rolbypassrls": false, "rolcanlogin": false } ]

### C. ownership of five org-scoped tables
[ { "table": "journal_entries", "owner": "postgres", "rls_enabled": true, "rls_forced": true },
  { "table": "journal_lines",   "owner": "postgres", "rls_enabled": true, "rls_forced": true },
  { "table": "organizations",   "owner": "postgres", "rls_enabled": true, "rls_forced": true },
  { "table": "persons",         "owner": "postgres", "rls_enabled": true, "rls_forced": true },
  { "table": "stores",          "owner": "postgres", "rls_enabled": true, "rls_forced": true } ]

### D. ENABLE / FORCE / POLICY counts across public
[ { "enabled": "125", "forced": "125", "policies": "120",
    "policies_to_public": "120", "enabled_but_no_policy": "5" } ]

### E. distinct table owners in public
[ { "owner": "postgres", "tables": "125" } ]

### F1 connecting role (postgres), NO role switch, NO GUC
[ { "visible": 2 } ]

### F2 SET LOCAL ROLE shareat_app, NO GUC (expect 0)
[ { "current_user": "shareat_app", "visible": 0 } ]

### F3 role shareat_app + app.org_id = ORG A (expect 1, A only)
[ { "current_user": "shareat_app", "guc_org": "01a07a05-e458-70dc-ab59-04951a2dfc19",
    "visible": 1, "names": "PROBE-A-STORE" } ]

### F4 can shareat_app WRITE another org row? (expect refusal)
[ { "result": "REFUSED", "sqlstate": "42501",
    "message": "new row violates row-level security policy for table \"stores\"" } ]

### F5 back as connecting role, no GUC (expect 2 again)
[ { "current_user": "postgres", "visible": 2 } ]

### G. after rollback — probe rows gone?
[ { "leftover": 0 } ]
```

A second probe checked the privileges the policies assume:

```
### H. tables shareat_app may NOT select                                    []
### I. tables shareat_app may NOT insert                                    []
### J. sequences shareat_app may NOT use                                    []   (2 sequences exist)
### L. tables with RLS NOT enabled                                          []
### M. app_current_org / app_principal_kind executable by shareat_app       true / true
```

### 3.3 What the probe settles

1. **The connecting role is a superuser and holds `BYPASSRLS`** (B). Every table is owned by it
   and `FORCE` is set on all 125 (C, D, E) — so `FORCE` is doing its job and ownership is *not*
   the bypass. The bypass is the superuser attribute, exactly trap #1.
2. **`SET LOCAL ROLE shareat_app` fully re-arms RLS.** Postgres evaluates row security against
   `current_user` *after* `SET ROLE`, and `shareat_app` is neither superuser nor `BYPASSRLS`
   (B). F2/F3/F4 prove it end to end: **0 rows with no GUC** (default-deny works), **exactly the
   principal's org with the GUC** (isolation works), and a **cross-org write refused with
   SQLSTATE 42501** (`WITH CHECK` works).
3. **The plumbing is complete.** No table, sequence or function is missing a grant to
   `shareat_app` (H/I/J/M), and no table is missing RLS (L). Switching the connecting role would
   not hit a privilege wall.

⭐ **The registry and the live database agree exactly, which is worth stating because it is the
one thing nobody had checked.** 125 registry entries ↔ 125 live tables; 5 declared `system_only`
(`audit_log`, `etl_runs`, `etl_source_documents`, `etl_quarantine`, `etl_reconciliation`) ↔ 5 live
tables RLS-enabled with no policy (`0011:142-165`); 0 tables without RLS. The registry is telling
the truth about the database.

⚠️ **Two head-start figures were migration-file statement counts, not live state.** The handoff
says *126 ENABLE / 127 FORCE / 128 CREATE POLICY*; live it is **125 / 125 / 120** (120 = 125 minus
the 5 deliberately policy-less). Both are correct about different things and should not be quoted
interchangeably.

### 3.4 ⛔ The claim that must be corrected: CI *does* exercise policies

The brief for this task stated that *"the 2489-test suite and every CI run have never exercised a
single policy."* **That is false, and the evidence is unambiguous.**

- CI runs `npm run test:integration` against real Postgres — `.github/workflows/ci.yml:68-69`.
- **68 of the 99 integration test files switch to `shareat_app`** before touching data, via a
  local `asOrg` helper (`packages/db/tests/integration/rls.test.ts:32-41` is the canonical shape).
- `rls.test.ts` asserts the isolation invariants directly, including
  *"⭐ invariant 8 — NO principal returns ZERO rows, never everything"* (`:98`),
  *"invariant 6 — org A cannot INSERT a row carrying org B's id"* (`:80`),
  *"invariant 9 — FORCE ROW LEVEL SECURITY is on for every RLS table"* (`:106`) and
  *"⭐ invariants 11 and 12 — the principal does not survive onto the next transaction"* (`:158`).

Invariant 8 **can only pass if RLS is actually enforced**. If the suite ran with policies
bypassed it would see every row and fail. It passes — therefore policies are live under the role
switch, on every CI run.

I did not re-run the suite (lane discipline forbids `npm run test:integration`); the 2489 figure
is quoted from `docs/HANDOFF-TODAY.md` unverified. The *structure* above is read from the files
and is independent of that number.

---

## 4. Q2 — is the net load-bearing today?

**Answer: at 5 call sites, yes — and those 5 are exactly the ones not wearing it.** Everywhere
else it is a genuine second layer over a service layer that is doing its job.

### 4.1 Method, and its honest limits

A script (`§8`) read all **63** modules in `packages/db/src/repo` (20,797 lines), split them into
**707 exported functions**, stripped comments so prose could not be mistaken for a predicate, and
asked of each: does it touch a table the registry marks org-scoped, and if so does its body carry
`orgId` / `org_id` / `app_current_org()` anywhere?

| | |
|---|---|
| Exported repo functions swept | **707** |
| Touching ≥1 org-scoped table | **668** |
| Carrying an org predicate | **460** |
| **No org predicate in the body** | **208** |

⚠️ **208 is not 208 leaks, and reporting it as such would be the adjective-instead-of-number
failure in reverse.** A `derived` table (27 of the 125) is *designed* to carry no `org_id` and to
be reached through a parent — for those, the repo layer is not the enforcement point and never
was. So the 208 were classified by what they *are* keyed on:

| Class | Count | Reading |
|---|---|---|
| **parent-keyed** (`entryId`, `expenseId`, `remittanceId`, …) | 80 | The parent was fetched org-scoped by the caller; the `derived` policy is the DB-side guard |
| **store-keyed** | 35 | `authorize(…, { storeId })` independently proves store ∈ actor's org (§4.2) |
| **pk-keyed** (own `id`) | 37 | Reached only after an org-scoped fetch |
| **unkeyed** | 56 | Read individually — most are inserts whose `input` object carries `org_id`, plus a small number of deliberately org-wide sweeps |

**What I hand-verified, precisely:** every function in the *intersection that matters* — the 34
unprincipalled authenticated request paths and the 6 `null`-tx sites, plus the domain entry point
each reaches, plus every "unkeyed" read whose key comes from client input. I did **not** hand-read
all 208; the parent-keyed and pk-keyed classes were sampled, not exhausted. That is the limit of
this pass, stated so it can be challenged.

The deliberately-unscoped ones are documented as such at source and are correct:
`files.ts:73-77` (*"Deliberately NOT org-scoped — the sweep runs as the `system` principal"*),
`inbox-quarantine.ts:120-127` (unattributed rows have no store by construction).

### 4.2 Why the service layer is genuinely holding — and where it stops

`authorize()` (`packages/auth/src/authorize.ts:75-131`) checks three axes. Axis 2 is the one doing
the tenant work:

```ts
// authorize.ts:122-124
const storeInOrg = await accessRepo.storeBelongsToOrg(tx, ctx.storeId, actor.orgId);
if (!storeInOrg) throw new AuthorizationError(`authorize: store … does not belong to org …`);
```

⛔ **But axis 1 is a no-op unless the caller opts in:**

```ts
// authorize.ts:83-86
const resourceOrgId = ctx.orgId ?? actor.orgId;
if (resourceOrgId !== actor.orgId) throw new AuthorizationError(…);
```

With no `ctx.orgId`, this compares `actor.orgId` to itself. Counted across `packages/domain/src`,
`packages/auth/src` and `apps/erp/src`:

| `authorize()` call sites | 265 |
|---|---|
| passing `storeId` — axis 2 bites, tenant proven | **188** |
| passing an explicit `orgId` — axis 1 bites | **7** (all 7 also pass `storeId`) |
| passing an empty `{}` — org-scoped capability, **resource org never proven** | **53** |

So on 188 sites the service layer really is the control bible §7 rule 4 describes. On the 53
empty-`{}` sites the org gate is whatever the caller did *before* calling — and under a principal
that is fine, because RLS is the backstop. **Without a principal, there is no backstop.**

### 4.3 ⛔ The finding: five server actions take `orgId` from the client

Every place an org id is read from client input in the whole app:

| | |
|---|---|
| `apps/erp/src/app/inventory/returns/actions.ts:22` | `const orgId = str(fd, 'orgId');` → `recordReturn` |
| `apps/erp/src/app/inventory/returns/actions.ts:63` | `const orgId = str(fd, 'orgId');` → `refundSupplierCredit` |
| `apps/erp/src/app/inventory/transfers/actions.ts:30` | `const orgId = str(fd, 'orgId');` → `saveDraft` / `transferNow` |
| `apps/erp/src/app/trade/returns/actions.ts:22` | `const orgId = str(fd, 'orgId');` → `recordCustomerReturn` |
| `apps/erp/src/app/trade/returns/actions.ts:61` | `const orgId = str(fd, 'orgId');` → `applyCredit` (`applyCreditAction`, `:59-77`) |

The value is a hidden form field the browser owns:

```tsx
apps/erp/src/app/inventory/returns/page.tsx:149   <input type="hidden" name="orgId" value={actor.orgId} />
apps/erp/src/app/inventory/transfers/NewTransferForm.tsx:26  <input type="hidden" name="orgId" value={orgId} />
apps/erp/src/app/trade/returns/page.tsx:186       <input type="hidden" name="orgId" value={actor.orgId} />
```

⭐ **These 5 sites live in exactly 3 files, and those 3 files contain zero `withOrgPrincipal` calls
and 10 plain `transaction()` calls between them.** The overlap is total, not partial:

```
apps/erp/src/app/inventory/returns/actions.ts    -> withOrgPrincipal:0  plainTransaction:3
apps/erp/src/app/inventory/transfers/actions.ts  -> withOrgPrincipal:0  plainTransaction:4
apps/erp/src/app/trade/returns/actions.ts        -> withOrgPrincipal:0  plainTransaction:3
```

**And nothing downstream re-checks it.** A repo-wide search for a comparison of an input org
against the actor's org finds **four** sites in the entire codebase —
`cutover/opening.ts:162`, `payroll/separation.ts:48,107`, `staff/actions.ts:193` — and **none of
them is on these paths**. The five entry points reached are `recordReturn` and
`refundSupplierCredit` (`packages/domain/src/stock/supplier-returns.ts:75, 361`), `saveDraft` and
`transferNow` (`packages/domain/src/stock/transfers.ts:159, 88`), `recordCustomerReturn`
(`packages/domain/src/trade/returns.ts:158`) and `applyCredit`. Every one gates on the store only:

```ts
// packages/domain/src/stock/supplier-returns.ts:361-378  (refundSupplierCredit)
await authorize(tx, input.actor, 'apply_supplier_credit', { storeId: input.storeId });
…
const balance  = await apRepo.advancesPositionOf(tx, input.orgId, input.supplierId);
const supplier = await apRepo.getSupplierById(tx, input.orgId, input.supplierId);
const account  = await moneyAccountsRepo.getById(tx, input.orgId, input.moneyAccountId);
const posted   = await postEntry(tx, { orgId: input.orgId, … });
```

`authorize` proves **`storeId` belongs to the *actor's* org**. Every read and the posting then use
**`input.orgId`, which came from the form.** `transferNow` is the same shape and needs no
victim-owned ids at all — `packages/domain/src/stock/transfers.ts:89` authorizes on the store,
then writes `orgId: input.orgId` onto `stock_transfers` (`:108`) and both `stock_movements`
(`:127`, `:141`).

**Concrete failure:** a staff member holding `transfer_stock` at their own store posts a hidden
field naming the franchise's org id. The transfer, both stock movements and the journal entry are
written into **another organisation's books**, using the attacker's own store and items. Under a
principal this is refused before the first write — F4 above is literally this refusal
(`42501: new row violates row-level security policy`). On these three files there is no principal.

⭐ **This is DEF-064's bug, on the write side.** `tests/unit/no-ungated-read-surface.test.ts:6-10`
records the original: *"`GET /reports/trial-balance?org=<uuid>` rendered any organisation's books
to a visitor who had never signed in"* — a client-supplied **org id**, on a read. The guard built
afterwards, `tests/unit/no-client-supplied-actor.test.ts`, scans for a client-supplied **person**:

```ts
// tests/unit/no-client-supplied-actor.test.ts:37
const ACTOR_FIELDS = ['actorPersonId','actingPersonId','actorUid','actorId','currentPersonId'];
```

**`orgId` is not in that list.** The structural guard exists for the identity half of bible §7.1
and has no counterpart for the tenancy half — which bible row 112 calls the more consequential of
the two. Adding one string to that array is a one-line change that fails immediately on all five
sites; it is the cheapest half of the recommendation in §6.

### 4.4 The rest of the sweep — what is clean

- **Raw `getSql()` callers: 4 total**, and none is a tenant surface — the client definition
  (`client.ts:46`), `apps/erp/src/app/api/health/route.ts:58` (`select 1 as ok`), and two tests.
- **Scripts: 0 of 15 switch role** (`scripts/*.ts`) — correct and deliberate. They are the
  `system` principal by design (`principal.ts:33-36`; `packages/domain/src/organizations/index.ts:33-40`
  states it explicitly for `bootstrap-org`).
- **The `null`-tx request paths defend themselves.** `removeOpeningFigure` takes an `entryId`
  straight from the form and checks `entry.orgId !== actor.orgId` (`cutover/opening.ts:162`);
  `postOpeningBalances` uses `actor.orgId` throughout (`:199-204`).
- **The fetch-then-authorize shape is sound.** `dispatch`/`receiveTransfer`/`voidTransfer`
  (`stock/transfers.ts:180-183, 226-229`), `voidReturn` (`supplier-returns.ts:269-271`),
  `voidCustomerReturn` (`trade/returns.ts:513-515`) all fetch by id with no org predicate, then
  `authorize(…, { storeId: row.storeId })` — which refuses a cross-org row via axis 2. The
  residual is an **existence oracle** (*"transfer X does not exist"* vs an authorization error),
  which is information disclosure, not data disclosure. Worth a line in §9, not a defect row.

---

## 5. Q3 — what would routing every `transaction()` through a principal cost?

### 5.1 The mechanical cost, measured not asserted

`applyPrincipal` (`principal.ts:38-59`) issues, per transaction: `SET LOCAL ROLE`, then
`set_config('app.principal_kind')`, then `set_config('app.org_id')`, plus `app.person_id` when
present — **3 to 4 extra round trips before the first real statement.** Measured on the lane DB,
200 iterations after warm-up:

```
plain transaction, no principal (today)              1.065 ms/tx
transaction + SET LOCAL ROLE + 2 set_config          2.160 ms/tx
same, but the three folded into ONE round trip       1.341 ms/tx

principal overhead, 3 round trips : +1.094 ms/tx  (103% on an otherwise trivial tx)
principal overhead, 1 round trip  : +0.276 ms/tx  ( 26%)

count(stores)       as owner 0.855 ms  ->  as shareat_app 1.463 ms
count(journal_lines) as owner 0.792 ms  ->  as shareat_app 1.503 ms
```

⚠️ **Read these as a floor, not a forecast.** The lane DB has `stores=0, journal_lines=0`, so the
per-query figures measure policy *setup*, not policy *evaluation* at scale. The number that
travels is the round-trip one: **+1.1 ms per transaction, reducible to +0.28 ms** by sending the
three statements as one string. Against a Manila→SGP1 managed-Postgres RTT this is the dominant
term, and it is the one thing worth engineering if the maximal option is ever chosen.

⭐ The `derived` policies are the shape to watch at scale: `journal_lines`'s policy is an
`EXISTS (SELECT 1 FROM journal_entries …)` **per row** (`0011:130-133`). On an empty table that is
free. On a year of ledger it is a correlated subquery on the hottest table in the system, and
nobody has measured it with data. **Naming it as unmeasured is the honest answer** (§7).

### 5.2 What has no principal and would break

| Surface | Sites | Can it take an org principal? |
|---|---|---|
| **Sign-in / session resolve** (`packages/auth/src/sessions.ts:68,124,189,228,246,287`) | 6 | ⛔ **No, structurally.** The org is *the output* of the credential lookup, not an input. `findActiveCredentialByLookupHash` (`repo/sessions.ts:38`) searches `person_credentials` by a store-scoped hash before any org is known. A principal here is a chicken-and-egg. |
| **Store picker on the sign-in page** (`sign-in/page.tsx:30`) | 1 | ⛔ No — pre-authentication by definition. |
| **The 15 scheduler / job / seed scripts** | 15 files | ⚠️ Only per-org, and only after a `system` lookup. `scheduler/index.ts:326-344` already documents the correct two-phase shape and warns that getting it backwards *"either has RLS silently return nothing… or lets the ingest step see across orgs."* |
| **`bootstrap-org`** | `scripts/bootstrap-org.ts` | ⛔ No. `organizations/index.ts:22-28`: *"There is no principal before the organization exists… Do not 'fix' this by adding one."* |
| **Migrations** | `npm run db:migrate` | ⛔ No — must remain the owner. |
| **Integration tests** | 68 files already switch; 31 do not | Those 31 would each need an `asOrg` wrapper. |

⛔ **The failure direction matters more than the count.** A path that loses its bypass without
gaining a principal does not leak — it returns **zero rows** (probe F2). Loud, not dangerous, and
that is by design (`0011:20-24`). But "loud" means *the screen breaks in production*, and the 34
unprincipalled request paths are ordinary screens: transfers, returns, low-stock, discrepancies,
expenses, sales-days, AP invoices.

### 5.3 ⚠️ The production trap this creates — the reason §7 exists

Production has **never had an organisation** (`docs/ops/README.md:31-34`: *"Production has ZERO
organizations"*). So **no production read path has ever exercised its own RLS behaviour.** The
moment Ian runs `bootstrap-org` and staff start working, one of two opposite things happens, and
which one depends entirely on the unread `.env.local`:

| If the production role **has** superuser/`BYPASSRLS` | If it **does not** |
|---|---|
| Everything works. The 5 client-`orgId` sites of §4.3 are **live and exploitable**. | The 310 principal paths work. The **34 unprincipalled paths return zero rows** and those screens break on day one of the pilot. |

**Neither outcome is acceptable to discover during the pilot**, and the recommendation in §6
closes both at once — which is why it is a single ~2-day piece of work rather than two.

---

## 6. The options

Per bible §3.6 guard 3, what we are **not** adopting is stated with its reason, not omitted.

### Option A — a principal on every request path, plus a service principal for jobs

Route all 34 remaining authenticated paths and the 123 `packages/domain` fallbacks through a
principal; give scripts an explicit `system` principal; wrap the 31 remaining test files.

- **Effort: 8–13 days.** ~157 call sites, each needing its org determined at the boundary; 31
  test files; a new failure mode (zero rows) on every path that is missed; the `derived`-policy
  cost at ledger scale is unmeasured (§5.1).
- **Buys:** the §2 goal in full — the forgotten query is caught even when nobody reviewed it.
- ⛔ **NOT RECOMMENDED as the next step.** It is the right *destination*, but adopting it now
  spends a fortnight to defend 188 `authorize()` sites that are already defended (§4.2), and
  pays the whole risk before the pilot has a single organisation. It also cannot be validated:
  with production empty, a regression here would surface in front of staff, not in CI.

### Option B — a non-superuser app role in production only, local unchanged

Create a login role without `BYPASSRLS` in production; leave local and CI as `postgres`.

- **Effort: 1–2 days** (a role, a rotated `DATABASE_URL`, a smoke pass). No migration —
  the grants already exist and are complete (probe H/I/J/M).
- **Buys:** `FORCE` finally bites in the one environment that matters.
- ⛔ **NOT RECOMMENDED, and this is the important rejection.** It makes production the *only*
  place the enforcement is real, so **every one of the 34 unprincipalled paths breaks in
  production and nowhere else** — a green CI shipping a broken screen, which is the exact failure
  bible §9's Definition of done and RULES §2's *"a green build and green tests have already
  shipped an app that could not start"* exist to prevent. It also inverts §5.3's table into the
  right-hand column deliberately, without first fixing the 34.
- ⭐ **It becomes the correct next step the moment Option C is done.** Sequenced after, it is
  cheap and safe. Sequenced now, it is an outage.

### Option C — close the gap, arm the guard, leave the net as documented defence ⭐ RECOMMENDED

1. **Stop trusting a client-supplied org id** (the actual defect, §4.3). Delete the 5 `str(fd,
   'orgId')` reads and the 3 hidden fields; use `actor.orgId`. ~1 hour.
2. **Add `'orgId'` to `ACTOR_FIELDS`** in `tests/unit/no-client-supplied-actor.test.ts:37` — or a
   sibling `TENANT_FIELDS` array if the test's own prose should stay about actors. One line;
   fails on all 5 sites today, and on the sixth nobody has written yet. **This is the piece that
   meets §2's "the query nobody reviewed" bar** — structurally, not by discipline.
3. **Wrap the 34 unprincipalled authenticated paths in `withOrgPrincipal`.** Mechanical; the
   helper exists and 310 call sites show the shape. ~1 day.
4. **Centralise the idiom** — one exported helper in `@shareat/db` that works with Drizzle's
   `transaction()`, replacing the three source copies. The scheduler comment already asks for
   this (`scheduler/index.ts:322-323`). Fold the three statements into one round trip while
   moving it (+0.28 ms instead of +1.1 ms, §5.1). ~2 hours.
5. **Add a guard test** that no file under `apps/erp/src/app/**/actions.ts` calls `transaction(`
   directly — with the sign-in exemptions listed, in the confession style
   `no-client-supplied-actor.test.ts:40` already uses. ~2 hours.

- **Effort: 1.5–2 days**, no migration, no schema change, no new failure mode. Every step is
  testable on a lane DB before production has data.
- **Buys:** the real defect closed; the 34 paths brought under the net that already protects the
  other 310; §5.3's trap disarmed in *both* directions; and Option B reduced to a one-day config
  change afterwards.
- **Deliberately out of scope:** the 123 `packages/domain` `tx | null` fallbacks (150 of 154 are
  unreachable from the app path — chasing them is motion, not risk reduction); the 31 test files
  without `asOrg`; and the `derived`-policy performance question, which needs data to answer and
  should be measured after cutover, not guessed at now.

**Recommendation: Option C now; Option B immediately after, before the pilot takes real
transactions; Option A only if a third organisation or an external-customer portal
(ADR-008 §10) makes the blast radius materially larger.**

---

## 7. FOR IAN

**Plain language: what we found, and the one thing only you can settle.**

**The good news, and it corrects what I reported last time.** I told you row-level security was
"built but unplugged, with no production callers." **That was wrong, and I should say so plainly.**
I searched for the wrong function name. Security *is* switched on across 310 places in the app —
essentially every screen — and 68 of our 99 database test files prove it works on every CI run. I
proved it live too: with the safety net on, one organisation sees exactly its own rows, sees
nothing with no identity set, and is **refused outright** when it tries to write into another
organisation's books.

**The bad news, which is smaller but real.** Three screens — **stock transfers, supplier returns
and customer returns** — send the *organisation's id in a hidden field in the web page*, and the
server believes it. Those same three screens are the ones that don't switch the safety net on. So
a staff member who can transfer stock could, by editing that hidden field, post entries into
**Padre Garcia's books** — the franchise with the separate owner. Nothing else in the code
re-checks it. This is the same mistake as DEF-064 (the report page that showed anyone's books from
a web address), this time on saving rather than viewing. I've written it up as **DEF-210**.

**The fix is small: about two days, no database change.** Stop reading the organisation from the
page, switch the safety net on for the 34 screens that skip it, and add **one word** to a test we
already have so this can never come back quietly.

⛔ **The one thing I cannot answer, and you can, in about a minute.** Production's database
password lives on the server in a file no agent can read, and nothing in the repo says which
*user* we connect as. That single fact decides which of two opposite things happens the day you
bootstrap the first organisation:

- if that user is a superuser → everything works, **and the three screens above are exploitable**;
- if it is not → the safety net bites everywhere, and **those 34 screens show empty pages** in
  production while working perfectly on our machines.

**Please run this on the droplet and paste me the one line it prints.** It reads nothing but your
own account's attributes, changes nothing, and reveals no password:

```bash
cd /srv/shareat && node -e "
const u = new URL(require('fs').readFileSync('.env.local','utf8')
  .split(/\r?\n/).find(l => l.startsWith('DATABASE_URL=')).slice(13).trim());
console.log('user =', u.username, '| host =', u.hostname, '| db =', u.pathname.slice(1));
"
```

then, to get the answer that actually decides it:

```bash
cd /srv/shareat && npx tsx -e "
import { getSql } from '@shareat/db/client';
const sql = getSql();
console.log(await sql\`select current_user, rolsuper, rolbypassrls
  from pg_roles where rolname = current_user\`);
await sql.end();
"
```

**Two decisions I need from you:**

1. **Approve Option C (~2 days)?** My recommendation. I'd also like to say plainly that I am
   recommending *against* the big version (rewiring everything, 8–13 days) — it is the right
   destination but the wrong month, because production has no data yet and a mistake would show
   up in front of staff instead of in CI.
2. **Sequencing.** I'd do Option C *before* you bootstrap the first organisation, because the fix
   is safe on an empty database and awkward on a live one. If the pilot date is fixed and tight,
   say so and I'll do steps 1 and 2 only (about two hours) and leave the rest.

Nothing in this document changed any file but this one. No code, no migration, no register edit —
those are proposed in §9 and §10 for the orchestrator to apply.

---

## 8. Method — every number above, reproducible

Scripts were written to the session scratchpad, never to the repo. All database work targeted
`shareat_test_t228`; the connection URL was built with `new URL()` and the pathname swapped, never
by string replacement (the password contains `@`). The one write block ran inside a transaction
that always threw to force rollback, and probe G confirms zero leftover rows. The cross-org write
test needed its own **savepoint** — an RLS refusal is a Postgres error that aborts the enclosing
transaction, so without one every later probe fails for the wrong reason.

```bash
# 310 withOrgPrincipal invocations (definition uses `<T>(`, so it is excluded)
grep -rn "withOrgPrincipal(" --include=*.ts --include=*.tsx apps packages scripts \
  | grep -v node_modules | grep -v "^\S*:[0-9]*: *\*" | grep -v "^\S*:[0-9]*:import" | wc -l

# plain transaction() invocations, by area — files that import it from the db client
grep -rln "import[^;]*\btransaction\b[^;]*from '@shareat/db" --include=*.ts --include=*.tsx apps packages scripts

# authorize() ctx shapes
grep -rnE "authorize\([^)]*storeId"  --include=*.ts --include=*.tsx packages/{domain,auth}/src apps/erp/src | wc -l
grep -rnE "authorize\([^)]*\borgId\b" --include=*.ts --include=*.tsx packages/{domain,auth}/src apps/erp/src | wc -l
grep -rnE "authorize\([^)]*,\s*\{\s*\}\s*\)" --include=*.ts --include=*.tsx packages/domain/src apps/erp/src | wc -l

# every client-supplied org id
grep -rnE "(str|num)\((fd|formData|f)\s*,\s*'orgId'\)|\.get\('orgId'\)" --include=*.ts --include=*.tsx apps/erp/src

# integration files that switch to the app role
grep -rl "set local role" --include=*.test.ts packages apps tests | grep -v node_modules | wc -l
```

⚠️ **Two traps hit while doing this, both worth recording, because both produced confident wrong
numbers that looked fine.**

**(1) A heredoc ate the regex escapes.** The first repo-sweep script was written through a Bash
heredoc, which mangled `\b` inside JavaScript template literals — `new RegExp(\`\\b${id}\\b\`)`
became a backspace character and matched **nothing**. The script reported *"0 functions touch an
org-scoped table"* and exited 0. **A guard that scans nothing looks exactly like a guard that
finds nothing.** Same family as the CRLF `.*$` landmine. Scripts with regex escapes must be
written with the file tool, not a heredoc.

**(2) A registry parser silently dropped 5 of 125 entries** — its `^ {2}key: \{ … ^ {2}\},$`
pattern could not span an entry whose `reason` is a multi-line string concatenation, so
`location_types`, `accounts`, `journal_lines`, `etl_source_documents` and `production_recipes`
were never swept. **This was caught in self-review, not by the script**, and it had already
produced two wrong published numbers: the Q2 totals (655/449/206 → **668/460/208**) and a claimed
registry-vs-database discrepancy that does not exist (§9 item 3). The conclusions did not move —
both newly-surfaced functions are parent-keyed `journal.ts:230, 365` — but they could have.

⭐ **The rule both trips imply, and it is the more useful output of this section than either
number:** *a sweep that reports a total must first be made to report a known non-zero control.*
Neither bug was detectable from its output; both were detectable in one line by asking the script
to prove it could see something it definitely should have seen.

---

## 9. Found in passing (RULES §13 row 164 — logged here, not filed; the orchestrator files)

1. **`withPrincipal` is type-incompatible with the app's own `transaction()`** —
   `principal.ts:69` takes postgres.js `sql.begin`, `client.ts:80` is Drizzle. The canonical
   helper cannot be called from application code, which is *why* the idiom is copied three times
   in source and 68 times in tests. Worth a defect row of its own (proposed as **DEF-211**, §10).
2. **An existence oracle across orgs.** `dispatch` (`stock/transfers.ts:181-182`), `voidReturn`
   (`supplier-returns.ts:269-270`) and `voidCustomerReturn` (`trade/returns.ts:513-514`) return
   *"X does not exist"* for a row that exists in another org, distinguishable from the
   authorization error a same-org row produces. Information disclosure only; the mutation is
   refused. Low severity, but it disappears for free under Option C step 3.
3. **✅ Not a finding, recorded because it was checked and is worth being able to cite:** the
   registry and the live database agree exactly — 125 entries ↔ 125 tables, 5 `system_only` ↔ 5
   policy-less, 0 tables without RLS. *(An earlier draft of this document claimed a one-table
   discrepancy. That was my parser's bug, not the registry's — see §8.)*
4. **The head start's 126/127/128** are counts of statements across migration files; live state is
   **125/125/120**. Both are correct about different things and should not be quoted
   interchangeably.
5. **`ALTER DEFAULT PRIVILEGES` in `0011:72` covers TABLES only, not SEQUENCES.** Checked and
   currently harmless — both sequences in the database are usable by `shareat_app` (probe J) — but
   a future table with a `serial`/identity column created by a *different* role than the one that
   ran `0011` would insert fine as owner and fail as `shareat_app`, appearing only on a
   principal-wrapped path.

---

## 10. Proposed edits — for the orchestrator to apply (RULES §1 rule 14: only the planner amends)

### 10.1 `docs/DEFECTS-REGISTER.md` — amend DEF-209's Disposition column

Append to the existing cell at `:279` (do not rewrite the Defect column — the original reasoning
is the record of what was believed, and §3.4/§1.2 correct it):

> ⛔ **ASSESSED 2026-09-07 — `docs/discovery/29-rls-enforcement-assessment.md`. The premise of
> this row is WRONG and is corrected there.** RLS is not dormant: `withPrincipal` has no callers
> because it is typed for postgres.js while the app's `transaction()` is Drizzle, so the identical
> idiom is re-implemented as `withOrgPrincipal` — **310 invocations** (`apps/erp/src/app/expenses/lib.ts:134`,
> `packages/domain/src/scheduler/index.ts:346`) — and **68 of 99 integration files** exercise the
> policies on every CI run (`packages/db/tests/integration/rls.test.ts:98` asserts default-deny and
> can only pass if RLS is live). **Q1: the connecting role is `postgres`, superuser + `BYPASSRLS`
> (proved live), but `SET LOCAL ROLE shareat_app` fully re-arms RLS — cross-org write refused,
> SQLSTATE 42501.** **Q2: 707 repo functions swept, 668 touch an org-scoped table, 208 carry no org
> predicate; classified, the real gap is 5 sites — see DEF-210.** **Q3: +1.1 ms/tx measured,
> reducible to +0.28 ms; the maximal rewire is 8–13 days and is recommended AGAINST for now.**
> ✅ **Recommendation: Option C (~2 days, no migration).** Ian to decide; one production probe is
> his alone (§7).

### 10.2 `docs/DEFECTS-REGISTER.md` §E — new row DEF-210

> | **DEF-210** | ⛔ | **Five server actions read `orgId` from client-supplied `FormData`, on the three files that never take an RLS principal — a cross-org write with nothing behind it.** `inventory/returns/actions.ts:22,63`, `inventory/transfers/actions.ts:30`, `trade/returns/actions.ts:22,61` each do `const orgId = str(fd, 'orgId')`, fed by a hidden field (`inventory/returns/page.tsx:149`, `NewTransferForm.tsx:26`, `trade/returns/page.tsx:186`). The value flows into `recordReturn`/`refundSupplierCredit`/`saveDraft`/`transferNow`/`recordCustomerReturn`, which gate on `authorize(…, { storeId })` — proving the STORE belongs to the **actor's** org — and then use `input.orgId` for every read and for `postEntry({ orgId: input.orgId })` (`stock/transfers.ts:89,108,127,141`; `supplier-returns.ts:361-378`). ⛔ **Nothing re-checks it:** a repo-wide search finds only 4 comparisons of an input org against `actor.orgId` (`cutover/opening.ts:162`, `payroll/separation.ts:48,107`, `staff/actions.ts:193`) and none is on these paths. `authorize()`'s axis 1 is a no-op unless the caller passes `ctx.orgId` (`authorize.ts:83-86`) — only **7 of 265** call sites do. ⭐ **Under a principal this is refused before the first write** (RLS `WITH CHECK`, 42501, proved live) — these 3 files hold **0** `withOrgPrincipal` calls and 10 plain `transaction()` calls. ⭐ **Same bug as DEF-064, on writes instead of reads**, and the guard built after DEF-064 does not cover it: `tests/unit/no-client-supplied-actor.test.ts:37`'s `ACTOR_FIELDS` scans for a client-supplied PERSON, never a client-supplied ORG. Found 2026-09-07 by lane A assessing DEF-209 | `reported` | **Option C step 1+2 of `docs/discovery/29-rls-enforcement-assessment.md`: use `actor.orgId`, delete the hidden fields, and add `'orgId'` to the guard's field list — one line that fails on all five today and on the sixth nobody has written yet.** ⚠️ Severity is bounded by the store gate — the attacker's own store must pass `authorize`, so this stamps another org's `org_id` on rows pointing at the attacker's store, and posts into that org's books. It is not a read of the victim's data except where a victim-owned id is also supplied. **It is still a cross-org write, which bible invariant 7 forbids and row 112 names as the whole reason RLS exists.** |

### 10.3 `docs/DEFECTS-REGISTER.md` §E — new row DEF-211

> | **DEF-211** | 🔸 | **The canonical RLS helper cannot be called by the application it was written for, so the idiom is copied 3× in source and 68× in tests.** `withPrincipal` (`packages/db/src/rls/principal.ts:69-77`) takes `{ begin }` — a **postgres.js** handle — while `transaction()` (`packages/db/src/client.ts:80-82`) is **Drizzle's**. The two are type-incompatible, so every caller re-implements `set local role` + two `set_config`: `apps/erp/src/app/expenses/lib.ts:136`, `packages/domain/src/scheduler/index.ts:348` (and `:684`, `:725`), and a local `asOrg` in 68 integration test files. `scheduler/index.ts:322-323` already names it — *"the third independent copy of an identical five-line idiom… might be worth centralising"*. ⛔ **The cost is not duplication, it is that DEF-209 was filed against the wrong evidence:** a grep for the canonical name found 2 files and concluded RLS had no production callers, when it had 310. Found 2026-09-07 by lane A | `reported` | **Option C step 4** — one Drizzle-shaped helper exported from `@shareat/db`, replacing the three source copies, with the three statements folded into a single round trip (measured: +1.1 ms/tx → +0.28 ms). Tests can follow later. |

### 10.4 `PROJECT_BIBLE.md` §13 — new row 181

> | 181 | 2026-09-07 | ⭐ **RLS IS ENFORCED AND ALWAYS WAS — the failure was in how we looked for it. The tenancy id must never come from the client, and a test now says so.** | DEF-209 claimed RLS had zero production callers; the assessment (`docs/discovery/29-rls-enforcement-assessment.md`) found **310** — the canonical `withPrincipal` is typed for postgres.js and the app uses Drizzle, so the idiom is copied under another name (DEF-211). Proved live on a lane DB: the connecting role is superuser + `BYPASSRLS`, **and `SET LOCAL ROLE shareat_app` fully re-arms RLS** — zero rows with no principal, own-org only with one, cross-org write refused 42501. **68 of 99 integration files exercise the policies on every CI run.** ⛔ **The real defect it uncovered (DEF-210): 5 server actions read `orgId` out of `FormData`, on the 3 files that never take a principal** — the same shape as DEF-064, on writes. ⭐ **The generalisable half:** we had a structural guard for a client-supplied *person* (`no-client-supplied-actor.test.ts`) and none for a client-supplied *org*, though row 112 calls the org the more consequential of the two. **A guard that names one half of an identity is not a guard.** ⚠️ **And a method lesson worth more than the finding — it bit TWICE in one afternoon, both times invisibly.** A heredoc ate a script's regex escapes so it reported *"0 functions touch an org-scoped table"* and exited 0; a registry parser then silently dropped 5 of 125 entries and published two wrong totals that self-review caught. **A sweep that reports a total must first be made to report a known non-zero control** — neither bug was visible in its output, and both were one line away from being caught. Same family as the CRLF `.*$` landmine (§12): a guard that scans nothing is indistinguishable from a guard that finds nothing. | Yes — DEF-209 amended, DEF-210 and DEF-211 filed; Option C scheduled |

### 10.5 The two documentation contradictions — proposed resolution

**(a) RULES §6 item 3 vs bible §7 rule 4.** They do not actually conflict, and the text that
reconciles them **already exists and is cited by neither**:

> **`PROJECT_BIBLE.md` §15.11 — Defence in depth.** *"Authorization at the service layer
> (primary), store scoping at the repository layer, constraints in the schema, and minimal
> Firestore rules at the edge. No single layer is trusted alone — but **no layer may be the only
> one** for a given risk either."*

RULES §6 item 3 ("the database enforces the rules, not the service layer") is about
**CHECK constraints and triggers** — balance, period, immutability — where a second TypeScript copy
of a rule drifts. Bible §7 rule 4 ("store scoping is enforced in the repository layer") is about
**tenancy**, where the repo filter is the *primary* layer and RLS is the *second*. §15.11 is the
governing statement, and DEF-210 is precisely a case where the service layer became **the only
one** — which §15.11 already forbids.

*Proposed edit — `docs/RULES.md`, §6 item 3, append one sentence:*

> ⚠️ **This is about CHECK constraints and triggers (balance, period, immutability) — not
> tenancy.** Tenancy is layered on purpose: the repository filters, RLS backstops
> (bible §7 rule 4 + §15.11). The binding rule for both is §15.11 — *no layer may be the only one
> for a given risk*. DEF-210 is what it looks like when one is.

*Proposed edit — `PROJECT_BIBLE.md` §7 rule 4, append:*

> Row-level security is the second layer behind this one, not an alternative to it (§15.11,
> §13 rows 112 and 181). **A path that carries a tenant id it did not derive from the session has
> neither layer** — see DEF-210.

**(b) `bible §6.3` does not exist.** Bible §6 (*Data conventions*) has five **unnumbered**
subsections — Money, Dates & time, Identifiers, Naming, Nulls (`PROJECT_BIBLE.md:933-970`). There
is no §6.3. The rule being cited is **`docs/RULES.md` §6 item 3**, whose bible home is **§15.11**
(with §4.2 rule 6 for posted/draft and §15.10 for ledgers).

*Proposed correct citation:* **`RULES §6 item 3` (bible §15.11)** — or simply **bible §15.11**
where a single reference is wanted.

**Scale, so the orchestrator can size the fix: 22 occurrences of `bible §6.3` and 12 of
`RULES §6.3` across code, specs, discovery docs and the bible's own §13 rows.** The `RULES §6.3`
form points at the right document with unusual notation; the `bible §6.3` form points at nothing.
The two named in the brief are `packages/db/src/repo/stores.ts:42` and
`docs/tasks/222-store-creation-and-management.md:144`; the others include
`packages/db/schema/stores.ts:118`, `packages/db/schema/statutory-discounts.ts:50`,
`packages/db/src/repo/findings.ts:15`, `packages/db/src/repo/stock-locations.ts:196`,
`packages/db/src/repo/till-shifts.ts:12`, `packages/domain/src/remittance/index.ts:340`,
`packages/domain/src/stock-locations/rules.ts:10`, `packages/domain/src/stores/service.ts:92`,
`apps/erp/src/app/admin/stores/actions.ts:28`, `apps/erp/src/app/remittance/actions.ts:29`,
`docs/tasks/152:211`, `docs/tasks/230:157,372`, `docs/discovery/28:297,588`, and three test files.

⚠️ **Recommend fixing it as a sweep with a guard, not by hand.** A citation this widespread is
copied from whichever file the next author opens first — the identical mechanism DEF-183's row
already documents for policy shapes. A one-line unit test asserting `§6.3` appears nowhere is what
stops it coming back; without one, a hand-sweep is undone by the next spec.
