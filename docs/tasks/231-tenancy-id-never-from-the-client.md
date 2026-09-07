# T-231 — The tenancy id never comes from the client (DEF-210), and the principal becomes one helper (DEF-211)

> **Status**: ✅ **SLICES 1-3 COMPLETE.** Slice 1 committed `7487d91` (DEF-210), slice 2 committed
> `5f37ed3` (DEF-209 gap + DEF-211, in one commit with T-229 slice 2 — see that commit for why a
> split would have been broken at one SHA). Slice 3 done, awaiting commit: DEF-214 + DEF-215.
> Redline **R1** applied throughout. Findings (a)-(d) and all three open-question assumptions
> accepted as written.
>
> Discovery: **`docs/discovery/29-rls-enforcement-assessment.md`** — every number here comes from it.
> Defects closed: **DEF-210** (slice 1), **DEF-211** (slice 2). Amends nothing in the bible; bible
> §13 row 181 is the orchestrator's to file and already says *"T-231 adds the other half."*
>
> **No migration. No schema change. No new capability.** One barrel line in slice 2, which lane B
> owns this cycle and the orchestrator applies at integration.
>
> Option A (principal on every `transaction()`, 8–13 days) and Option B (non-superuser prod role
> first) are both **rejected for now** — reasons in discovery 29 §6; this spec does not restate them.

---

### ⚠️ Four findings from reading the code, reported rather than designed around (RULES §3.4a)

**(a) ⛔ The lane brief's guard description misses more than half of what needs guarding.** It asks
for a unit guard that *"no apps/erp `actions.ts` or `lib.ts` calls `transaction(` directly."* The
35 unprincipalled authenticated sites break down as **14 in `actions.ts`, 5 in `lib.ts`, and 16 in
`page.tsx`** — Server Components doing reads. A guard covering only the first two would pass while
`app/expenses/[id]/page.tsx` and nine others still read on the unrestricted owner connection, and
it is exactly the shape DEF-064 already had: *a read has no choke point, because a mutation must
call a domain service and a page need not*. **Contract 5 covers all three file kinds.** Flagged
rather than silently widened.

**(b) ⛔ `apps/erp/src/app/reports/lib.ts:175` re-exports `transaction`, which is a hole straight
through any import-site guard.** A page can write `import { transaction } from '../reports/lib'`
and never name `@shareat/db`. That file is also the precedent worth copying: `runReport`
(`reports/lib.ts:170-173`) already wraps every report in `withOrgPrincipal`, and its comment says
*"The reports were the ONE place in this app still reading off the unrestricted owner
connection."* **They were fixed; these 34 are what that sentence missed.** Contract 5's guard
matches the re-export as well as the import, and slice 2 deletes the re-export.

**(c) ⭐ The three principal statements fold into ONE round trip *with full parameterisation* —
better than discovery 29 §6 assumed, and I verified it rather than specifying it from theory.**
The assessment proposed folding them into a single `sql.raw` string, which would have interpolated
an org id into SQL text and needed UUID validation to be safe. It is unnecessary: `role` is an
ordinary GUC, so `set_config('role', $1, true)` is equivalent to `SET LOCAL ROLE $1` — which the
grammar does not allow — and the whole principal becomes one parameterised statement. Probed on
`shareat_test_t228`, through **both** postgres.js and Drizzle's `tx.execute`, all rolled back:

| | |
|---|---|
| role switched | `current_user = shareat_app` ✅ |
| RLS armed | own org's row only, cross-org invisible ✅ |
| cross-org write | **REFUSED, SQLSTATE 42501** ✅ |
| ⭐ transaction-scoped | next transaction on the same pooled connection is back to `postgres` with `app_current_org()` NULL ✅ — bible invariants 11 and 12 hold |
| cost | 3 round trips **+1.421 ms/tx** → 1 round trip **+0.131 ms/tx** (a 91% cut, not the 75% the assessment estimated) |

**(d) 🔸 `storeId` is ALSO a hidden form field on these screens, and it must STAY one.** Do not
"fix" it alongside `orgId`. A hidden `storeId` is safe precisely because `authorize()` axis 2
proves it (`packages/auth/src/authorize.ts:122-129`: `storeBelongsToOrg` **and**
`personHasStoreScope`); `orgId` was unsafe because axis 1 is a no-op unless the caller passes
`ctx.orgId`, and only **7 of 265** call sites do. Removing `storeId` would break every multi-store
screen for no security gain. Stated here because the two fields sit on adjacent lines and the next
reader will be tempted.

