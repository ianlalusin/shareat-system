# T-253 — DEF-220: `/commissary/catalogue` opens on a branch, not a commissary

> **Status: 📝 SPEC WRITTEN — awaiting `APPROVED`.** Written by lane B (`webapps-f7`) in plan mode
> on Opus 5, 2026-09-10. Two scope items need a ruling before build (§7); everything else below is
> decided.

---

## 0. Context

`apps/erp/src/app/commissary/catalogue/page.tsx:28` defaults its Commissary selection to
`stores[0]`, so every user, every time, lands on a store that is not a commissary — Lipa, which has
no `commissary_links` rows — and the branch picker below renders empty until they know to switch to
Smoketest Commissary. Nothing crashes; there is a real empty state. It is a default-selection
defect, severity 🔸. Found 2026-09-07 by lane C in the standing browser sweep.

The half that matters is the test. A fix that swaps `stores[0]` for a different hard-coded index, a
name match, or a code match is the same defect wearing a new number. The test must assert the
**property** — the defaulted store has an outgoing commissary link — never a name, code or
position.

---

## 1. Goal

Opening `/commissary/catalogue` with no query string selects a store that **is** a commissary, or
says plainly that the organisation has none. It never silently selects a branch again.

---

## 2. Three findings from the reading pass, before the design

**(a) ⛔ The register's stated cause is wrong for this screen — the symptom is real, the
attribution is not.** DEF-220 and this task's original stub both say *"`listForOrg` orders
active-then-code, so the default is Lipa."* This page never calls `listForOrg`. `page.tsx:4`
imports `listStores` from `./lib`, which re-exports `apps/erp/src/app/expenses/lib.ts:68` — a
different query, ordered `asc(stores.name)`. `storesRepo.listForOrg`
(`packages/db/src/repo/stores.ts:124`, active-then-code) is what `/admin/stores` and `/findings`
call. Alphabetical order happens to put Lipa first too, so the observed symptom stands and the
remedy is unchanged — the design below reads whatever order `stores` already has and never depends
on which query produced it. **The register row should be corrected; that file is the
orchestrator's, not mine.**

**(b) The "signed-in store" half of the remedy will be `null` on virtually every real visit, and
the spec should not pretend otherwise.** `Actor` carries only `personId` and `orgId`
(`packages/auth/src/authorize.ts:50-53`) — there is no store on it. The store lives on
`ResolvedSession.storeId`, whose own doc comment reads *"The store a TERMINAL session is bound to.
**Null for a browser session, which is not.**"* (`packages/auth/src/sessions.ts:173-174`), and
`signInWithFirebase` writes `storeId: null` (`:134`). `/commissary/catalogue` is a back-office
browser screen. So the session clause is implemented because the remedy names it and it is correct
when a PIN/terminal session does reach this screen — but **the commissary-shaped fallback is what
actually fixes the defect in practice.** Both are tested.

**(c) `page.tsx` cannot be imported by a unit test, which decides where the logic lives.** It
imports `next/link` and `@/components/shell/Page`, and `@/` has **no alias in
`vitest.config.mts`** (only `@shareat/*` are mapped, lines 8-32) — a test importing it fails to
resolve, not to assert. Every comparable test in this repo imports a route's *lib* by relative path
instead: `findings-page-lib`, `settings-attendance-lib`, `setup-failure-redirect`,
`sign-in-safe-next`, `supplier-lib`, `till-page-lib` — six precedents, all
`from '../src/app/<route>/lib'`.

---

## 3. Scope — the exact files

**Create**
- `apps/erp/src/app/commissary/catalogue/default-store.ts` — pure, zero imports (§7.2 ruling
  requested; not in the briefed scope as written)
- `apps/erp/tests/commissary-catalogue-default.test.ts` — unit (§7.1 ruling requested on location)
- `packages/db/tests/integration/commissary-default-store.test.ts` — integration

**Modify**
- `apps/erp/src/app/commissary/catalogue/page.tsx` — the four edits in §4

**Not touched:** `apps/erp/src/app/commissary/catalogue/lib.ts` (`catalogueData`'s signature is
unchanged — see the cost note in §4) · the Commissary `<select>` continuing to list every store
(existing behaviour; a user may still open a branch by hand via `?commissary=`) ·
`docs/DEFECTS-REGISTER.md` · `PROJECT_BIBLE.md` · `docs/ROADMAP.html` · the status board · any
migration (none needed; this reads existing rows) · `packages/db/schema/**` ·
`apps/erp/src/app/cutover/**` (DEF-248 is T-254, its own commit) · lane D's and lane E's paths.

---

## 4. Design

One new pure leaf, one wire-up, two tests.

**`apps/erp/src/app/commissary/catalogue/default-store.ts`:**

