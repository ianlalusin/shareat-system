# T-301 — DEF-333: census of pre-auth reads/writes under a non-bypassing `DATABASE_URL`

> **Status: CENSUS ONLY, lane A (webapps-65, Sonnet 5), 2026-09-13. No fix in this slice — no file
> outside this one was touched.** Sent as `[LANE A] READY` to system32-85 with this census.

## The question, restated

Which code paths execute a database read or write through ordinary `transaction()` (or any route
resolving to `DATABASE_URL`) at a moment when no organisation principal can possibly be set — and
therefore now silently return zero rows in production, since `DATABASE_URL` names `shareat_app_prod`
(non-bypassing, FORCE RLS applies)?

## Bottom line, up front

**One new file. `apps/erp/src/app/sign-in/page.tsx:46`.** Bible §13 row 194 closed the cross-org
list at four subsystems plus a named four-lookup auth door; this is a fifth *kind* of pre-auth
read that row 194's census did not reach, because it lives in a page component, not in the
auth/session/scheduler/ETL modules row 194 was scanning. I looked hard for siblings — the rest of
this document is the evidence for why I did not find any — and I would rather report "one file"
with the method shown than a longer list built by pattern-matching on suspicion.

## Method — how I looked, so the negative result is checkable

1. **Reused the existing, build-enforced, mechanically-verified guard rather than re-deriving its
   answer by hand**: `tests/unit/no-direct-transaction-in-erp.test.ts` (T-231/DEF-209/DEF-215) scans
   **every tracked `.ts`/`.tsx` file under `apps/erp/src`** (its own positive control asserts the
   scanned set is `> 50` files — I ran it and it reports the real count) for an import, re-export, or
   call of `transaction` or `getDb` — the two raw, unprincipalled handles. It maintains a named,
   closed `PRE_AUTH_PATHS` exemption list and, since DEF-296, refuses a STALE exemption (one that no
   longer reaches a raw handle) as hard as it refuses a new unlisted one. **I ran it — real output,
   not assumed**:
   ```
   npx vitest run --project unit tests/unit/no-direct-transaction-in-erp.test.ts
   Test Files  1 passed (1)
        Tests  4 passed (4)
   ```
   All four assertions green, right now, on the pre-fix tree. This is a comprehensive, repo-wide
   answer for `apps/erp/src` specifically — not a sample.
2. **Read every file that guard currently exempts**, in full, to judge each on the merits rather
   than trust the exemption's age: `sign-in/actions.ts`, `sign-in/page.tsx`, `lib/session.ts`.
3. **Read every file in `sign-in/` and `setup/`** (all eight files across the two directories) —
   the two genuinely pre-auth directories — in full, not just the ones already flagged.
4. **Grepped for the two raw handles at column zero** (`^(const|let|await|export const)\s.*\b
   (transaction|getDb|getSql|systemTransaction|authTransaction)\(`) across `apps/erp/src` and every
   `packages/*/src`, to catch the category system32-85 named explicitly — "anything that runs at
   module load or during app boot." Zero hits in both trees.