---

## Goal

**A server action can no longer be told which organisation it is acting for.** The org comes from
the session, always; and on every authenticated path the database is armed to refuse a cross-org
row even if some future code path gets it wrong anyway.

Two observable outcomes:

1. **DEF-210.** Today a staffer with `transfer_stock` can edit one hidden field and post a stock
   transfer, two stock movements and a journal entry into **Padre Garcia's books** — a live
   franchise with a separate owner. After slice 1 there is no field to edit, and a unit test fails
   the build if anyone reintroduces one.
2. **The production trap (discovery 29 §5.3).** Production has never held an organisation, so no
   production read path has ever exercised its own RLS behaviour. Whichever role production turns
   out to connect as, **after slice 2 both outcomes are safe**; before it, neither is. See
   *Risk — the production trap* below.

---

## Slices, in order

| # | What | Waits on | Migration |
|---|---|---|---|
| **1** | **Close DEF-210** — the org comes from the session, and a guard says so | Nothing. Defect fix; does not wait on Ian | None |
| **2** | **One Drizzle-shaped `withOrgPrincipal` (DEF-211) + the 35 paths + the guard** | ⛔ **BOTH slice 1 AND T-230 committed** (orchestrator R1), orchestrator says go, and one barrel line the orchestrator applies | None |
| **3** | ⭐ **The SECOND door — `getDb` (DEF-215), `listOrgs` deleted (DEF-214), and the scheduler's inline `asSystem` copy** | Slice 2 committed | None |

### Slice 3 — added 2026-09-07 after slice 2 surfaced the second door

Slice 2's guard watched `transaction()` and went green while `getDb()` — the same owner connection
without even a transaction — stayed open in `expenses/lib.ts`. ⭐ **A guard that closes one of two
doors reads exactly like a guard that closes the problem.** Four items:

1. **Widen the guard to `getDb`**, same allowlist, same >50-file control. Watched to fail first:
   **1 offender, `app/expenses/lib.ts` — imports getDb and calls getDb()**.
   ⚠️ It strips comments before matching calls, or `reports/lib.ts` — which names `getDb()` twice
   in prose explaining why reports stopped using it — would be reported as an offender for being
   *documented*.
2. **`listStores`, `listActingPersons`, `listActivePersons`** run under `withOrgPrincipal`. Their
   `where org_id = …` clauses stay: bible §15.11, no layer may be the only one.
