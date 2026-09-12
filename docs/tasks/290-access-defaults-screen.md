# T-290 — the access-defaults screen

> **Status: SPEC WRITTEN, 2026-09-12 — awaiting APPROVED.** Written in plan mode (Opus specifies,
> Sonnet builds — CLAUDE.md, 2026-09-09). Cut from
> [`docs/plans/289-position-access-defaults-plan.md`](../plans/289-position-access-defaults-plan.md)
> §5.1, the **authority** for this work, carrying Ian's five decisions of 2026-09-12. Cited by
> section, not restated; where the two differ, **the plan wins and the difference is reported, never
> designed around** (RULES §2, bible §3.4a).
>
> ⛔ **Sequenced AFTER T-289 lands.** Every domain function this screen calls
> (`setPositionDefault`, `retireStorePosition`) and the constant it renders from
> (`OFFERABLE_TO_POSITIONS`) are built in T-289. Starting this before that spine exists means
> inventing them twice.

## What this is

Plan §1, decision 3 — *"Whoever holds `grant_capability`"*, which is admin and above but **not** the
literal `super_admin` role (T-121 A.3 rules super admin is break-glass, not Ian's everyday login).
One screen that answers, per store, *"what can a Cashier do here?"* — positions across, capabilities
down, one cell per (position, capability), each toggle writing a `position_capability_defaults` row
and fanning it out to every current holder through T-289's `reconcilePositionGrants`.

## The gap this closes

T-289 ships the whole spine with **no way for a human to reach it**. Concretely, at the moment T-289
lands, `tests/unit/domain-actions-have-callers.test.ts` carries two `UNWIRED —` confessions
(T-289 §C12) saying exactly that — *"UNWIRED — … T-290 builds `/admin/access-defaults`; delete this
row when it lands."* This task is what deletes them. That file's third `it` fails an exemption whose
export now **has** a caller — *"the whole point of the exemption being a confession rather than a
setting"* (`tests/unit/domain-actions-have-callers.test.ts:258-268`) — so **deleting those two rows
is part of this task's contract, not tidying afterwards.**

## Scope

Plan §5.1 and the plan §9 T-290 row.

### Files this task may touch

1. `apps/erp/src/app/admin/access-defaults/page.tsx` — **new**
2. `apps/erp/src/app/admin/access-defaults/actions.ts` — **new**
3. `apps/erp/src/app/admin/access-defaults/lib.ts` — **new**
4. `apps/erp/src/components/nav.tsx` — **one line**, the Setup group (§C8)
5. `apps/erp/tests/access-defaults-lib.test.ts` — **new** (§T1)
6. `tests/unit/domain-actions-have-callers.test.ts` — **delete two `EXEMPT` rows** (§C9)
7. `tests/unit/nav-route-reachability.test.ts` — ⚠️ **only if a floor assertion needs raising**; see §C8
8. `apps/erp/tests/touch-target-baseline.json` — ⚠️ **only if the sweep genuinely demands it**; see §C10
9. `docs/tasks/290-access-defaults-screen.md` — this file

⛔ **Not in this list:** every file T-289 owns (`packages/**`), `apps/erp/src/app/admin/users/**`
(that is T-283's and T-291's), `packages/auth/src/authorize.ts`. RULES §3.3 — *a spec names the exact
files you may touch. If you must go outside it, say so explicitly in your report.*

**Not mine:** `PROJECT_BIBLE.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`,
`docs/DEFECTS-REGISTER.md` — the orchestrator's, per standing protocol.

---

## Contract

### C1 — the route and its three files, in the `admin/users` pattern

`/admin/access-defaults`. Server component + server actions + `redirect('?ok=…')`, exactly the shape
`apps/erp/src/app/admin/users/` already uses (`page.tsx` renders, `actions.ts` is a set of thin
`'use server'` adapters, `lib.ts` holds the server-only reads and the pure decisions). Do not invent a
fourth layout; RULES §3 — *one uniform, reusable pattern set; familiar-but-upgraded, never
reinvented.*

- `page.tsx` opens with `const { actor } = await requireSession('/admin/access-defaults')`
  (`apps/erp/src/lib/session.ts:84-91`). ⛔ This is not optional politeness:
  `tests/unit/no-ungated-read-surface.test.ts` fails any page that imports a database handle without
  one of `requireSession(` / `requireActor(` / `currentSession(` / `reportScope(`.
- `export const dynamic = 'force-dynamic'` and a `metadata` title, as
  `admin/users/[personId]/page.tsx:14-15`.
- Every database read goes through `withOrgPrincipal` re-exported from `../users/lib`'s own source,
  `apps/erp/src/app/expenses/lib.ts:149` — ⛔ never `transaction()` directly
  (`tests/unit/no-direct-transaction-in-erp.test.ts`,
  `apps/erp/tests/withorgprincipal-chokepoint.test.ts`).
- The page renders inside `<Page density="form">` (`@/components/shell/Page`), as the sibling admin
  screens do.

### C2 — the gate: `authorize(grant_capability, {})` in EVERY action

Plan §5.1. Every mutating action in `actions.ts` calls
`await authorize(tx, actor, 'grant_capability', {})` — or reaches a domain function that does — inside
the same `withOrgPrincipal` transaction as its write.

⛔ **Do not re-implement the checks T-289 owns.** `setPositionDefault` and `retireStorePosition`
already carry the `authorize()`, the store-in-org check, the position-belongs-here check and the
offerable check (T-289 §C8). The action is a **thin adapter**: parse `FormData`, call the gated
function, redirect with a message. That is the rule `admin/users/actions.ts:9-15` states for itself —
*"a rule in one route file is a rule the next route file misses,"* which is how DEF-180 and DEF-223
happened.

⛔ **No `person_grants` write is made from this file.** Every row is written by T-289's primitive.
An action that reaches `accessRepo.grantCapability` directly has bypassed the reconcile and is wrong.

⚠️ The actor comes from the session, **never** from the form
(`tests/unit/no-client-supplied-actor.test.ts`, bible §7.1, landmine #17).

### C3 — the read is ungated, and the header says why

Plan §5.1: *"the page read is ungated like `admin/users/lib.ts`."* `lib.ts` must open with a header
comment that states it in terms, so the next reader does not "fix" it:

> Plain reads go straight to the repo layer with no capability gate — the gate belongs to the WRITE,
> not to looking at a configuration table. That asymmetry is deliberate and matches every other admin
> screen here (`/admin/users`, `/staff`, `/attendance/terminals`). ⚠️ **DEF-064's rule does not apply
> here.** That guard is about pages that read the **ledger** with no session at all; this page
> establishes the session (`requireSession`), reads only this org's own access configuration under
> `withOrgPrincipal`, and every write it offers is gated in `actions.ts`.

Model it on `apps/erp/src/app/admin/users/lib.ts:1-8`, which already says the first half.

### C4 — the store selector comes from the ACTOR's own scope

Not `listStores(orgId)`. The selector lists the stores **this actor holds scope for** —
`accessRepo.storeIdsForPerson(tx, actor.personId)` (`packages/db/src/repo/access.ts:291`) intersected
with the org's stores, ordered by name. Plan §5.1.

⚠️ An admin holds a scope row per active store because `assignRole` materialises them
(`packages/auth/src/roles.ts:133-147`, CAPABILITY-MATRIX §C.2) — there is **no structural admin
bypass in v2, deliberately** — so for an admin this is every store, by rows rather than by exception.
A `grant_capability` holder with narrower scope sees only their own stores, which is correct.

If the actor has no store scope at all, render the empty state and no grid: *"You have no store scope,
so there is nothing to configure here."* ⛔ Never fall back to "all stores".

### C5 — the grid: positions across, capabilities down

- **Columns**: the canonical six first (`CANONICAL_POSITIONS`,
  `packages/db/schema/employment.ts:56-63`, in that order), then this store's own positions by name.
  Read via `employmentRepo.listPositions(tx, orgId, storeId)`
  (`packages/db/src/repo/employment.ts:65`), which already filters `is_active = true`.
- **Each column header carries the holder count** — how many people have an open employment at this
  store holding this position. Plan §5.1. One batched query, never N+1.
- **Rows**: capabilities **grouped by `CAPABILITY_SCOPE`**, `store` → `org` → `platform`, exactly as
  T-283's `GrantPicker` groups them (`apps/erp/src/app/admin/users/[personId]/page.tsx:334-388`,
  whose `SCOPE_ORDER` and `SCOPE_NOTE` are the shape to reuse). This is not decoration: the scope
  note says *"also needs the store in scope — holding the capability is never sufficient alone"*, and
  putting it beside the capabilities it applies to is the whole reason T-283 grouped them.
- **Each cell is a full-width touch row**, the `settings/sales-channels/page.tsx:364-394` `Radio`
  idiom — *"touch targets are full-width rows, not bare dots — phone portrait is the canvas."*
  ⚠️ Lifted, not reinvented (RULES §3, UI/UX is a third authority).
- Phone portrait is the canvas: at narrow widths the grid becomes one position per section rather
  than a horizontally-scrolling table.

### C6 — the three excluded sets are NOT rendered; the staff matrix IS

Plan §4.3, and this is the one place the screen's job and the domain's disagree on purpose.

**Not rendered at all** — a row the domain refuses is a row that would only ever produce an error:

- `SUPER_ADMIN_ONLY_CAPABILITIES` (4 today: `approve_item`, `post_journal_entry`, `cross_org_access`,
  `view_franchise_sales` — `packages/auth/src/capabilities.ts:840`);
- every capability whose `CAPABILITY_SCOPE` is `'platform'` (2 today, both already in the 4);
- `close_period` (`CONDITIONAL_CAPABILITIES`, `packages/auth/src/capabilities.ts:790`).

That is exactly `OFFERABLE_TO_POSITIONS` (T-289 §C10) — **import it, never re-derive it here.**
A second derivation is a second source of truth, and the two will drift
(`packages/auth/src/capabilities.ts:829-833` says so about this exact family of constants).

**Rendered, as INHERITED and disabled** — the ~21 capabilities where `CAPABILITY_MATRIX[c].staff` is
`true`:

> ⚠️ **Shown, not hidden.** Plan §4.3: *"the screen's job is to make 'what can a Cashier do here'
> readable in one place, and hiding the 21 staff-matrix rows would make it lie by omission."*

Render them ticked, `disabled`, visually distinct, with the line *"Every staff member already has
this through the role matrix."* ⛔ A `disabled` input submits nothing, so there is no risk of the
form posting one — and the domain refuses it anyway (T-289 §C10), which is the layering this project
insists on: the screen explains, the domain enforces.

### C7 — one transaction per save; the banner; the two bulk actions

**Save.** One submission = **one** `withOrgPrincipal` transaction, all of it or none of it. Plan
§5.1. This is T-283's rule, carried forward with its reasoning intact
(`docs/tasks/283-multi-capability-grant.md`, and `admin/users/actions.ts:216-226`): *partial success
leaves an administrator reading a success banner while holding a half-applied authority change, and
"who could do this in March" stops being answerable from the row set alone.* **All or nothing, and
the error names the cell that caused it** (position + capability + store).

**The banner**, after a successful save — plan §5.1, this wording:

> Applied to 7 people. Your own row was skipped — ask another administrator.

The second sentence appears **only** when `skippedSelf` is true (Ian's decision 4: the administrator
who holds the position being toggled is skipped and **named in the banner**; self-grant stays refused,
bible §7 rule 5). Sum the `affected` counts across the submission's cells and report **distinct
people**, not cell-writes — the number an administrator is actually asking about. When nothing
changed, say so plainly rather than showing a success banner over a no-op.

**"Same for every store"** — offered on **canonical** rows only (a store-invented position belongs to
its store; plan §4.2). One `setPositionDefault` call per **active** store
(`accessRepo.activeStoreIdsForOrg`, `packages/db/src/repo/access.ts:315`) in **one** transaction.
⛔ All-or-nothing, and the error **names the store that refused**.

**"Copy defaults from…"** — for each active default at the source store whose position is
**canonical**, one `setPositionDefault(..., on: true)` at the target store, in **one** transaction.
⛔ Store-invented positions do not copy — they belong to the source store. Same all-or-nothing rule,
same naming-the-refusal rule.

⚠️ Both are copies, never links (decision 2). Nothing on this screen creates a relationship between
two stores' rows; it creates a second row.

### C8 — nav registration

`apps/erp/src/components/nav.tsx`, the **Setup** group, immediately after `/admin/users` — the screen
it is the sibling of:

```ts
{ href: '/admin/access-defaults', label: 'Position access defaults' },
```

⛔ Keep the exact single-quoted `href: '...'` literal shape — `nav.tsx:6` says so and
`tests/unit/nav-route-reachability.test.ts:82-85` matches only that form.

⚠️ **No test fixture edit is expected.** That guard reads `nav.tsx` and `git ls-files` **live**; its
direction-A check (every nav href resolves to a `page.tsx`) and direction-B check (every non-dynamic
route reachable from nav) are both satisfied by adding the entry and the page together. Its
`UNLINKED_BY_DESIGN` map is for routes deliberately **not** in nav — this is not one. Touch that file
**only** if one of its numeric floors (`> 20`, `> 50`, `> 40`) genuinely needs raising, and say so in
the report. ⛔ Never add this route to `UNLINKED_BY_DESIGN`: the plan asks for a menu entry, and that
map's own comment demands the *"why would a manager never be given a link to this?"* standard, which
this screen fails — a manager-plus who holds `grant_capability` is precisely who it is for.

⚠️ Not gated per-link, matching the `/admin/users` entry's own note (`nav.tsx:150-153`):
*"Hiding a link is presentation; the gate is the write."*

### C9 — delete the two `UNWIRED` confessions

`tests/unit/domain-actions-have-callers.test.ts`'s `EXEMPT` map: **delete** the `setPositionDefault`
and `retireStorePosition` rows T-289 added. ⛔ **Keep `reconcilePositionGrants`'s row** — it is
`INTERNAL —` and permanent (T-289 §C11's closed importer list is what keeps it internal). Deleting it
by association breaks that guard's second `it`.

### C10 — touch-target baseline

Build the controls compliant and the sweep stays silent. `apps/erp/tests/action-link-sweep.test.ts`
reads `apps/erp/tests/touch-target-baseline.json`, which is keyed **per file** as a multiset of
modelled heights. Add an entry **only** if the sweep genuinely fails on a control that cannot be made
compliant, and say which control and why in the report.

⛔ That file's own `_note` is binding: *"do not edit this file to make a real regression disappear;
regenerate it only when a control genuinely leaves or enters the population."* Adding an entry to
silence a fixable control is exactly the edit it forbids.

---

## Invariants

1. ⛔ **`authorize()` is untouched and no position ever reaches it.** `packages/auth/src/authorize.ts`
   is not in this task's list. This screen writes rows; it does not teach the check path anything.
2. ⛔ **Every write on this screen goes through T-289's domain functions.** No `person_grants` write,
   no `position_capability_defaults` write, and no `authorize()`-then-write pair is composed inside
   `actions.ts`. The domain owns the rule; the route owns the sentence.
3. ⛔ **Additive only.** Nothing on this screen can switch OFF a capability the role matrix grants
   (Ian, decision 1). The staff-matrix rows are `disabled` for that reason and for no other.
4. ⛔ **All or nothing, per submission and per bulk action** — §C7.
5. ⚠️ **Self is skipped and NAMED**, never silently dropped (decision 4). A banner that says
   "Applied to 7 people" while the eighth was the reader themselves is the failure this wording
   exists to prevent.
6. ⚠️ **No new capability** — `grant_capability` already fits (T-154:167-176).
   `tests/unit/capability-matrix.test.ts` is not edited and its three `96` assertions stay green.
7. ⚠️ **The store selector never widens beyond the actor's scope rows** — §C4. "All stores" as a
   fallback is a structural admin bypass by another name, and v2 deliberately has none.

---

## Tests — write first, watch the right one fail for the right reason

### T1 — `apps/erp/tests/access-defaults-lib.test.ts` (new)

The pure decisions only, mirroring `apps/erp/tests/admin-users-lib.test.ts`'s shape (import the
functions from `../src/app/admin/access-defaults/lib`, no database):

1. `it('the grid offers exactly OFFERABLE_TO_POSITIONS, grouped by CAPABILITY_SCOPE')` — asserts the
   three excluded sets are absent from the offered cells, and that the grouping keys are
   `store` / `org` / `platform` in that order.
2. `it('staff-matrix capabilities are present as inherited-and-disabled rows, not omitted')` — §C6,
   the lie-by-omission rule, pinned as a test rather than left to review.
3. `it('the banner names the skipped self only when one was skipped')` — both branches of the plan's
   sentence, exact wording.
4. `it('copy-from-store offers canonical positions only')` — a store-invented position never appears
   in the copy set.
5. A floor assertion so an empty derivation cannot pass silently (DEF-179).

### T2 — the existing guards, which must go from red to green

- `tests/unit/domain-actions-have-callers.test.ts` — **red before this task** on the two stale
  exemptions the moment `actions.ts` names those functions, green after §C9's deletions. Confirm the
  red first; that is the failure this task's contract is built on.
- `tests/unit/nav-route-reachability.test.ts` — direction A (`href` resolves) and direction B
  (route reachable) both green with no edit to the test itself.
- `tests/unit/no-ungated-read-surface.test.ts` and `tests/unit/no-client-supplied-actor.test.ts` —
  green, which they will be if §C1 and §C2 are followed and red if they are not.
- `apps/erp/tests/action-link-sweep.test.ts` — green, §C10.

### T3 — smoketest on 9008 ⚠️ port discipline first

⛔ **Port 9008 is ERPv2's alone** (RULES §1 rule 12) — **and it is shared with every other lane on
this tree.** Before starting anything: **verify 9008 is free by enumerating processes**, not by
assuming and not by watching a browser fail. On Windows:

```
Get-NetTCPConnection -LocalPort 9008 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

If it is occupied, **it belongs to somebody** — coordinate with the orchestrator; do not kill it and
do not pass a different `-p`. T-283's own Definition of done already records the smoketest as *"owed,
port coordination with system32-85"*, so this is a live constraint on this tree today, not a
formality.

⛔ **Stop the dev server before `npm run build`** — the build clobbers the `.next` the dev server is
serving, producing unstyled pages and phantom errors (RULES §1 rule 10).

The pass, once the port is confirmed yours:

1. Sign in as an admin. `/admin/access-defaults` appears in **Setup** in the menu and opens.
2. The store selector lists your stores. Pick one. The canonical six are columns; the holder count is
   on each header and matches `/staff` for that store.
3. Tick one store-scoped capability for **Cashier**. Save. The banner reads *"Applied to N people."*
4. Open a holder at `/admin/users/<id>` — the grant is there. (Its *"via Cashier at …"* rendering is
   T-291; at T-290 it will read with whatever label `grantSourceLabel` currently returns.)
5. Untick it. Save. The grant is revoked on that person, with a reason.
6. Give yourself the same position (or use an admin who holds one) and toggle: the banner's second
   sentence appears — *"Your own row was skipped — ask another administrator."*
7. *Same for every store* on a canonical row, then check the second store's grid.
8. *Copy defaults from…* into an empty store; confirm the store-invented position did **not** copy.
9. A refusal path: sign in as the `enrol_staff` manager with no `grant_capability` and open the page —
   the read renders, the save is refused with a readable sentence, not a stack trace.
10. Phone portrait (390px) and 1280px both, since phone portrait is the canvas.

Screenshots at 390 and 1280 in the report, the standard T-241/T-250 already set.

---

## Out of scope

- ⛔ **Anything under `packages/`** — that is T-289. If this screen needs a read that does not exist,
  that is a **spec defect in T-289**: report it, do not add the read here (RULES §2).
- ⛔ **`apps/erp/src/app/admin/users/**`** — T-283 owns it today and T-291 owns it next. The
  *"via Cashier at Lipa"* rendering, the missing revoke control on a `'position'` row and the
  upgrade-to-`'grant'` banner are **all T-291**.
- ⛔ **Subtractive defaults, a deny toggle, or any control that removes a matrix capability** —
  decision 1. The staff-matrix rows are read-only and stay read-only.
- ⛔ **An org-level "defaults for every store" row that cascades** — decision 2. The bulk actions
  write N copies; they do not create a parent.
- ⛔ **A new capability to gate this screen** — `grant_capability` fits (T-154:167-176).
- ⛔ **Editing the role matrix from the UI** — T-121 rejects a database-driven permission engine.
- ⛔ **`PROJECT_BIBLE.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`,
  `docs/DEFECTS-REGISTER.md`** — the orchestrator's.
- ⛔ **Polish deferral note, from plan §10:** if production turns out to hold near-zero manual grants,
  *"T-290's polish (copy-from-store, same-for-every-store) is the part to defer, not the spine."*
  That measurement has not been taken, so build both — but if the orchestrator brings the number and
  it is near zero, this is the sanctioned place to cut.

---

## Definition of done

RULES §2's full list, plus:

- `npm run typecheck -- --incremental false` clean.
- Unit suite green, **including** `tests/unit/domain-actions-have-callers.test.ts` after §C9's two
  deletions and `tests/unit/nav-route-reachability.test.ts` in both directions.
- The new `apps/erp/tests/access-defaults-lib.test.ts` green, and **confirmed red first** for the
  right reason.
- **Smoketested on 9008**, ten steps above, with the port verified free by process enumeration
  **before** starting the server, and screenshots at 390 and 1280 in the report.
- `npm run build` succeeds **with the dev server stopped**.
- Self-reviewed line by line · report states real command output, numbers and exit codes, never a
  claim · report ends with a `FOR IAN` block.

---

### Model

Spec on Opus (plan mode). ⚠️ **Build is Sonnet-able**: three files in a pattern this repo already has
four instances of, one nav line, two test edits, and a grid whose columns, rows, grouping, cell idiom
and copy are all named above. The judgement — ungated read, scope-derived store list, shown-not-hidden
staff rows, all-or-nothing bulk actions, the banner wording, the exemption deletions — is resolved
here in writing. The one thing that needs a human in the loop is the **9008 port coordination**.

See `docs/plans/289-position-access-defaults-plan.md` §5.1 (the authority);
`docs/tasks/289-position-access-defaults-spine.md` (the spine this calls);
`docs/tasks/283-multi-capability-grant.md` (the grouping and the all-or-nothing rule);
`apps/erp/src/app/admin/users/` (the pattern); `apps/erp/src/app/settings/sales-channels/page.tsx`
(the touch-row idiom); `docs/decisions/CAPABILITY-MATRIX.md` §B, §C.2.
