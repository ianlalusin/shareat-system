# T-291 — inherited vs. held in their own right, on the person page

> **Status: APPROVED by the planner, 2026-09-12 — build after T-289 lands (T-283 landed in `8822cfa`).**
> ⭐ **§C3 is RULED: option 1, the explicit "Hold in their own right" control.** It is the only path
> by which decision 5's upgrade can be reached from this page, and a static sentence describing an act
> nobody can perform is the kind of help text that teaches nothing. Option 2 is withdrawn.
> ⭐ **§C1's arm:** T-289 lands it as the string `'Position default'` (plan §11.2); this task rewrites
> it to the sentence in §C1. Written in plan mode (Opus specifies,
> Sonnet builds — CLAUDE.md, 2026-09-09). Cut from
> [`docs/plans/289-position-access-defaults-plan.md`](../plans/289-position-access-defaults-plan.md)
> §5.2, the **authority** for this work, carrying Ian's five decisions of 2026-09-12. Cited by
> section, not restated; where the two differ, **the plan wins and the difference is reported, never
> designed around** (RULES §2, bible §3.4a).

## ⛔ Sequencing — two hard prerequisites, in this order

1. **T-289 must have landed.** `person_grants.source_ref`, `GrantRow.sourceRef` and
   `positionDefaultsRepo.describeSources` (T-289 §C15) are what this screen renders from. Without
   them there is nothing to read.
2. **T-283 must have landed.** Plan §5.2 says so in one line — *"Sequenced after T-283 lands: same
   file."* T-283 (`docs/tasks/283-multi-capability-grant.md`) rewrites the grant section of
   `apps/erp/src/app/admin/users/[personId]/page.tsx` — the single-`<select>` becomes a checkbox
   `GrantPicker` grouped by `CAPABILITY_SCOPE` (`page.tsx:334-388` in the working tree at the time
   this spec was written) — and edits `actions.ts` alongside it. **T-283 is in flight in another
   lane and is uncommitted.** Two lanes editing the same `page.tsx` is not a merge conflict this
   project should be paying for.