3. ⛔ **`listOrgs()` DELETED** (DEF-214, Ian's call as capability holder) — a cross-org read off the
   owner connection with **no caller**; `sales-days/lib.ts` only re-exported it onward. Its
   `OrgOption` type went with it, having existed only to type it. A tombstone comment says where it
   went and what would bring it back (an explicit system-principal read, with a caller).
4. **`scheduler/index.ts:685`** — an inline copy of `asSystem`'s body, four lines from `asSystem`.
   ⛔ NOT folded into `withOrgPrincipal`: it declares `principal_kind = 'system'`.

⚠️ **Slice 1 and slice 2 touch three of the same files** (`inventory/returns/actions.ts`,
`inventory/transfers/actions.ts`, `trade/returns/actions.ts`). Slice 1 changes where the org comes
from; slice 2 wraps the transaction. Sequential, same lane, no conflict — but do not start slice 2
with slice 1 uncommitted.

---

## Scope — the exact files each slice may create or modify

### Slice 1 — modify only, nothing created

| File | Change |
|---|---|
| `apps/erp/src/app/inventory/returns/actions.ts` | drop `str(fd,'orgId')` at `:22` and `:63` |
| `apps/erp/src/app/inventory/returns/page.tsx` | delete the hidden field at `:149` and `:202` |
| `apps/erp/src/app/inventory/transfers/actions.ts` | drop `str(fd,'orgId')` at `:30` |
| `apps/erp/src/app/inventory/transfers/NewTransferForm.tsx` | delete the hidden field at `:26` **and the `orgId` prop** from the component's signature |
| `apps/erp/src/app/inventory/transfers/page.tsx` | stop passing `orgId` to `<NewTransferForm>` at `:125` |
| `apps/erp/src/app/trade/returns/actions.ts` | drop `str(fd,'orgId')` at `:22` and `:61` |
| `apps/erp/src/app/trade/returns/page.tsx` | delete the hidden field at `:186` |
| `packages/domain/src/stock/supplier-returns.ts` | drop `orgId` from `RecordReturnInput` (`:49`) and `RefundCreditInput` (`:337`); derive |
| `packages/domain/src/stock/transfers.ts` | drop `orgId` from `CreateTransferInput` (`:31`); derive |
| `packages/domain/src/trade/returns.ts` | drop `orgId` from `RecordCustomerReturnInput` (`:128`) and from `applyCredit`'s inline input (`:623`); derive |
| `tests/unit/no-client-supplied-actor.test.ts` | add `TENANT_FIELDS` + one `it()` — contract 2 |
| `packages/domain/tests/integration/supplier-returns.test.ts` | drop `orgId` from the two call sites |
| `packages/domain/tests/integration/stock-transfers.test.ts` | same |
| `packages/domain/tests/integration/customer-returns.test.ts` | same |

⭐ **The blast radius is this small because each entry point has exactly one app caller and one test
file** — verified by grep across `apps`, `packages`, `scripts`. Nothing else constructs these inputs.

### Slice 2

| File | Change |
|---|---|
| `packages/db/src/rls/principal.ts` | **add** the Drizzle-shaped `withOrgPrincipal` (contract 3). The existing postgres.js `applyPrincipal`/`withPrincipal` stay — the integration suites use that shape |
| `apps/erp/src/app/expenses/lib.ts` | delete the local copy at `:134-141`, re-export the shared one so its ~290 importers do not all change |
| `packages/domain/src/scheduler/index.ts` | delete the local `withOrgPrincipal` at `:346-353`, import the shared one. ⛔ **NOT `:684`/`:725`** — those are the `'system'`-principal variant (`asSystem`), a different declaration, left alone |
| `apps/erp/src/app/reports/lib.ts` | delete `export { transaction }` at `:175` (finding (b)) |
| **the 33 remaining unprincipalled files** | listed below — wrap in `withOrgPrincipal` |
| `tests/unit/no-direct-transaction-in-erp.test.ts` | **create** — contract 5 |
| `packages/db/tests/integration/rls.test.ts` | add the three assertions of contract 4 |

**One line the orchestrator applies at integration** (`packages/db/src/index.ts` is lane B's this
cycle) — place it next to the existing `APP_ROLE` export at `:200-202`:

```ts
// T-231 / DEF-211 — the ONE Drizzle-shaped principal helper. Replaces the copies in
// apps/erp/src/app/expenses/lib.ts and packages/domain/src/scheduler/index.ts.
export { withOrgPrincipal } from './rls/principal';
```

Until that line lands, slice 2's own tests import by relative path (`../../src/rls/principal`).

### The 35 paths, file by file — measured, not grepped

⚠️ **This table replaces the draft's 34/20 figure.** That came from a line-based grep, which cannot
see a `transaction` import spanning several lines — `app/inventory/lib.ts` was invisible to it. The
count below is from a whole-file scan (`n` = plain `transaction()` call sites), and it prints its
own control (250 files scanned) before any total.

| File (under `apps/erp/src/`) | n |
|---|---|
| `app/ap/invoices/[id]/page.tsx` | 2 |
| `app/commissary/discrepancies/actions.ts` | 2 |
| `app/commissary/discrepancies/page.tsx` | 1 |
| `app/commissary/orders/[id]/actions.ts` | 1 |
| `app/commissary/orders/page.tsx` | 1 |
| `app/expenses/[id]/page.tsx` | 3 |
| `app/expenses/lib.ts` | 2 |
| `app/expenses/page.tsx` | 1 |
| `app/fixed-assets/lib.ts` | 1 |
| ⭐ `app/inventory/lib.ts` | 1 — **the one the grep missed** |
| `app/inventory/low-stock/actions.ts` | 1 |
| `app/inventory/low-stock/page.tsx` | 1 |
| `app/inventory/returns/actions.ts` | 3 |
| `app/inventory/returns/page.tsx` | 1 |
| `app/inventory/transfers/actions.ts` | 4 |
| `app/inventory/transfers/page.tsx` | 1 |
| `app/reports/lib.ts` | 0 — re-export only |
| `app/sales-days/[id]/page.tsx` | 3 |
| `app/sales-days/lib.ts` | 1 — was lane B's; **free since T-230 at `736dffc`, no exemption needed** |
| `app/sales-days/page.tsx` | 1 |
| `app/trade/returns/actions.ts` | 3 |
| `app/trade/returns/page.tsx` | 1 |
| **Total** | **35 sites across 22 files** — 14 in `actions.ts`, 5 in `lib.ts`, 16 in `page.tsx` |

### ⛔ The pre-auth allowlist — these four MUST keep a plain `transaction()`

| File | line | Why a principal is impossible |
|---|---|---|
| `apps/erp/src/app/sign-in/actions.ts` | 36, 53 | `signInWithPin` / `signOut`. The org is the **output** of the credential lookup — `sessionsRepo.findActiveCredentialByLookupHash` (`repo/sessions.ts:38`) searches by a store-scoped hash before any org is known |
| `apps/erp/src/app/sign-in/page.tsx` | 30 | the store picker, rendered to a visitor with no session |
| `apps/erp/src/lib/session.ts` | 62 | `resolveActor` — it is what *produces* the actor |

`packages/auth/src/sessions.ts` (6 sites) is the same case one layer down and is **out of scope for
this task entirely** — it is not under `apps/erp` and the guard does not scan it.

### ⛔ Out of bounds in both slices

`PROJECT_BIBLE.md` · `docs/RULES.md` · `docs/DEFECTS-REGISTER.md` · `docs/ROADMAP.html` — the
orchestrator's, per RULES §1 rule 14. Also: no migration; no change to `authorize()`; no change to
the 123 `packages/domain` `tx | null` fallbacks; no change to the 31 integration test files that
lack an `asOrg` helper; and **nothing under lane B's file set** (`app/wastage/*`,
`app/sales-days/{lib.ts,new/page.tsx}`, `app/settings/**`, `app/admin/stores/[id]/page.tsx`,
`packages/domain/src/{stores/service.ts,wastage/*}`, `packages/db/src/repo/{sales-days,order-wastage}.ts`).

