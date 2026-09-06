# Handoff — 2026-09-06 (second wrap-up)

## Where things stand

**Phase 6 is one task from done, and Phase 7's second half shipped today.** **T-222** — store
creation — went from *specced with zero code* to built, gated, smoketested and pushed in this
session. Until it landed, **nothing in the codebase created a store**: `dev-seed.ts` says so
outright, and the four dev stores were inserted by hand.

Everything is committed and pushed. `main` is `cc90516`, `origin/main` matches, tree clean. Five
commits this session: four for T-222, one recording an access decision that had been made by
accident.

⭐ **The one finding worth carrying forward is DEF-189, and it is about how it was found.** The
integration suite proved `AuthorizationError` is thrown — that test passed and always had. What
nothing covered was **what the thrown error BECOMES by the time a human reads it**, and the answer
was an **HTTP 500** for a manager clicking a store in a list they are allowed to read. A smoketest
that drives the ✗ path in a real browser is not ceremony; it is the only thing that saw this.

## Gates at `cc90516`

| Gate | Result |
|---|---|
| **typecheck** | exit 0 |
| **unit** | **1021 passed · 1 skipped · 1 failed** — `tests/golden/attendance-adjudication.test.ts`, DEF-170's 3 untriaged divergences. ⚠️ **Known red, unowned, NOT a regression** — it was red before this session and no work here touches attendance |
| **integration** | ✅ **2398/2398 · 95/95 files · exit 0**, lane `shareat_test_lane25`, 1260s. ⭐ **Re-run at HEAD after the DEF-189 fix, not carried over from the pre-fix tree** — the fix touched `apps/erp` only, but a number reported in a handoff should be one that was actually run against what is being handed off |
| **build** | ✅ exit 0, compiled 5.3s, dev server confirmed stopped **by process enumeration** first (`Get-NetTCPConnection` on 9008, not `pgrep`). Both `/admin/stores` routes present as `ƒ` |
| **smoketest** | ✅ **22 checks** on 9008 for T-222, plus **10 more** for the DEF-189 fix, plus **2** probing `/admin/users` for the same defect. Zero horizontal overflow at **390px** on both routes |

## What happened this session

### T-222 — store creation and management (`/admin/stores`)

Four commits. The service (`packages/domain/src/stores/service.ts`), the screens, the docs, and one
correction.

- **The atomic half and the derived half.** The store row, its default room and the
  CAPABILITY-MATRIX §C.2 fan-out to every active admin commit in **one transaction**, so the
  half-provisioned store v1 kept producing cannot exist. v1 had to report per-step because Firestore
  had no multi-document transaction; Postgres does. Readiness is **recomputed on every page load and
  stored nowhere** — bible row 123's lesson, because a stored "ready" flag survives the sales
  channel that satisfied it.
- **Rollback is proved by an INJECTED failure inside the transaction**, not a happy path. Atomicity
  is this design's whole advantage, and an untested rollback is a claim with nothing behind it.
- **Two spec defects reported rather than worked around** (RULES §3.4a). The spec says to build the
  default room by reusing T-160's `createLocation` — that **cannot work**, because it authorizes
  `manage_locations` at a store the actor cannot yet be scoped for, and **reordering does not rescue
  it**: the fan-out grants to `admin` roles only, so a **super_admin** creator still ends with no
  scope row. The room goes in through the repo; T-160's single-room **trigger** still refuses what
  `createLocation` would have. Second: a fresh org has **no `location_types` at all**.

### DEF-189 — a refusal that arrived as a crash

Filed and fixed. `storeDetail` now converts `AuthorizationError` **server-side, where `instanceof`
is still reliable**, and the page renders a sentence. It cannot be fixed in `app/error.tsx` — that
boundary deliberately does not branch on error type, because Next replaces a Server Component
error's message with a generic one plus a `digest` in production precisely to stop that detail
crossing it.

⭐ **The generalisation is narrower than it looks, and the obvious version of it is wrong.** The
trigger is **not** "an ungated list beside a gated detail page" — `/admin/users` is exactly that
shape and is **clean** (probed, HTTP 200 on both routes as a manager). The trigger is **calling a
domain function to satisfy a page read**, because domain functions authorize by contract.

### The access decision the unit suite caught

`manage_stores` **inherited** membership of `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` — §B's elevated
set is derived from the matrix table, so adding the row auto-joined it. **In an org with no admin, a
manager can open a branch.** Consistent with §B, but never decided for this capability. Pinned with
reasoning in `tests/unit/capability-matrix.test.ts` (92 → 93) rather than silently re-numbered, and
now written into the matrix row itself rather than living only in a test.

### Where each decision is recorded

| Decision / finding | Recorded in |
|---|---|
| DEF-189 + the "domain function in a page read" class | `docs/DEFECTS-REGISTER.md` |
| T-222 shipped, with what is still open | `docs/tasks/222-store-creation-and-management.md` status block |
| `manage_stores`, its ✗ test, and the admin-less elevation | `docs/decisions/CAPABILITY-MATRIX.md` |
| createStore = atomic half + derived checklist | `PROJECT_BIBLE.md` row 176 (committed earlier, `8a4e50f`) |
| T-222 done, phase headers | `docs/ROADMAP.html` — **T-222 now `t-done`**, both headers read T-218–T-224 |