```ts
/** T-253 / DEF-220 — which store this screen opens on when the URL names none.
 *
 * ⭐ Pure and dependency-free ON PURPOSE. The test that pins it must not import `@shareat/db`
 * (page.tsx cannot be imported at all — `@/` has no vitest alias), and a selector with no imports
 * is a selector whose test cannot go red for somebody else's reason. */
export interface StoreCandidate {
  readonly id: string;
}

/**
 * The first store that IS a commissary, or the signed-in store when that store is one.
 *
 * ⛔ Returns `undefined` when the org has no commissary — never a fallback to "some store", which
 * is DEF-220 itself. The caller renders an explicit empty state.
 *
 * ⚠️ Order comes from `stores` as given; this function never sorts, never matches a name or code,
 * and never indexes. Membership of `commissaryStoreIds` is the only thing it reads.
 */
export function selectDefaultCommissaryStoreId(
  stores: readonly StoreCandidate[],
  commissaryStoreIds: ReadonlySet<string>,
  signedInStoreId: string | null,
): string | undefined {
  // ⚠️ The signed-in store must also be IN `stores` — `commissaryStoreIds` and `signedInStoreId`
  // can in principle name a store outside this org's list; the returned id must always be one this
  // page actually knows how to render. (Caught by this file's own unit test's negative control —
  // the naive `commissaryStoreIds.has(signedInStoreId)` check alone let a ghost id through.)
  if (
    signedInStoreId !== null &&
    commissaryStoreIds.has(signedInStoreId) &&
    stores.some((s) => s.id === signedInStoreId)
  ) {
    return signedInStoreId;
  }
  return stores.find((s) => commissaryStoreIds.has(s.id))?.id;
}
```

⭐ **Which branch is the real fix, stated plainly per finding (b) — do not let this get
"simplified" away.** `signedInStoreId` is `ResolvedSession.storeId`, which is `null` for every
browser session (`packages/auth/src/sessions.ts:173-174`) — and `/commissary/catalogue` is a
back-office browser screen, never a PIN/terminal one. **So on this screen today, the first branch
never fires; the `stores.find((s) => commissaryStoreIds.has(s.id))` line is what actually closes
DEF-220.** The signed-in-store branch is kept because the remedy names it, it costs nothing, and it
activates automatically the day a terminal session ever reaches this route — but it is decoration
until then, not the fix. A future edit that "simplifies" this function by dropping the fallback
line because "the signed-in branch handles it" would silently reopen DEF-220.

**`page.tsx`, four edits:**

```ts
// 1. the session, not just the actor — storeId lives on the session (finding b)
const session = await requireSession('/commissary/catalogue');
const { actor } = session;

// 2. which stores ARE commissaries: every store holding an outgoing link, either status
const stores = await listStores(actor.orgId);
const allLinks = await withOrgPrincipal(actor.orgId, (tx) =>
  commissaryCatalogueRepo.listLinks(tx, actor.orgId),
);
const commissaryStoreIds = new Set(allLinks.map((l) => l.commissaryStoreId));

// 3. the one line DEF-220 is about — `stores[0]?.id` becomes the property-selected default.
//    The explicit ?commissary= override is UNCHANGED: any existing store may still be opened
//    by hand, branch included. Only the default moves.
const commissaryStoreId =
  sp.commissary && stores.some((s) => s.id === sp.commissary)
    ? sp.commissary
    : selectDefaultCommissaryStoreId(stores, commissaryStoreIds, session.storeId);

// 4. the existing guard now tells the truth about WHICH empty state this is
if (!commissaryStoreId) {
  /* …same <Page> block, message conditional on stores.length === 0:
     zero stores   → "This organisation has no stores yet."          (unchanged wording)
     no commissary → "No store is set up as a commissary yet. Link a branch to a commissary to
                      get started."                                  (new — no "pick a store
                      above" clause: this early return renders before the picker exists)      */
}
```

`commissaryCatalogueRepo` is imported directly from `@shareat/db` in `page.tsx`; `withOrgPrincipal`
is already re-exported by `./lib` (`lib.ts:19`).

**Cost, stated rather than hidden:** `listLinks` now runs twice per page load — once to pick the
default, once inside `catalogueData` (`lib.ts:47`), which filters it to the chosen commissary. The
default must be known *before* `catalogueData` is called, and consolidating would mean reshaping
`catalogueData`'s signature in `lib.ts`. One extra org-scoped read on a back-office screen is not
worth that diff on a 🔸 defect.

---

## 5. Invariants — decisions this spec makes explicitly

1. **"IS a commissary" = holds at least one `commissary_links` row as `commissary_store_id`,
   either status.** The remedy says "has an outgoing link" with no status qualifier, and this
   screen already treats "linked" as status-agnostic — `catalogueData` filters links by commissary
   id alone (`lib.ts:52`) and the Branches table renders active and inactive together
   (`page.tsx:95-127`). Decided, not overlooked.
2. **Org with NO commissary at all** → `selectDefaultCommissaryStoreId` returns `undefined`, the
   existing guard at `page.tsx:32` fires, and the user is told *no store is a commissary yet*
   rather than being shown a branch labelled as one. It does not crash, and it does not pick a
   branch. This is the state the briefing asked to be named.
3. **A signed-in store that is a commissary wins, even if inactive.** The remedy attaches no
   activity qualifier, and the actor is demonstrably working from that store.
4. **The explicit `?commissary=<id>` override is untouched.** DEF-220 is about the default only.

---

## 6. Tests — the half that matters