---

## Contract

### 1. The five entry points lose their `orgId` field — they do not keep it and assert it

Every one of the five already takes an `Actor`, and `Actor` is `{ personId, orgId }`
(`packages/auth/src/authorize.ts:55-58`). The field is therefore **pure redundancy that can only
ever disagree**, and the two options are not equal:

| | |
|---|---|
| Keep it, assert `input.orgId === input.actor.orgId` | Leaves a field in the wire format that a caller can still set, and turns a structural guarantee into a runtime check somebody must remember to write on the sixth entry point |
| ⭐ **Drop it, derive from the actor** | **There is no field to lie in.** RULES §4 / bible row 104: *name the statement the database refuses, not the call our code declines to make* — the structural form of the same instinct |

**Drop it.** Concretely:

```ts
// packages/domain/src/stock/supplier-returns.ts
export interface RecordReturnInput {
  readonly storeId: string;          // ← orgId deleted from :50
  …
  readonly actor: Actor;
}
export async function recordReturn(tx: Tx, input: RecordReturnInput): Promise<RecordReturnOutcome> {
  await authorize(tx, input.actor, 'record_supplier_return', { storeId: input.storeId });
  const orgId = input.actor.orgId;   // ← the ONE place it is now derived
  …
}
```

Same shape for `refundSupplierCredit` (`:361`), `saveDraft` (`:159`), `transferNow` (`:88`),
`recordCustomerReturn` (`:158`). `applyCredit` (`:620`) takes `actor` as its own parameter rather
than inside `input`, so it derives from `actor.orgId` and drops `orgId` from the inline input type
at `:623`.

⚠️ **Do not reorder or rename anything else in these signatures.** The diff should be readable as
*"one field left, one local appeared"* — a spec that invites a tidy-up is how a defect fix acquires
a regression.

### 2. The guard — `TENANT_FIELDS`, not an addition to `ACTOR_FIELDS`

The lane brief offers either. **Use a sibling array**, because
`tests/unit/no-client-supplied-actor.test.ts` is titled *"no server action accepts an actor
identity as a parameter"* and every failure message it emits says *actor identity*. An `orgId`
offender reported under that wording sends the next reader looking for a person. The scanner
(`readsActorFromInput`, `:63-77`) already matches the four shapes that occur — `formData.get`,
`str(fd, …)`, `body.x`, `searchParams.get` — so only the field list and one `it()` are new:

```ts
/** ⛔ Field names that name a TENANT. bible §13 row 112 calls the org the more consequential of
 *  the two identities, and until T-231 this file guarded only the person (DEF-210, DEF-064). */
const TENANT_FIELDS = ['orgId', 'organizationId', 'org_id', 'tenantId'] as const;
```

with a second `describe`/`it` — *"no code reads an organisation id out of client input"* — reusing
the same `trackedFiles()` and pattern set. **`KNOWN_PICKER_PATHS` gets no tenant equivalent**: there
is no legitimate reason for a screen to name its own org, so there is no exemption list to grow.

⭐ **This test is written and watched to FAIL FIRST**, and it must name **all five** sites
(`inventory/returns/actions.ts` ×2, `inventory/transfers/actions.ts` ×1,
`trade/returns/actions.ts` ×2). Four is a wrong answer, not a partial one — it means the scanner
missed a shape.

### 3. `withOrgPrincipal`, one round trip, fully parameterised (slice 2)

In `packages/db/src/rls/principal.ts`, beside the existing postgres.js helpers:

```ts
/**
 * Runs `fn` in one transaction under `orgId`'s staff principal. **The** way an app or a job
 * establishes a principal — DEF-211 retired three copies of this idiom.
 *
 * ⭐ ONE round trip, and parameterised. `SET LOCAL ROLE x` admits no parameter, but `role` is an
 * ordinary GUC, so `set_config('role', $1, true)` says the same thing and lets the role and the
 * org travel as bind parameters rather than as interpolated SQL text. Measured: +0.131 ms/tx
 * against +1.421 ms for the three-statement form (discovery 29 §5.1, T-231 finding (c)).
 *
 * ⚠️ Every setting is TRANSACTION-scoped (`set_config(..., true)`), which is the whole safety
 * property: a pooled connection outlives a request, and a session-scoped role or GUC would serve
 * the NEXT request under the PREVIOUS user's identity. Verified: the transaction after this one
 * is back to the owner role with `app_current_org()` NULL.
 */
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('role', ${APP_ROLE}, true),
             set_config('app.principal_kind', 'staff', true),
             set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
```

⛔ **`sql.raw` is not permitted here.** The old copies used `sql.raw(\`set local role ${APP_ROLE}\`)`
because the grammar forced it; this form does not, and a raw path would re-open an interpolation
site for the sake of nothing.

⚠️ **`expenses/lib.ts` re-exports rather than deletes.** **89 files import `withOrgPrincipal`** —
46 directly from `expenses/lib`, 6 from a sibling `../lib`, and 37 through a chain of ~20
per-directory `lib.ts` files that each re-export it (`app/ap/lib.ts:15` is typical). Changing all
of them is churn that hides slice 2's real diff. Make `expenses/lib.ts` say
`export { withOrgPrincipal } from '@shareat/db';` and leave every importer and every intermediate
re-export alone.

⭐ **That chain is also why contract 5's guard must match re-exports.** This codebase re-exports
helpers through local `lib.ts` files as a matter of habit — a guard keyed only on
`from '@shareat/db'` would miss nearly every real call site.

### 4. What the RLS suite gains (slice 2)

Three assertions in `packages/db/tests/integration/rls.test.ts`, because the new helper is the
thing every request now depends on:

1. **the folded call arms RLS** — after it, `current_user = 'shareat_app'` and a cross-org select
   returns zero rows;
2. **a cross-org INSERT under it is refused with 42501** — not a cast error, not a silent pass;
3. **the principal does not survive the transaction** — the next transaction on the same
   connection sees `current_user = owner` and `app_current_org() IS NULL`. This is invariants 11
   and 12 (`rls.test.ts:158`) restated for the new entry point, and it is the one that matters
   most: it is the difference between a safety feature and an intermittent cross-tenant leak.

### 5. The guard against a new unprincipalled path (slice 2)

`tests/unit/no-direct-transaction-in-erp.test.ts` — new. It fails if any file under
`apps/erp/src/app/**` or `apps/erp/src/lib/**` **imports or calls `transaction`** outside the
allowlist.

- It scans **`actions.ts`, `lib.ts` and `page.tsx`** — finding (a): 16 of the 34 are pages, and a
  guard that skips them re-creates DEF-064's exact blind spot.
- It matches the **re-export** shape too (finding (b)): `export { transaction }` and
  `import { transaction } from '…/reports/lib'`, not only imports from `@shareat/db`.
