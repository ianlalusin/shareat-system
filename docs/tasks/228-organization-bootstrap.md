# T-228 — Standing up an organization (`npm run bootstrap-org`)

> **Status**: ✅ **BUILT 2026-09-07.** Ships as `scripts/bootstrap-org.ts`,
> `packages/domain/src/organizations/index.ts` (`createOrganization`, `createFirstAdmin`) and
> `packages/db/src/repo/organizations.ts`. Gates: typecheck exit 0 · 12 integration tests green on
> an isolated lane DB · the existing `chart-of-accounts.test.ts` 77/77 still green.
>
> ⚠️ **Four corrections to this spec were reported rather than worked around** (RULES §3.4a) — the
> dated block at the end of this file, and the header of `packages/db/src/repo/organizations.ts`.
> The largest, **DEF-204**, made Contract §1 unimplementable as written.
>
> ⛔ **Ian runs it against production himself.** It has not been run against production or
> `shareat_dev` by an agent; the dry run is the only thing exercised outside the test databases.
>
> *(Original spec status, 2026-09-06:)* Ian asked to seed **SHAREAT OPC** with
> **SharEat Lipa** and **SharEat Malvar** for the Oct–Dec pilot, and it turned out there is no way
> to do it.
>
> ⛔ **Nothing in this codebase has ever created an organization.** Verified three ways before
> writing this: no `insert(organizations)` or `createOrganization` anywhere in
> `packages/domain`, `packages/db` or `apps/erp`; **no migration inserts one** (zero files match);
> and `scripts/dev-seed.ts:68` does not create one either — it **selects** the first active org and
> throws if there is none. That script's own header says so in passing without noticing:
> *"migrations create 93 accounts and (via whatever put them there) an org and its stores."*
> ⚠️ Quoted verbatim, and **its number is stale too** — the chart is 102 accounts since T-123. Left
> as written because it is a quotation; `scripts/dev-seed.ts:4` is out of this task's scope.
> **Whatever put them there was a person typing SQL.**
>
> ⭐ **This is DEF-189 one level up.** Until T-222 shipped on 2026-09-06 nothing created a *store*
> either, and the four dev stores were hand-inserted. Same shape, same fix, one tier higher.
> Filed as **DEF-195**.
>
> ⚠️ It is also the only thing standing between today and the pilot: production
> (`erp2.shareat.net`) is live, migrated, and holds **zero organizations** — confirmed 2026-09-06
> when `shareat-finding-observation.service` exited 1 with *"no orgs were processed."*
>
> ⭐ **T-300, 2026-09-13 — that sentence is TRUE AND IT IS DATED, and it is deliberately left
> standing.** It is the fixed point the timeline rests on: a real measurement, taken through the
> system door under a role that bypassed RLS, so its zero was genuine. **This task has since been
> carried out.** Production holds one organisation, `SHAREAT OPC` — `select count(*) from
> organizations` → `1`, measured 2026-09-13 as the admin role. It was created at some point
> **after** this line was written and **before** 2026-09-12 15:57 UTC; nobody recorded when, and
> this sentence is what bounds the window from below.
>
> ⛔ **First-run setup is now closed** — `bootstrapOrganization` refuses once any organisation
> exists (`packages/domain/src/organizations/index.ts:341-348`), so neither path in this spec will
> run again. The spec stands as the record of how it was done and as the recovery reference.

## The chicken-and-egg, stated exactly

This is the whole difficulty, and getting the order wrong is why it looks impossible:

| To do this | You first need |
|---|---|
| Sign in | a **PIN** |
| `setPin` (`packages/auth/src/sessions.ts:260`) | a **`storeId`** — the PIN is hashed per store (`pinLookupHash(storeId, pin)`) |
| A store, properly made | `createStore` (T-222), which **authorizes `manage_stores` first** |
| To pass that gate | a **person holding an admin role** |
| A person and a role | an **organization** |
| An organization | ⛔ **nothing** |

⚠️ **So "create the org and an admin, then use `/admin/stores`" does not work** — that was the
first instinct and it is wrong. Without a store there is no PIN, and without a PIN nobody can sign
in to reach `/admin/stores` at all. **The first store has to be part of the bootstrap.**