⛔ **Before writing a line, confirm T-283 is committed** (read the file and the log; do not take a
report's word for it). If it is not, **stop and report** — that is the task state, not a blocker to
work around. ⚠️ And read the file as it exists *then*, not as this spec quotes it: every line number
below is from the pre-T-283-commit working tree and will have moved.

T-290 is **not** a prerequisite. This screen reads rows; it does not need the screen that writes them.
But the smoketest is much easier once T-290 exists, so run it after if the sequence allows.

## What this is

Plan §5.2. After T-289, a person can hold a capability for a third reason: a **position default**.
Three things follow, and none of them happen on their own:

1. A `'position'` row must say **where it came from** — *"via Cashier at Lipa"* — or an administrator
   reading the page sees an unexplained grant and the honest-provenance work of T-248/T-256 stops
   at three of four sources.
2. A `'position'` row must offer **no revoke control here**. Revoking it on this page would be
   undone by the next `reconcilePositionGrants` — a control that appears to work and silently does
   not, which is worse than no control at all.
3. Granting the same capability **by hand** upgrades provenance to `'grant'` (Ian's decision 5), and
   the banner must say what actually happened rather than reporting a plain "granted".

## The evidence

| Fact | Evidence |
|---|---|
| `grantSourceLabel` is a closed `switch` over three sources plus `null`, with no `default` arm | `apps/erp/src/app/admin/users/lib.ts:100-110` |
| Under `strict: true` (`tsconfig.json:11`), adding `'position'` to `GrantSource` makes that switch non-exhaustive and **breaks typecheck** | `packages/db/src/repo/access.ts:367-388` defines `GrantRow.grantSource: GrantSource \| null`; `grantSourceLabel` declares `: string` |
| The grant list renders a revoke form on **every** active row, unconditionally | `apps/erp/src/app/admin/users/[personId]/page.tsx:160-184` |
| Its unit test pins all four current labels | `apps/erp/tests/admin-users-lib.test.ts:8-24` |

⚠️ **That second row is a reported spec defect against T-289** (see T-289 §C3's neighbours and this
task's report): the plan's file list gives `apps/erp/src/app/admin/users/lib.ts` to T-291, but T-289
cannot typecheck clean without a `case 'position':` arm in it. **If the planner resolves it by
letting T-289 add that one arm, this task finds it already there and simply improves the wording.**
Either way, the arm's final text is specified below (§C1) so both tasks write the same sentence.

## Scope

Plan §5.2 and the plan §9 T-291 row.

### Files this task may touch

1. `apps/erp/src/app/admin/users/[personId]/page.tsx`
2. `apps/erp/src/app/admin/users/lib.ts`
3. `apps/erp/tests/admin-users-lib.test.ts` — ⚠️ **not in the plan's §9 list.** Added because the
   plan's own rule set requires it: `grantSourceLabel` gains a fourth arm and that file pins the
   other three by exact string (`:8-24`), so it goes red the moment §C1 lands, and RULES §2 demands
   *tests before implementation*. **Reported to the planner as a one-line file-list amendment**, not
   taken silently.
4. `docs/tasks/291-person-page-inherited-grants.md` — this file

⛔ **Not in this list:** `apps/erp/src/app/admin/users/actions.ts` (§C3 explains why the banner needs
no change there), everything under `packages/` (T-289's), `apps/erp/src/app/admin/access-defaults/**`
(T-290's), `packages/auth/src/authorize.ts`. RULES §3.3 — *a spec names the exact files you may touch.*

**Not mine:** `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`,
`docs/HANDOFF-TODAY.md` — the orchestrator's.

---

## Contract

### C1 — `grantSourceLabel` gains its fourth arm

`apps/erp/src/app/admin/users/lib.ts:100-110`. One `case`, in the existing switch, before `null`:

```ts
case 'position':
  return 'via a position default — clears when the position or the default does';
```

⛔ **Keep the `null` arm exactly as it is** — *"source not recorded"*, and **only** that. That arm's
own comment (`lib.ts:94-99`) is T-256/DEF-247's ruling: DEF-237's residue is permanent and *"a
fabricated attribution would be worse than an absent one."* A fourth source does not make a
pre-0140 row guessable.

⛔ **Do not add a `default:` arm.** The exhaustive switch is what turned this change into a
compile error instead of a silently-wrong label, and that is the guard working.

### C2 — the row renders *"via &lt;position&gt; at &lt;store&gt;"*, and offers no revoke

`apps/erp/src/app/admin/users/[personId]/page.tsx`, the active-grants list (`:160-184` today).

**The data.** `userDetail` (`lib.ts:51-78`) already returns `grants` from
`accessRepo.grantsForPerson`, which after T-289 selects `sourceRef`. Add one batched read in the same
`withOrgPrincipal` transaction:

```ts
const sources = await positionDefaultsRepo.describeSources(
  tx,
  grants.map((g) => g.sourceRef).filter((r): r is string => r !== null),
);
```

⛔ **One query, never per row** — the shape `listEmploymentPositionsFor`
(`packages/db/src/repo/employment.ts:253`) already uses, and `describeSources` returns `[]` for an
empty input (T-289 §C15) so a person with no position grants costs nothing. Expose it on `UserDetail`
as a `Map<string, PositionDefaultSource>` keyed by default id, or as a `positionSource` field folded
onto each grant — either is fine; pick one and keep the page dumb.

**The rendering.** For an active row with `grantSource === 'position'`:

- the provenance line reads **`via Cashier at Lipa`** — the position name and the store name from the
  default the `source_ref` points at, **not** from the person's employment. (The default is the thing
  that justifies the row; an employment that has since changed is exactly the case the reconcile
  handles, and reading from it would make the line disagree with the row.)
- **no revoke form.** Plan §5.2: *"offers **no revoke control** here."* In its place, a link:
  *"Change this at [Position access defaults](/admin/access-defaults), or change their positions on
  their [employment](/staff)."*
- ⚠️ If `describeSources` returns nothing for a `source_ref` — which should be impossible, the FK is
  `ON DELETE RESTRICT` — render *"via a position default"* with no names rather than crashing or
  inventing a name. Fail readable, never fail confident.

**Revoked rows** (`page.tsx:186-204`) keep their existing `details` block; a revoked `'position'` row
shows the same *"via …"* line plus its `revokeReason`, which after T-289 §C7 step 4 reads
*"Position default no longer applies: Cashier at Lipa."* No change beyond the label.

⚠️ **Nothing else in the revoke path changes.** `setCapabilityGrantAction`'s revoke branch
(`actions.ts:222-232`) keeps its `authorize()`, its `requireRevokeReason` and its deliberate lack of
a self-check (*"revoking your own grant narrows authority, so it cannot escalate"*). Removing the
**control** from `'position'` rows is a presentation decision; the action stays exactly as gated as
it is, because a route that could be reached by other means must not become the weak one.

### C3 — the upgrade-to-`'grant'` banner

Ian's decision 5, plan §5.2: a hand-grant of a capability already held via a position **upgrades the
row to `'grant'`** — the existing provenance rank, one new entry (T-289 §C4, §C5 transition 1). The
row is then immune to the position sweep, which is the whole point.

The page must say so. Exact wording, plan §5.2:

> Already held via Cashier at Lipa — now held in their own right.

**Where it comes from.** ⭐ `grantableCapabilitiesFor(person.role).filter(c => !heldNames.has(c))`
(`page.tsx:44`) already removes every actively-held capability from the picker, so **an administrator
cannot select a capability the person holds via a position** and the upgrade cannot be reached from
this form as it stands today.

Therefore, in order of preference and **without touching `actions.ts`**:

1. **Offer the upgrade explicitly.** On a `'position'` row, beside the *"via Cashier at Lipa"* line,
   a small form posting that single `capability` to the existing `setCapabilityGrantAction` with
   `granted=true` — labelled **"Hold in their own right"**, with the sentence above rendered as the
   confirming help text. `grantCapabilityAsActor` (`packages/auth/src/roles.ts:550+`) takes it
   through its three checks and `grantCapability`'s idempotent branch performs the upgrade. One
   capability, one submission — T-283's loop handles a list of one without change.
2. If that reads wrong in review, render the sentence as **static help text** on the `'position'`
   row explaining what a hand-grant of it would mean, and leave the act to the picker once the
   capability is no longer held.

⛔ **Do not widen `grantableCapabilitiesFor` to re-offer actively-held capabilities.** That function
is shared with the picker, its own comment states the rule (*"Granting a capability the role already
has is a no-op row that makes the grant list harder to read"*, `lib.ts:80-91`), and widening it would
put ~96 already-held rows back in every person's picker to serve one case.

⚠️ **The self-grant refusal is untouched.** An administrator still cannot grant themselves anything
(`packages/auth/src/roles.ts:557-562`, bible §7 rule 5). On the actor's own page the control is not
rendered at all — `isSelf` is already computed at `page.tsx:40`.

### C4 — the summary line counts honestly

`page.tsx:63-66` reads *"N extra grant(s)"*. After T-289 an ordinary staff member may carry several
`'position'` rows they did not ask for, and calling those "extra grants" beside a role name is
misleading. Split it: *"3 inherited from positions · 1 granted."* Derived from `grantSource`, no new
read. ⚠️ Small, and in scope precisely because this task is the one that makes the old wording wrong.

---

## Invariants

1. ⛔ **No revoke control on a `'position'` row** — §C2. A control that the next reconcile silently
   undoes is worse than no control.
2. ⛔ **The `null` provenance label never becomes one of the four known ones** — §C1, T-256/DEF-247.
3. ⛔ **No new capability, no new gate, no change to any `authorize()` call.** This task renders what
   T-289 recorded. `packages/auth/src/authorize.ts` is not in the file list and
   `tests/unit/capability-matrix.test.ts` is not edited.
4. ⛔ **No `person_grants` write is composed on this page.** Every write still goes through
   `grantCapabilityAsActor` / `accessRepo.revokeGrantById` via the existing action.
5. ⚠️ **Provenance only ever upgrades** (T-289 §C4). Nothing on this screen demotes a `'grant'` row
   back to `'position'`, and there is no control that would.
6. ⚠️ **One batched read for the position sources** — §C2. An N+1 inside `userDetail` would be a
   regression against `listEmploymentPositionsFor`'s own stated reason for existing.

---

## Tests — write first, watch the right one fail for the right reason

### T1 — `apps/erp/tests/admin-users-lib.test.ts`

- **Red first, by construction.** Adding `'position'` to `GrantSource` (T-289) makes
  `grantSourceLabel` non-exhaustive: typecheck fails before any test runs. That is the right first
  failure. Then:
- `it('names the four known sources distinctly')` — extend the existing case (`:9-15`) with
  `'position'`, asserting §C1's exact string.
- The existing `it('⛔ a NULL source says "not recorded" …')` (`:17-23`) gains one more inequality:
  `expect(label).not.toBe(grantSourceLabel('position'))`. ⚠️ This is the assertion that stops a
  future reader deciding an unrecorded source "is probably a position default now".
- `it('a position-sourced grant is not offered a revoke control')` — the pure predicate behind §C2
  (e.g. `canRevokeHere(grant)`), exported from `lib.ts` so it is testable without rendering. Keep the
  predicate in `lib.ts` rather than inline in the page: that is what made `grantSourceLabel` and
  `requireRevokeReason` testable at all, and this file's header says so.
- `it('the summary line separates inherited from granted')` — §C4, both zero cases included.

### T2 — the existing suites stay green

`npm run typecheck -- --incremental false`, the full unit suite, and specifically
`tests/unit/no-client-supplied-actor.test.ts`, `tests/unit/no-ungated-read-surface.test.ts`,
`apps/erp/tests/action-link-sweep.test.ts` and `tests/unit/nav-route-reachability.test.ts` — none
should move, and any of them moving means this task went outside its files.

⚠️ The page renders a link to `/admin/access-defaults` (§C2). If T-290 has **not** landed yet, that
route has no `page.tsx` and `nav-route-reachability`'s direction-A check does not cover page links —
but the link would be a live 404. ⛔ **Either land T-290 first, or render the sentence without the
link until it exists.** State in the report which you did and why.

### T3 — smoketest on 9008

⛔ **Verify 9008 is free by enumerating processes before starting anything** — it is ERPv2's alone
(RULES §1 rule 12) and shared with every other lane on this tree; T-283's own Definition of done
already records a smoketest *"owed — port coordination with system32-85"*. On Windows:

```
Get-NetTCPConnection -LocalPort 9008 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

If occupied, it belongs to somebody: coordinate with the orchestrator. Never a different `-p`, never
a kill. ⛔ Stop the dev server before `npm run build` (RULES §1 rule 10).

The pass:

1. Toggle a capability on for **Cashier** at a store (`/admin/access-defaults`, or by hand through
   T-289's domain function if T-290 has not landed).
2. Open a holder at `/admin/users/<personId>`. The grant reads **`via Cashier at Lipa`** and has
   **no Revoke button** — a link to the defaults screen instead.
3. Use *"Hold in their own right"* (§C3.1). The banner reads *"Already held via Cashier at Lipa —
   now held in their own right."*; the row's label flips to **hand-granted** and the Revoke control
   appears.
4. Toggle the position default **off**. The row survives, still `'grant'` — decision 5, seen in a
   browser rather than only in a test.
5. Open a person with a pre-0140 grant (source not recorded): the label still reads *"source not
   recorded"* and has **not** drifted to the new one.
6. The summary line reads *"N inherited from positions · M granted"* and the numbers match the list.
7. 390px and 1280px. Screenshots of both in the report — the T-239/T-241 standard.

---

## Out of scope

- ⛔ **`apps/erp/src/app/admin/users/actions.ts`** — §C3 is built without touching it. If it turns
  out it cannot be, that is a **reported spec defect**, not a quiet file-list extension (RULES §2).
- ⛔ **Any change to the revoke gate, the self-grant refusal, or `requireRevokeReason`** — §C2's
  closing ⚠️. Removing a control is presentation; the action stays exactly as gated.
- ⛔ **Widening `grantableCapabilitiesFor`** — §C3's ⛔.
- ⛔ **A revoke-from-here path for position grants**, in any form — including "revoke and also switch
  the default off", which is a store-wide act being offered from one person's page. That belongs to
  T-290's screen, where the blast radius is visible.
- ⛔ **Showing a person's *positions* on this page.** This is the access screen; `/staff` is the
  employment screen. The link in §C2 is the seam.
- ⛔ **Everything under `packages/`** — T-289's. A missing read is a T-289 spec defect to report.
- ⛔ **`/admin/access-defaults` itself** — T-290's.
- ⛔ **`PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`,
  `docs/HANDOFF-TODAY.md`** — the orchestrator's.

---

## Definition of done

RULES §2's full list, plus:

- **T-283 confirmed committed before starting**, stated in the report with what you read to confirm
  it (not a claim that someone said so).
- `npm run typecheck -- --incremental false` clean — ⚠️ which after T-289 it will **not** be until
  §C1 lands; that red is the starting point, not a surprise.
- Unit suite green, including the extended `apps/erp/tests/admin-users-lib.test.ts`, **confirmed red
  first** for the right reason.
- **Smoketested on 9008**, seven steps above, port verified free by process enumeration first,
  screenshots at 390 and 1280.
- `npm run build` succeeds **with the dev server stopped**.
- Self-reviewed line by line · report states real command output, numbers and exit codes, never a
  claim · report ends with a `FOR IAN` block.
- ⭐ The report names whether §C3 shipped as option 1 (the explicit control) or option 2 (static
  help text), and why — that is the one open presentation call in this spec and Ian should see which
  way it went.

---

### Model

Spec on Opus (plan mode). ⚠️ **Build is Sonnet-able**: one switch arm, one batched read, one
conditional in a list that already exists, one small form, one summary line, and five test cases.
The judgement — no revoke control here, the `null` label untouched, the picker not widened, the
banner wording, the file-list amendment — is resolved here in writing. The two things needing a human
are the **T-283 sequencing check** and the **9008 port coordination**.

See `docs/plans/289-position-access-defaults-plan.md` §5.2 (the authority);
`docs/tasks/289-position-access-defaults-spine.md` (what it renders);
`docs/tasks/290-access-defaults-screen.md` (where the link goes);
`docs/tasks/283-multi-capability-grant.md` (the prerequisite in the same file);
`docs/tasks/248-def-237-revoke-elevated-grants-on-admin-arrival.md` (provenance);
`docs/decisions/CAPABILITY-MATRIX.md` §B.