- The allowlist is the three pre-auth files above, each with its one-line reason **in the file**,
  in the confession style `KNOWN_PICKER_PATHS` already uses (`no-client-supplied-actor.test.ts:40-47`)
  — an entry is an admission that a path reads on the owner connection, not a config knob.
- ⛔ **No dated exemption for `app/sales-days/lib.ts`** — orchestrator R1, 2026-09-07. **Slice 2
  does not start until BOTH slice 1 and T-230 are committed**, so that file is lane A's to wrap
  like the other 19 and the guard goes green with no exemption and nothing to remember to remove.
  The earlier draft of this spec proposed a temporary entry; R1 removes the need for it by
  sequencing instead, which is the better trade — a dated exemption is a promise, and the schedule
  is a fact.
- Copy the stale-exemption assertion (`no-client-supplied-actor.test.ts:83-91`) anyway, for the
  three pre-auth entries: an exemption that stops matching a real file makes the rule look narrower
  than it is.
- ⭐ **It carries a non-vacuous control**, copying `no-client-supplied-actor.test.ts:79-81`
  (*"the scanned set is non-empty — a vacuous pass would prove nothing"*): assert the scan found
  **more than 50 files** before asserting anything about offenders. This is now standing lane
  policy — a sweep that reports a total must first report a known non-zero control — and it is in
  this spec because it is exactly the bug that bit twice while writing discovery 29 (§8).

---

## Invariants

1. **No file outside the pre-auth allowlist reads an org id from client input.** Enforced by
   contract 2, not by review.
2. **No file under `apps/erp/src/app` or `apps/erp/src/lib` opens a transaction without a
   principal**, allowlist excepted. Enforced by contract 5.
3. **`storeId` stays a client-supplied field** and stays validated by `authorize()` axis 2
   (finding (d)). A change here is out of scope and would be a regression.
4. **The principal never outlives its transaction.** Contract 4 assertion 3.
5. **`system`-principal paths are unchanged.** The 15 scripts, `bootstrap-org`, the migrator and
   the ETL keep connecting as the owner — `packages/domain/src/organizations/index.ts:22-40` says
   why, and this task does not revisit it.
6. **Behaviour is otherwise identical.** Slice 1 changes where a value comes from; slice 2 changes
   which role a transaction runs as. No screen gains or loses a feature, and no posting changes.
   ⚠️ If a screen goes blank after slice 2 that is not a cosmetic regression — it is a query that
   was relying on the owner bypass, and it must be reported, not patched around (RULES §3.4a).

---

## Tests — written before the implementation, each watched to fail for the right reason

### Slice 1

| Test | Must fail first with |
|---|---|
| `tests/unit/no-client-supplied-actor.test.ts` — *"no code reads an organisation id out of client input"* | **five** offenders named: `inventory/returns/actions.ts`, `inventory/transfers/actions.ts`, `trade/returns/actions.ts`. Fewer than five means the scanner missed a shape, not that the code is cleaner than reported |
| `packages/domain/tests/integration/supplier-returns.test.ts` — new: *"a return is stamped with the ACTOR's org, not a supplied one"* | before the fix it **passes while doing the wrong thing** — so write it as: call `recordReturn` with `orgId` set to a **second org's id** and `actor` in the first, then assert the row's `org_id` is the **actor's**. Pre-fix it fails with the *other* org's id, which is DEF-210 reproduced rather than described |
| `packages/domain/tests/integration/stock-transfers.test.ts` — same shape for `transferNow` | pre-fix: `stock_transfers.org_id` and both `stock_movements.org_id` carry org B while the actor is in org A |
| `packages/domain/tests/integration/customer-returns.test.ts` — same shape for `applyCredit` | pre-fix: the collection posts under org B |

⭐ **The three integration tests are the ones that prove the defect, and they must be written
before the type changes** — once `orgId` leaves the input type the test can no longer express the
attack, so a test written afterwards can only ever have passed. Write them, watch them fail with
the wrong org id, then remove the field and change the assertion to a compile-time impossibility
(the call no longer type-checks with `orgId`) plus the runtime assertion on the stamped row.

### Slice 2