⭐ **But only one hand-written insert is actually required.** Order it correctly and everything
after the organization row goes through code that already exists and is tested:

```
1. organizations                     ← the ONLY raw insert
2. seedChartOfAccounts(orgId)        ← existing, per-org, idempotent
   seedExpenseCategories(orgId)      ← existing, per-org, idempotent
3. persons + person_roles(admin)     ← raw, and dev-seed already sets the precedent
4. createStore(actor = that admin)   ← T-222's tested path; its §C.2 fan-out writes the
                                        person_store_scope row for us
5. setPin(personId, storeId, pin)    ← now possible: the store exists
```

Step 4 is the pivot. The moment the person holds `admin`, `authorize()` passes and the bootstrap
stops being special — it is just a caller. ⭐ **And T-222's admin fan-out means step 4 grants the
store scope itself**, so the bootstrap never writes `person_store_scope` by hand.

⭐ **`granted_by` is NULL on that first role, and that is correct, not a shortcut.**
`scripts/dev-seed.ts:104` already states the rule and its reason: *"`granted_by` is null only for
seeded rows — bible row 116's authority chain is enforced by the service layer, and there is no
grantor before the first admin."* The first admin of an organization is the base case of the
authority chain. Reuse that precedent; do not invent a synthetic grantor.

## Goal

One guarded, idempotent, auditable command that turns an empty database into an organization
somebody can sign into — and which can be run again for the next franchise without ceremony.

⚠️ **Not a one-off.** The organization model exists *because* franchises are coming (bible row
114). "Stand up a new org" is a capability, and writing it as a script rather than as SQL in a
terminal is what makes the second one safe.

## Scope — files this task may create or modify

**Create**
- `scripts/bootstrap-org.ts`
- `packages/domain/src/organizations/index.ts` — `createOrganization`
- `packages/db/src/repo/organizations.ts` — `insertOrganization`, `getOrgByCode`
- `packages/domain/tests/integration/organizations.test.ts`

**Modify**
- `packages/db/src/index.ts` and `packages/domain/src/index.ts` (barrels) — ⚠️ **corrected
  2026-09-07:** `packages/db/src/repo/index.ts` does not exist, and `packages/db/schema/index.ts:17`
  already exports `./organizations`, so neither is touched
- `package.json` — one script entry
- `docs/ops/README.md` — how to run it against production

⛔ **`PROJECT_BIBLE.md` is not in scope** (RULES rule 14). ⛔ **`scripts/dev-seed.ts` is not in
scope** — it is correct as it stands, and its `_dev` guard must not be relaxed.

## Contract

### 1. `createOrganization` — a domain function, not just a script body

```
createOrganization(tx, { code, name }) → { orgId, accountsSeeded, categoriesSeeded }
```

⛔ **It takes no `Actor`, and this is the one function in the codebase that legitimately cannot.**
There is no principal before the organization exists — `authorize()` resolves capabilities through
`person_roles`, which is keyed by `org_id`. Say this in the function header in as many words, so a
later reader does not "fix" it by adding a gate that can never pass.

⭐ **The gate is the runner, not the caller**: the script (§3) is the only caller, it is not
reachable from any request handler, and it runs under the `system` principal, which
`packages/db/src/rls/principal.ts:39` documents as *"deliberately does nothing: it stays as the
connecting (owner) role... and it is why a `system` principal must never be reachable from a
request handler."* That is the same posture T-140's scheduler jobs already run under.

**What it does, in ONE transaction:**
1. Refuse if `code` already exists — `organizations.code` is `unique`, so let the database say it,
   then translate the error into a sentence a human can act on.
2. Insert the organization.
3. `seedChartOfAccounts(tx, orgId)` and `seedExpenseCategories(tx, orgId)`.
   ⛔ **Both are per-org and both are mandatory.** An org without its 102 accounts cannot post
   anything, and the symptom is `postEntry` refusing with *"unknown account code"* — which is the
   engine working correctly and is baffling if you assume the chart is global. It is not: every
   seeded row carries `org_id`.