5. **Checked every other Next.js special file** the orchestrator named: `middleware.ts` does not
   exist anywhere under `apps/erp` (confirmed by `find`, not by assuming the convention wasn't
   used) — no candidate to examine. `error.tsx` and `not-found.tsx` read in full: neither imports
   `@shareat/db` at all. Root `layout.tsx` and the `AppShell` component it renders: no `@shareat/db`
   import (`AppShell.tsx`'s only mention of it is a code comment, not an import). `apps/erp/src/app/
   api/health/route.ts`: the one real hit outside the guard's two named handles — see below.
6. **Confirmed `apps/pos`, `apps/customer`, `apps/website` hold zero source files** (`find … -name
   "*.ts*"` returns nothing for all three) — the "other apps" the orchestrator's brief worried about
   do not exist yet to have a pre-auth surface in.
7. **Spot-checked, did not exhaustively audit, the `packages/domain/src` bare-`transaction()`
   pattern** (below, under "Considered and cleared without a full audit") — recording the reasoning
   for why this is out of THIS census's scope rather than silently skipping it.

## Premise check 1 — is `stores` really FORCE RLS with an unsatisfiable policy, or something else?

Read `packages/db/migrations/0011_row_level_security.sql:81-84`, the only place `stores` is ever
enabled for RLS, and grepped every migration file for any later `POLICY … ON "stores"` (there is
none — the only other `ON "stores"` hit anywhere in `packages/db/migrations/*.sql` is an unrelated
`AFTER INSERT` trigger in migration `0029`, not a policy):

```sql
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
CREATE POLICY "stores_org_isolation" ON "stores" FOR ALL
    USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
```

**Confirmed: it is the mechanism, unchanged since creation, not something else producing the
zero.** `applyPrincipal` (`packages/db/src/rls/principal.ts`) is what sets `app.org_id` via
`set_config(..., true)`, scoped to one transaction; a bare `transaction()` never calls it, so
`app_current_org()` evaluates to `NULL` inside the query, `"org_id" = NULL` is `NULL` (not `TRUE`),
and `FORCE ROW LEVEL SECURITY` means even the connecting role's own rows are filtered by that
result — every row is excluded. This matches system32-85's live measurement (`stores: 0` under
`DATABASE_URL`, `stores: 1` under `SYSTEM_DATABASE_URL`) exactly, mechanism and symptom agreeing.

## Premise check 2 — are some of the flagged files actually fine already?

**Yes — two of the guard's three exemptions are stale in substance, though not in the mechanical
sense DEF-296 checks for.** Read both in full:

- **`apps/erp/src/lib/session.ts`** imports `transaction` (line 3) but **never calls it** — `grep -n
  "transaction(" apps/erp/src/lib/session.ts` matches only the word inside a comment (line 69). The
  file's own comment explains why: `currentSession()` passes `null` to `resolveActor`, which opens
  its own `authTransaction` internally (DEF-288's fix). The import is dead code.
- **`apps/erp/src/app/sign-in/actions.ts`** imports `transaction` (line 17) but **also never calls
  it** — `grep -n "transaction("` on this file returns nothing. Every real read/write in it —
  `signInWithPin(null, …)`, `resolveVerifiedSignIn(...)`, `signOut(null, token)` — is already routed
  through the closed auth door inside `packages/auth/src/sessions.ts`.

**Why the guard still lists both as exemptions and is correct to:** `reachesRawHandle()`
(`tests/unit/no-direct-transaction-in-erp.test.ts`) treats a bare *import* of `transaction` as a hit,
not only a call — so an unused import still "reaches" the handle by the guard's own (deliberately
conservative) definition, and DEF-296's staleness check only drops an entry when it reaches
**zero** hits of any kind. Both files still have the import statement, so the guard is not wrong to
keep them listed; it is that the import itself is now dead weight, not a live risk. **Worth a
one-line hygiene finding, logged in passing per bible §13 row 164, not a defect**: both dead
imports should be deleted next time either file is touched, so a future reader does not read the
import and wrongly conclude a raw handle is still reachable here.

**Net effect: of the three currently-exempted files, only one — `sign-in/page.tsx` — executes a
real, unprincipalled query in production today.**

## The one live defect — DEF-333

| | |
|---|---|
| **File:line** | `apps/erp/src/app/sign-in/page.tsx:46-50` |
| **What it reads** | `select id, name, code from stores order by name`, via bare `transaction()` |
| **Could a principal exist here?** | No — this is the page that lets a visitor with **no session**
  and **no chosen store** pick one. Choosing the store is how the org is discovered; there is no
  `orgId` to hand `withOrgPrincipal` yet. Structurally identical circularity to authentication
  itself (bible row 194's own words: *"you cannot scope the query to an organisation, because
  choosing the store is how the organisation gets discovered"*) |
| **What it does TODAY in production** | Zero rows, always, regardless of how many stores exist —
  confirmed by premise check 1 and by system32-85's live measurement |
| **What the user SEES** | The page's own conditional at line 68: `stores.length === 0` renders
  *"No stores exist in this database yet."*, and the PIN form is not rendered at all — matching
  Ian's exact report (*"no store is configured and PIN sign-in is DISABLED"*) |
| **Severity, stated in the same terms row 194 used for its own four** | An availability/UX defect,
  not a leak. `FORCE ROW LEVEL SECURITY` fails CLOSED — the failure mode is "shows nothing", never
  "shows another org's stores." The Firebase email path still works (it does not depend on this
  read), which is presumably why Ian could still get in as admin at all |

## Other candidates examined and cleared, with the specific reason for each

| Candidate | Why it is not a defect |
|---|---|
| `apps/erp/src/app/api/health/route.ts` | Imports `getSql` (`@shareat/db/client`), a **third** raw-handle-adjacent accessor the existing guard's `RAW_HANDLES` list does not name (only `transaction`/`getDb` are checked). Reachable with no session by design (it is the deploy/monitoring probe). **Cleared, not merely unflagged**: the only query it runs is `select 1 as ok` — no table, no RLS policy in play, so principal-or-not is irrelevant to its correctness. `getSql`'s own doc comment (`client.ts:47`) names exactly this use: *"use this only for health checks and DDL."* Worth naming as a **guard coverage gap** (RAW_HANDLES could include `getSql` for completeness) rather than a live risk — I have not changed the guard, this slice is census-only. |
| `apps/erp/src/app/setup/page.tsx`, `setup/actions.ts`, `setup/lib.ts` | All three route their only DB reads through `systemTransaction()` (the bootstrap door, bible row 195, T-267) — confirmed by reading `setup/lib.ts:27-28` directly. `setup/actions.ts` is also on `system-transaction-callers.test.ts`'s own `REQUIRED_CALLERS` list already. |
| `error.tsx`, `not-found.tsx` | Neither imports `@shareat/db` at all — read in full, no data fetching of any kind. |
| Root `layout.tsx`, `AppShell` | No `@shareat/db` import; `AppShell.tsx`'s only mention of the package name is inside a code comment explaining it deliberately goes through a capability "CHOKEPOINT" module instead. |
| `middleware.ts` | Does not exist anywhere under `apps/erp` — confirmed with `find`, not assumed absent. |
| `apps/pos`, `apps/customer`, `apps/website` | Zero source files in any of the three — nothing to examine. |
| Module-load-time DB calls (`apps/erp/src`, every `packages/*/src`) | Grepped for a raw-handle call at column zero (outside any function) in both trees. Zero hits. |
| `packages/domain/src`'s `transaction(tx ?? null pattern)` files (≈30, e.g. `expenses/create.ts:81-88`) | **Out of this census's scope, and spot-checked rather than exhaustively audited — reasoning shown so this is not a silent skip.** Every one of these takes an `Actor` as a required, non-optional parameter, which does not exist until a session has resolved — so by construction none is reachable pre-auth, whatever they do with `tx`. Spot-checked the representative case (`createExpense`): its only non-test caller (`apps/erp/src/app/expenses/actions.ts:207`) always supplies a `tx` already opened by `withOrgPrincipal(actor.orgId, …)`, never the bare-`transaction()` fallback branch — that branch exists for direct, non-HTTP callers (tests, scripts), not for the deployed app. A full audit of all ~30 files to confirm this pattern holds everywhere is a **different, larger census** (post-auth RLS-bypass risk, not pre-auth) and is presumably at least partly covered already by `tests/unit/rls-registry.test.ts` and `tests/unit/production-caller-ratchet.test.ts`, which I did not re-derive here. Flagging it as a candidate follow-up rather than either auditing it under this ticket or pretending it does not exist. |

## Options, laid out with costs — not decided here, per bible row 194's rule that adding to the closed list is Ian's alone

1. **Route the store list through a bootstrap-style system door**, the same shape T-267 gave
   `anyOrganizationExists`. Cheapest, and arguably the more *coherent* categorisation: listing
   stores so a stranger can pick one to attempt a PIN against is the same circularity as
   authentication itself, not a new kind of exception — it could plausibly be argued to belong
   **inside** the existing four-lookup auth door (a fifth named lookup) rather than as a wholly new,
   fifth subsystem on row 194's list. Either framing still needs Ian's named ruling; I am not
   choosing between them, only naming that the choice itself has two shapes.
2. **Give `stores` an RLS policy that admits an unprincipalled reader.** ⛔ **Not obviously safe,
   flagging per your explicit instruction**: with one tenant today a store's existence is not
   secret, but the moment a second organisation exists, this reads as "list every tenant's store
   names to any anonymous visitor" — the same shape of mistake DEF-210 already recorded for a
   different table. This option trades a five-minute fix now for a tenancy leak the day a second
   org signs up, unless the policy is written narrowly enough to avoid it (e.g. scoped to some
   "publicly listable" flag nothing currently has) — which is design work, not a one-line grant.
3. **Do nothing until multi-store sign-in is redesigned.** Not viable as stated: it leaves
   production's sign-in page broken right now, for every store, indefinitely.

## What I could not verify

No host or production access from this lane (forbidden by this cycle's briefing, and correctly
so). Everything above is read from the repository and from `system32-85`'s reported live
measurement, attributed as such rather than re-claimed as mine. I have not run the existing guard
test suite beyond the two files quoted above, and I have not modified anything — `git status`
shows only this new file.