| Test | Must fail first with |
|---|---|
| `tests/unit/no-direct-transaction-in-erp.test.ts` | ⚠️ **22 files**, not the 21 this spec first estimated. The 21st is `app/reports/lib.ts` (re-export only, 0 direct calls); the 22nd is **`app/inventory/lib.ts`**, which a line-based grep could not see because its `transaction` import spans several lines. **The guard reads whole files and found it; the spec's own count was an undercount.** The three pre-auth files are allowlisted and must NOT appear |
| its control assertion | must pass immediately (>50 files scanned); if it fails, the glob is wrong and every other result in the file is meaningless |
| `rls.test.ts` — the folded helper arms RLS | pre-implementation the helper does not exist: a module-resolution error is an acceptable first failure here, but re-run after the helper lands and **before** the call sites change, so assertion 3 (no leak onto the next transaction) is proven on its own |

### Running them

Lane A's DB only: `node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_t228 <files>`.
⛔ Never `npm run test:integration` — it hits shared `shareat_test` and truncates a peer's fixtures.
Unit tests are `npm run test`.

### Smoketest on 9008, dev server running (bible §9.4)

Slice 1 — with two orgs seeded, and it is the whole point of the task:

1. `/inventory/transfers` → create a transfer. It still works, and `stock_transfers.org_id` is the
   signed-in org.
2. **The attack, by hand.** With devtools, add `<input name="orgId" value="<org B's id>">` to that
   form and submit. **Before slice 1 the row lands in org B. After it, the field is ignored and the
   row is the actor's.** Record both results in the report — this is the only evidence that
   converts DEF-210 from a reading of the code into a demonstrated defect.
3. `/inventory/returns` → record a return, then refund a credit. `/trade/returns` → record a
   return, apply a credit. All four post to the signed-in org.

Slice 2 — every one of the 20 touched files, because a missed principal shows as an **empty
screen**, not an error: `/expenses`, `/expenses/[id]`, `/ap/invoices/[id]`, `/commissary/orders`,
`/commissary/discrepancies`, `/inventory/low-stock`, `/inventory/returns`, `/inventory/transfers`,
`/sales-days`, `/sales-days/[id]`, `/trade/returns`, and `/` (the dashboard, which imports
`runReport` from the file losing its re-export). **A page that renders rows before and no rows
after is a caught bug, not a cosmetic one** — report it.

---

## Risk — the production trap, and how slice 2 closes it

Discovery 29 §5.3, restated because it is the reason for the sequencing and the orchestrator asked
for it here. Production has **zero organizations** (`docs/ops/README.md:31-34`), so no production
read path has ever run under its own RLS behaviour, and the repo does not say which role production
connects as — it is in `/srv/shareat-shared/.env.local`, and `docs/ops/provision.sh` creates no role.

| | **Prod role HAS superuser/BYPASSRLS** | **Prod role does NOT** |
|---|---|---|
| **Today** | the 5 DEF-210 sites are live and exploitable | the 34 paths return **zero rows** — those screens break on pilot day one |
| **After slice 1** | not exploitable; the 34 still have no backstop | 34 paths still break |
| **After slice 2** | ✅ safe — every authenticated path carries a principal | ✅ safe — every authenticated path carries a principal |

⭐ **Both columns are only safe after slice 2, which is why slice 2 is not optional and why both
slices want to land before `bootstrap-org` runs against production.** The fix is safe on an empty
database and awkward on a live one. Ian's probe (discovery 29 §7) tells us which column we are in;
it does **not** change what this task does, so slice 1 must not wait for it.

---

## Out of scope

| Not doing | Why |
|---|---|
| Routing the 123 `packages/domain` `transaction()` calls through a principal | 150 of 154 `tx \| null` signatures are fallbacks the app path never takes — motion, not risk reduction (discovery 29 §6 Option A) |
| A non-superuser role in production | Correct, and correct **after** this task — before it, enforcement becomes real only where CI cannot see it and 34 screens break in production and nowhere else (Option B) |
| The 31 integration files with no `asOrg` | They test domain logic, not isolation; 68 already carry one |
| `derived`-policy performance at ledger scale | Genuinely unmeasured — `journal_lines`' policy is a per-row `EXISTS` (`0011:130-133`) and the lane DB is empty. Measure after cutover with real data; guessing now would put a number in the record that nobody could defend |
| The `§6.3` citation sweep | Queued behind T-230 by the orchestrator — half its files are lane B's |
| Touching `authorize()`'s axis 1 | Making `ctx.orgId` mandatory is a 265-site change and a different task; T-231 removes the *source* of the bad value instead |

---

## Open questions — none blocks the build