⚠️ Reuse the existing `seedChartOfAccounts` / `seedExpenseCategories` exports. Do **not** write a
second seeding path — a second copy is a second source of truth, and the chart grows as the
project does (T-123 added `2160` and `4500`).

### 2. `createFirstAdmin` — the base case, and it lives beside it

```
createFirstAdmin(tx, { orgId, displayName }) → { personId }
```

⛔ **Refuses outright if the org already has any `person_roles` row.** This is what makes it the
*first* admin rather than a back door that mints admins forever. Once one exists, the supported
path is `/admin/users` (T-219) and this function must say so in its refusal message.

Inserts `persons (org_id, display_name)` and `person_roles (person_id, org_id, role='admin')` with
`granted_by` NULL, per §"chicken-and-egg" above. It does **not** write `person_store_scope` —
`createStore` does that in step 4.

### 3. `scripts/bootstrap-org.ts` — and its guard is the inverse of dev-seed's

```
npm run bootstrap-org -- --code=SHAREAT_OPC --name="SHAREAT OPC" \
                         --admin="<person's real name>" \
                         --store-code=LIPA --store-name="SharEat Lipa" \
                         --confirm
```

⛔ **This script is *designed* to reach production**, which makes it the exact liability
`dev-seed.ts` refuses to be. Its guards therefore have to be different in kind, not just stricter:

| Guard | Why |
|---|---|
| **No defaults for any argument.** Every value is typed by the person running it | A default is how the wrong org gets created quietly. There is no `SHAREAT_OPC` fallback in the code |
| **`--confirm` required**, and without it the script **prints the plan and exits 0** | The dry run is the default. Seeing the plan is free; committing to it is deliberate |
| **Refuses if the org code exists** | Idempotence, and it makes a double-run a no-op rather than a duplicate |
| ⛔ **NOT guarded on the database name** | `dev-seed`'s `_dev` check is right for `dev-seed` and would be exactly backwards here. Do not copy it |

⚠️ **Reuse `dev-seed.ts:41`'s `databaseNameOf` if you need the database name for the printed plan**
— and read its comment first. It deliberately does *not* use `new URL()`, because a connection
string with an odd password can defeat the parse. ⛔ **This project's production password contains
an `@`.** Never hand-split the URL with `replace()` either; that has already produced a confidently
wrong claim in a pushed document.

**The PIN:**
- Taken from `--pin=NNNNNN` if given, otherwise **generated** (six digits, from
  `crypto.randomInt`, never `Math.random`).
- ⛔ **Printed exactly once, to stdout, and never written to a log file.** Note that
  `docs/ops/*.service` units redirect stdout to `/var/log/shareat/*.log`; this script is run by
  hand, not by a unit, and **must not be given a unit**. Say so in its header.
- Validated as six digits before anything else runs — `setPin` will refuse otherwise, and finding
  that out *after* creating an organization is a bad time to learn it.

**Output** is the plan, then what it did, then the sign-in details: store code, person name, PIN.

### 4. Ordering, and the failure that matters

All five steps in **one transaction**. ⛔ A bootstrap that half-succeeds leaves an organization
nobody can sign into and no way to re-run — the refusal in §2 would then block the retry. Prove
the rollback with an injected failure, as T-222 did; an untested rollback is a claim with nothing
executable behind it.

### 5. What it deliberately does NOT do

- **No second store.** It creates exactly one, because one is what `setPin` requires. **SharEat
  Malvar is created afterwards through `/admin/stores`** — the supported path, and a real
  production smoketest of T-222 on its first day.
- **No sales channels, no items, no opening balances.** `/cutover` (T-134) owns opening balances;
  the rest are ordinary screens.
- **No `super_admin`.** `admin` is what `manage_stores` and `manage_users` need. A super-admin
  (item approval, T-148) is a later, deliberate `/admin/users` action.

## Invariants