**Roadmap: updated.** T-222's row went from `class="task"` to `class="task t-done"` with its note
rewritten from "specced, not built" to what shipped; both phase chips corrected. HTML verified
balanced (575 open / 575 close divs) after the edit.

## Pick up here

1. **T-214 — manager responsiveness scorecard. ⚠️ SPEC IT FIRST — there is no `docs/tasks/214-*.md`.**
   Checked this session: `docs/tasks/` jumps 213 → 217. T-214 exists only as a roadmap row and a
   paragraph in `docs/plans/phase-6-reporting-and-dashboards.md`, and this project's rule is **no
   implementation without a written task spec** (CLAUDE.md; Opus plans, Sonnet codes). So the first
   move is the spec, not the code. What the roadmap says it is: *action-rate + speed-to-resolve,
   re-weighted from v1's three components to two (no AI briefing to log opens against)* — and it is
   safe here in a way it was not in v1, because **T-135's findings can be acknowledged, never
   resolved**, so there is nothing to game by clearing a symptom. The phase plan's own line (§5.1,
   Wave 3) is more specific than the roadmap and is the better starting point: *"two components
   re-weighted, not three with a zero term; **the view log**; `/findings` gains the accountability
   half it was specced without"* — so there is a **new write path** in here, not only a report.
   Finishing it closes Phase 6.
2. **DEF-170's 3 golden-master divergences** — the only red in the suite, and **unowned**. It has
   survived several wrap-ups as "known red", which is how a red gate becomes furniture. Either
   triage the three or write down that they are accepted.
3. **The DEF-189 sweep, if Ian wants it.** The grep the register names returns **30+ files** in
   `apps/erp/src/app` that import `@shareat/domain` in a page read. Most import pure calculation and
   are fine; which of them reach an **authorizing** domain function is unknown. Sized, deliberately
   not done — it is a task, not a thing T-222 should have quietly absorbed.

## Do not decide these alone — they are Ian's

1. **T-222 open question 2 — should `deactivateStore` refuse while the store has an open sales day
   or unremitted cash?** Right now it deactivates **unconditionally**. Recommendation on the table:
   *yes, refuse and say which* — same shape as T-160's location-deactivation guard; deactivating a
   store holding uncounted cash loses the custody trail. **Questions 1 and 3 were answered by
   building** (the `code` is not in `UpdateStorePatch` at all; a manager gets a refusal page rather
   than a read-only view).
2. **Should `manage_stores` stay in the admin-less manager elevation?** In an org with no admin, a
   manager can currently open a branch. Reversible by adding it to the exclusion list. It was
   inherited, not chosen.
3. **T-221's composite FK** proposal — still open from the previous session.

## Traps that have actually bitten — live in this area right now

- ⛔ **Migration `0129` is applied on only 3 of 9 DBs.** Verified this session by reading
  `pg_policies` rather than trusting a note: **applied** on `shareat_dev`, `shareat_test_e2`,
  `shareat_test_lane25`; **missing** on `shareat_test`, `_lane15`, `_a`, `_b`, `_202`, `_203`,
  `_204`. Pick up a stale lane and you get DEF-183's cross-org hole back *and* a red `rls.test.ts`.
- ⚠️ **`pgrep -f vitest` in Git Bash cannot see Windows command lines** — it reported 0 while 9 ran.
  Use `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*shareat-system*' }`.
- ⚠️ **`shareat_dev` has ZERO `store_item_thresholds` rows**, so the low-stock features (T-223/224)
  cannot be exercised on dev data.
- ⚠️ **`next-env.d.ts` flip-flops** between `./.next/dev/types/` and `./.next/types/` depending on
  whether `dev` or `build` ran last. HEAD carries the **dev** variant; restore it rather than
  committing the churn.
- ⚠️ Backticks inside a `` sql`` `` template literal terminate the string — hit five times in the
  previous session. And backticks in `git commit -m` are **command substitution**: use `-F`.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then docs/RULES.md if you
haven't this session. Check ListAgents first — this tree is shared and a peer may be mid-task.

Pick up T-214 (manager responsiveness scorecard), the last Phase 6 slice. ⚠️ It has NO spec —
docs/tasks/ jumps 213 to 217 — so WRITE docs/tasks/214-*.md first, from the roadmap row and
docs/plans/phase-6-reporting-and-dashboards.md. Do not start coding from the roadmap alone.

T-222 shipped this session; don't re-derive it — docs/ROADMAP.html's Phase 6/7 sections and
the handoff's "What happened" cover it.

Before running test:integration, confirm your lane DB has migration 0129 (only shareat_dev,
_e2 and _lane25 have it). Before npm run build, confirm 9008 is free by process enumeration,
not pgrep.
```