1. **Should `applyPrincipal`/`withPrincipal` (the postgres.js pair) be deleted once the Drizzle
   helper exists?** They have no source callers, but the shape matches the 68 test `asOrg` helpers,
   and deleting them invites the next author to re-derive the idiom a fourth time. **Assumption
   taken: keep them, with a header line pointing at the Drizzle helper as the one applications
   use.** Reversible either way; say so if you disagree and I will change it before the build.
2. **`app/sales-days/page.tsx` and `app/sales-days/[id]/page.tsx`** are not on lane B's list but
   share its directory. **Assumption taken: include them in slice 2**, and defer only if lane B has
   them modified when slice 2 starts.
3. Whether the new guard also belongs over `apps/pos`, `apps/customer`, `apps/website` — they are
   reserved directories with no code. **Assumption taken: scan `apps/erp` only**; widen when a
   second app exists, so the guard cannot pass vacuously over empty trees.

---

## Done when

**Slice 1**
- `TENANT_FIELDS` guard was watched failing naming **3 files containing 5 read sites** (`orgId ×2`, `×1`, `×2`), then passes. ⚠️ **Corrected 2026-09-07**: the draft said "five named offenders". The scanner reports per FILE and counts occurrences, so 3/5 is the right pair of numbers; reported to the orchestrator rather than quietly satisfied.
- Three integration tests were watched failing with the **wrong org id stamped on the row**, then pass.
- `orgId` appears in none of the five entry-point input types, and `grep -rn "str(fd, 'orgId')" apps/erp/src` is empty.
- The hidden fields are gone from all four `.tsx` files, and `NewTransferForm` no longer takes the prop.
- Smoketest step 2 recorded **both** the before and after result of the hand-crafted attack.
- typecheck clean · `npm run test` green · lane integration green on `shareat_test_t228` · `npm run build` with the dev server stopped · self-reviewed line by line.

**Slice 2**
- The new guard was watched failing with **22 files**, then passes with **no exemption beyond the
  three pre-auth entries** (orchestrator R1 — slice 2 starts only after T-230 is committed, so
  `app/sales-days/lib.ts` is wrapped like the other 19).
- The three `rls.test.ts` assertions pass, assertion 3 having been proven before the call sites moved.
- Exactly one **staff**-principal helper exists in source: `packages/db/src/rls/principal.ts`.
  ⚠️ **Corrected 2026-09-07** — the draft said that grep returns ONE line. It returns **four**, and
  three of them are correct:
  `principal.ts:46` is `applyPrincipal`, the postgres.js pair kept deliberately (open question 1);
  `scheduler/index.ts:685` and `:726` are the **system**-principal variant, which sets
  `app.principal_kind` to `'system'`, not `'staff'`. ⛔ **My draft said those two "use it too". They
  do not** — folding them into `withOrgPrincipal` would silently change the declared principal kind.
  Nothing reads `app_principal_kind()` today (zero policies reference it), which is exactly why the
  distinction is easy to erase by accident.
- `apps/erp/src/app/reports/lib.ts` no longer re-exports `transaction`.
- All 20 pages smoketested on 9008 and **rendering the same rows as before the change**.
- The barrel line is handed to the orchestrator verbatim, not applied by this lane.
- Same gates as slice 1.

**Slice 3**
- The widened guard was watched failing with **1 offender** (`app/expenses/lib.ts` — imports getDb
  and calls getDb()), then passes with the same three pre-auth entries and no new exemption.
- `grep -rn "getDb" apps/erp/src` returns only prose in `reports/lib.ts` explaining the hazard.
- `listOrgs`, its `sales-days/lib.ts` re-export and the `OrgOption` type are gone; nothing in
  `apps` or `packages` references them. (⚠️ `schedulerRepo.listOrgsToRun` is a DIFFERENT function —
  the scheduler's deliberate system-principal lookup that must see every org before scoping,
  documented at `scheduler/index.ts:348`. Not a target.)
- Exactly three principal-idiom sites remain in source, one per distinct helper:
  `principal.ts:46` (`applyPrincipal`, postgres.js), `principal.ts:114` (`withOrgPrincipal`,
  Drizzle), `scheduler/index.ts:725` (`asSystem`).
- ⚠️ **The guard scans `apps/erp` only.** `packages/domain`'s scheduler legitimately opens
  unprincipalled transactions to resolve which orgs to run before any org is known — widening the
  guard there would forbid something correct.

**Both**
- Report ends with a `FOR IAN` block (RULES §2, §3.5).
- ⛔ This lane runs no `git`. The orchestrator commits.