1. Running twice creates nothing the second time and exits non-zero with a clear reason.
2. Without `--confirm`, nothing is written — ever, on any path.
3. An organization always has its chart of accounts and expense categories, or it does not exist.
4. `createFirstAdmin` refuses once any role exists in the org.
5. The PIN never reaches a log file.
6. A failure at any step leaves no organization behind.
7. The created store carries its default room and the admin's scope row — because `createStore`
   made it, not this script.

## Tests

Integration, `packages/domain/tests/integration/organizations.test.ts`:

1. `createOrganization` inserts the org and seeds the whole chart and every expense category, all
   carrying the new `org_id`. ⚠️ **Corrected 2026-09-07: 102 accounts and 38 categories, not
   93/39** — see the corrections block at the end of this file. The tests assert against
   `CHART_OF_ACCOUNTS.length` / `EXPENSE_CATEGORY_SEED.length`, never a literal.
2. A duplicate `code` is refused by the database and surfaced as a readable error.
3. `createFirstAdmin` creates person + role with `granted_by` NULL.
4. `createFirstAdmin` **refuses** when a `person_roles` row already exists for that org.
5. ⭐ **The whole chain end to end**: org → admin → `createStore` as that admin → `setPin` →
   `signInWithPin` with store + PIN returns a session for that person. ⚠️ **Corrected 2026-09-07:
   the export is `signInWithPin`; there is no `signIn`.** This is the test that proves the
   chicken-and-egg is actually broken, and it is the one worth writing first.
6. An injected failure at step 4 rolls back the organization entirely (invariant 6).
7. The new org's chart is independent — seeding a second org does not touch the first's accounts.

⚠️ **`tests/integration/setup.ts` runs no migrations and truncates between runs**, and these tests
create organizations rather than assuming one. Check what the shared fixture assumes before adding
them, or they will pass alone and fail in the suite.

**Smoketest — and for once it is not on 9008.** Run the dry run locally first, then the real thing
against `shareat_dev`, then sign in as the created admin. Only after that against production, by
Ian.

## Open questions — for Ian

1. **Org `code` for SHAREAT OPC?** `organizations.code` is `unique` and permanent in practice.
   Recommendation: `SHAREAT_OPC`.
2. **Whose name is the first admin?** It is a real person with a real PIN, not a service account —
   `persons.display_name` is what the ledger will attribute the pilot's first entries to.
3. **Does the pilot want the other two operating stores** (Banay-Banay, Davao) at bootstrap, or
   only Lipa and Malvar as asked? Everything after the first store is `/admin/stores` either way.

## Done when

- [ ] `npm run bootstrap-org` with no `--confirm` prints a plan and writes nothing
- [ ] With `--confirm`, one transaction creates org, chart, categories, admin, store and PIN
- [ ] Signing in with the printed store + PIN works, and lands on a usable screen
- [ ] A second run refuses, and `createFirstAdmin` refuses once a role exists
- [ ] Injected-failure rollback proven, not asserted
- [ ] Seven integration tests green, written first and seen failing for the right reason
- [ ] `docs/ops/README.md` documents the production invocation and that the PIN is shown once
- [ ] `npm run build` exit 0 with the dev server stopped
- [ ] **Ian runs it against production himself** — this script writes to the live database, and
      `docs/IAN-SETUP-CHECKLIST.md` §4b's principle (no standing credentials through an agent)
      covers this as surely as it covers provisioning — ⚠️ **corrected 2026-09-07: `docs/RULES.md`
      has no §4b**


---

## Corrections to this spec — 2026-09-07, reported not worked around (RULES §3.4a)

Four things in the spec above were wrong. Each is corrected in place and recorded here, because a
planner's spec is a hypothesis and silently patching around a defect destroys the evidence it was
wrong.

### 1. ⛔ `seedChartOfAccounts(tx, orgId)` could not work — DEF-204, and it is not a T-228 bug

Contract §1 says `createOrganization(tx, …)` calls `seedChartOfAccounts(tx, orgId)`. It cannot: the
seeds take a **postgres.js** client (`chart-of-accounts.ts:459`) and `Tx` is a **Drizzle**
transaction. All ~100 existing callers pass a raw client outside any transaction.