**Unit** `apps/erp/tests/commissary-catalogue-default.test.ts` — imports
`../src/app/commissary/catalogue/default-store`, no DB, no Next, milliseconds:

1. **Red first, for the right reason.** Written and watched failing against today's `stores[0]`
   behaviour before the source changes — a default-selection test that passes beforehand proves
   nothing.
2. **The property, on a deliberately hostile fixture:** the commissary sits at the LAST index and
   is alphabetically last; every earlier store is a branch. Asserts the returned id ∈
   `commissaryStoreIds`. Passes only if membership decided it — an index or a name match fails.
3. **Position-independence, executed not argued:** the same store list permuted (reversed, and
   commissary-first) returns a commissary id every time, asserted by set membership. No test in
   this file ever compares against a literal store name, code, or index.
4. **Signed-in store wins when it is a commissary** — including when it is not first in `stores`.
5. **Signed-in store is IGNORED when it is not a commissary** — falls through to a commissary, and
   the returned id is asserted ∈ the set (never equal to the signed-in id).
6. **No commissary anywhere → `undefined`**, with a non-empty store list. This is the "must not
   silently pick a branch again" clause, asserted directly.
7. **Negative control:** an empty store list and an empty set also yield `undefined` — so case 6
   cannot pass merely because the function returns `undefined` for everything.
8. **Negative control, added during build, that caught a real bug:** a `signedInStoreId` that IS
   in `commissaryStoreIds` but is NOT present in `stores` (a ghost id). The first implementation —
   `commissaryStoreIds.has(signedInStoreId)` alone — returned the ghost id and this test failed
   red; the fix adds `stores.some((s) => s.id === signedInStoreId)` (§3's contract, updated). Kept
   in the suite so the membership check cannot silently regress.

**Integration** `packages/db/tests/integration/commissary-default-store.test.ts` — real Postgres,
lane DB `shareat_test_t229`, imports nothing from `apps/`:

8. Two stores in one org, one link written from store A to store B. `listLinks` → the derived
   distinct-commissary set **contains A and does not contain B** — i.e. the branch that DEF-220
   used to default to is absent from the set by construction, against real rows rather than a
   fabricated array. Covers the one line the unit test cannot reach
   (`new Set(allLinks.map(...))`), and `listLinks`'s read side is currently pinned by no test —
   `packages/domain/tests/integration/commissary-catalogue.test.ts` exercises only the write paths
   and gates.
9. **Added during build:** an INACTIVE link still puts its commissary in the set — invariant 1 (§5),
   proven against a real row rather than only asserted in prose.
10. Zero links in the org → the set is empty → selection yields `undefined`. The zero-commissary
    state, proven on real data.

---

## 7. Two rulings requested before build

1. **Test location.** The briefing says unit tests go under `tests/unit/`. Every comparable test in
   this repo — including T-243's and T-246's, which the briefing itself cites — lives in
   `apps/erp/tests/`, and the unit project's `apps/**/*.test.ts` glob (`vitest.config.mts:59`)
   collects it. Root `tests/unit/` holds repo-wide guards, none of which import app source.
   **Requesting `apps/erp/tests/commissary-catalogue-default.test.ts`.** Say the word and it goes
   to `tests/unit/` instead — it resolves from there too, by a longer relative path.
2. **One new source file.** The briefed scope allows `page.tsx` only, which finding (c) shows
   cannot carry testable logic. **Requesting `apps/erp/src/app/commissary/catalogue/default-store.ts`**
   — new, pure, zero imports, ~20 lines, the T-246 `kiosk.ts` shape. The alternative inside the
   scope as written is a text-reading guard over `page.tsx`, which is a spelling match, not a shape
   match — the fourth instance of the thing the briefing told me not to add.

**No `packages/db/src/repo/` helper is requested.** A `select distinct commissary_store_id` would
be marginally cheaper than reusing `listLinks`, and I am declining it on purpose: lane E is
mid-build across `packages/db` with an uncommitted `src/index.ts`, and a 🔸 default-selection fix
is not worth touching a contended package for one query's efficiency.

---

## 8. Done when

**Mine:** the unit test watched RED before the change and green after · unit project green ·
integration test green on `shareat_test_t229` via
`node C:/Users/ianla/.claude/skills/orchestrator/tools/it.mjs shareat_test_t229 <files>` ·
typecheck clean for the files I touched (lane E's in-flight `packages/db` state is not mine and is
reported separately if it obscures the result) · diff self-reviewed line by line · READY with real
numbers and exit codes, the exact file list, and what I did not verify.

**Not mine, and not attempted** — both on my NEVER list: `npm run build`, and the browser pass on
9008. **Exact steps for the orchestrator:** sign in **by name, not index** (sign-in is
store-scoped), open `/commissary/catalogue` with no query string, and confirm it opens on
Smoketest Commissary with branches listed rather than on Lipa with an empty picker; then
`?commissary=<Lipa's id>` still opens Lipa by hand, unchanged.

**Orchestrator's:** DEF-220 row → fixed, plus finding (a)'s correction to that row's stated cause ·
`docs/ROADMAP.html` · the status board.