The bridge is the postgres.js client behind the Drizzle handle — the same one Drizzle uses for its
own savepoints — but the seeds then threw *"The 'string' argument must be of type string… Received
an instance of Array"*. **Cause: `drizzle-orm/postgres-js/driver.js:17-22` mutates the shared
client's options on construction**, replacing the jsonb serializer (and the timestamp
parsers/serializers) with an identity function. So once `getDb()` has run in a process, `sql.json()`
on that client silently stops serialising.

Both obvious spellings work in exactly one world, verified against real Postgres:

| binding | plain client | inside a Drizzle tx |
|---|---|---|
| `sql.json(payload)` | OK | **throws** |
| `${json}::jsonb` | **throws** 22023 *"non-array"* | OK |
| `cast(${json} as jsonb)` | **throws** 22023 — identical to `::jsonb` | OK |
| `(${json})::text::jsonb` | **OK** | **OK** |

postgres.js infers the parameter type from the **first** adjacent cast token, so `::text` tags it
text — a type neither client rewrites — and Postgres does the text→jsonb conversion. The two seed
files now use that form, with the reasoning in `seedChartOfAccounts`' header. ⚠️ The previous comment
there asserted the opposite; it was right about the plain client and silent about the other one.

⭐ **This had already bitten someone**: `tests/invariants/accounting-equation.test.ts:55` avoids
`getSql()` with the comment *"which `sql.json()`'s parameter wrapper does not round-trip through
cleanly"* — the symptom recorded, the cause not found.

### 2. The seed counts were stale — 102 accounts and 38 categories, not 93 and 39

93 is the pre-T-123 figure; `packages/db/tests/integration/chart-of-accounts.test.ts:338` already
pins 102 (7 headers + 95 leaves). Categories are 38 (COGS 9, OPEX 27, PERSONAL 1, CAPEX 1). The
tests assert against the seed arrays' `.length`, so they cannot go stale again the next time the
chart grows. `scripts/dev-seed.ts:4` carries the same stale number in a comment — out of scope here,
left alone.

### 3. Two of the three barrels in Scope needed no change

`packages/db/src/repo/index.ts` does not exist — the db barrel is `packages/db/src/index.ts` — and
`packages/db/schema/index.ts:17` already exports `./organizations`.

### 4. Smaller: two names that do not exist

`signIn` is `signInWithPin` (`packages/auth/src/sessions.ts:63`), and **`docs/RULES.md` has no
§4b** — the §4b that carries "no standing credentials through an agent" is in
`docs/IAN-SETUP-CHECKLIST.md`.

## Deviations from the spec's letter, and why

- **`createOrganization` calls `organizationsRepo.seedReferenceData(tx, orgId)`**, not the two seed
  functions directly. The reach through the Drizzle handle is driver knowledge, so it lives in
  `packages/db` next to the `Tx` type rather than in a service (bible §4.3). It is one documented
  function with a test behind it, and it reuses the existing seeds exactly as Contract §1 requires —
  there is still no second seeding path.
- **`createFirstAdmin` composes `personsRepo.insertPerson` + `accessRepo.insertRole`** rather than
  writing raw SQL. §4.3: repositories are the only place SQL is written. `dev-seed.ts`'s raw inserts
  are a script, not a precedent for `packages/domain`.
- **`orgHasAnyRole` is new, in the organizations repo.** Contract §2 refuses on *any* `person_roles`
  row; `accessRepo.hasActiveAdmin` only sees *active admin* rows, which would let the back door open
  again after a demotion. Two tests cover the difference (a revoked role, and a staff-only org).
- **`databaseNameOf` is copied into the script, not imported.** The spec says to reuse
  `dev-seed.ts`'s copy, but it is not exported and `dev-seed.ts` is explicitly out of scope; copying
  five pure lines with attribution beat editing a file the spec told me not to touch.

## Still open

- **Ian's three questions** (org code, the first admin's real name, which stores) are unanswered by
  design — built to the spec's recommendations, and the real values are typed at the production run.
- **Not run against production or `shareat_dev`.** Only the dry run and the test databases.
- **Not smoketested on 9008.** Per the spec, this task's smoketest *is* the production run, which is
  Ian's.
