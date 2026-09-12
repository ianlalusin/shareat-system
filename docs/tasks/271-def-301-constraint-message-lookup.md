# T-271 — DEF-301: the message map is matched by prose, so a key can never be added for a hand-raised invariant

> **Status: COMPLETE, 2026-09-12.** Part 1 `627a856` (the lookup), part 2 `0517bae` (the CI guard).
> ⚠️ **A regression was caught in review, not by the gates:** the first pass gated the generic
> sanitiser on the wrong resolver and silently flattened DEF-279's five hand-authored sentences.
> The 26-row before/after table could not see it — all 26 are native violations that populate both
> the structured field and the prose. Fixed, and part 2 makes the trap a red CI run.

## Goal

`errorMessage` decides which friendly sentence to show by **searching the raw driver text for each
constraint name as a substring**. Replace that with a **structural lookup** on the constraint name
the driver already reports, so that a key added for a hand-written `RAISE EXCEPTION` actually
matches — and so the map's keys stop being a second namespace that merely resembles the counter's.

⛔ **The reason this is its own task and not a drive-by:** changing the matcher changes how *every*
already-mapped constraint renders. The handoff of 2026-09-12 names it as needing a before/after
pass. **That pass is the deliverable. The code change is four lines.**

## The situation, measured

`apps/erp/src/lib/constraint-messages.ts:125-133`:

```ts
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;          // ⛔ substring search over prose
  }
  const constraintName = parseConstraintName(raw);
  if (constraintName) return genericConstraintMessage(raw);
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '');
}
```

⭐ **The correct tool already exists in the same file and this function does not call it.** T-270
built `resolveConstraintName` (`:97`), which prefers the driver's structured `constraint_name` and
falls back to `parseConstraintName`. `recordIfUnmappedConstraint` (`:181`) uses it. `errorMessage`
does not.

⚠️ **Two facts measured by the orchestrator on 2026-09-12 — confirm both yourself, do not take them
from this spec** (a disposition in a register is a hypothesis too — DEF-279's lesson):

| Measured | Value | Why it matters |
|---|---|---|
| Keys in `CONSTRAINT_MESSAGES` | **26** | The size of the before/after pass |
| Keys that are a substring of another key | **0** | ⭐ The feared "shorter key wins by accident" collision **does not exist today**. The change is therefore far more likely to be behaviour-preserving than the handoff's warning implies — *say so if you confirm it*, because it shrinks the risk honestly rather than performing caution |

⭐ **Why the regression surface is expected to be near-nil, and what would disprove it:** a real
Postgres constraint violation populates **both** `constraint_name` and the message text (recorded in
`docs/discovery/33-def-279-live-trigger-bodies.md`). So for a genuine constraint, old and new agree.
The change bites only where the name appears in the prose but `resolveConstraintName` returns
`null` — **find out whether any of the 26 is like that; that is the whole question.**

## Scope — the exact files you may touch

- `apps/erp/src/lib/constraint-messages.ts` — `errorMessage` only.
- `apps/erp/tests/constraint-messages.test.ts` — the existing guard.
- **New** test file(s) for the before/after pass, under `apps/erp/tests/`.

⛔ **Do not touch** any of the ~48 action files that call `errorMessage`. If the change requires
editing a caller, **stop and report** — that means it was not behaviour-preserving and the spec is
wrong.

## Contract

1. `errorMessage` resolves the constraint name **once**, via `resolveConstraintName(err)`.
2. If a name resolves and is a key of `CONSTRAINT_MESSAGES` → return that sentence. **Exact lookup,
   never a substring search.**
3. If a name resolves and is **not** a key → `genericConstraintMessage(raw)`, as today.
4. If no name resolves → the existing prefix-stripped raw text, as today.
5. ⛔ **`errorMessage` stays synchronous and pure** (docs/tasks/252-*.md §3). It must not become
   `async`, must not record anything, and must not reach a database.

## Invariants

1. ⛔ **The `/setup` allowlist must not widen by a single entry.** `pre-session-message.ts:137`
   builds `WRITTEN_FOR_A_PERSON` as `new Set(Object.values(CONSTRAINT_MESSAGES))`, gating what text
   may appear in the URL of the **unauthenticated** setup page. This task changes the *matcher*, so
   `Object.values` must be unchanged — **prove it, do not assume it.** Adding or removing a key is
   out of scope precisely because it is a security-allowlist change wearing a formatting change's
   clothes.
2. `LOCALLY_MAPPED_CONSTRAINT_NAMES` and `recordIfUnmappedConstraint` keep their current behaviour.
   ⚠️ Note they already agree with the new matcher — this task makes `errorMessage` consistent with
   its neighbour, it does not invent a policy.
3. For all 26 keys, a **real** database error must render the **same sentence before and after**.
   Any difference is a finding to report, not a result to accept.

## Tests — the before/after pass is the point

⭐ **This is the deliverable. Write it first and watch it pass against the OLD code**, so the
comparison is a measurement rather than a story about one.

1. **Enumerate, do not hand-list.** Drive the pass from `Object.keys(CONSTRAINT_MESSAGES)` so a key
   added later is covered automatically. A hand-copied list of 26 is what drifts (DEF-242's lesson).
2. **Provoke each constraint for real**, against real Postgres on **your lane database
   `shareat_test_laneb`**. ⛔ Never `npm run test:integration` — it targets the shared database and
   truncates a peer's fixtures mid-run.
3. Capture, per key: the raw driver message, `err.constraint_name`, `errorMessage(err)` **old**, and
   `errorMessage(err)` **new**. Report the table.
4. ⚠️ **If a constraint cannot be provoked from a test**, say so by name and say why. Do **not**
   synthesise a fake `Error` whose `.message` merely contains the constraint name and call that the
   before/after pass — a synthetic error has no `constraint_name`, so it would exercise exactly the
   fallback path the change is about and prove the opposite of what it appears to prove. **That is
   the trap in this task.**
5. ⭐ **Then the thing the whole defect is about:** add a test proving a key **can now be added for a
   hand-raised `RAISE EXCEPTION ... USING CONSTRAINT`** and will match. Use one of DEF-279's five as
   the subject. **Prove the mechanism; do not add the five sentences** — that is T-272's call, not
   this task's, and the wording is a separate decision.

## Out of scope

- ⛔ **Adding, removing or rewording any entry in `CONSTRAINT_MESSAGES`** (invariant 1).
- ⛔ The ~38 action files with their own independent local fallbacks, and the screen-local maps in
  `remittance/actions.ts` and `till/actions.ts` — DEF-257's territory, a different and larger job.
- ⛔ `packages/db/migrations/` — lane A holds slot `0143`.
- ⛔ `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md`,
  `tests/unit/capability-matrix.test.ts` — the orchestrator's rows, edited today.
- ⛔ `packages/domain/src/ledger/post-entry.ts` and `packages/db/schema/` — **lane A owns these
  this cycle.**

## Done when

- typecheck clean · unit green · **integration green against `shareat_test_laneb`** · smoketested in
  the running app on 9008 — ⚠️ **the orchestrator runs the build and owns the port; you do not start
  a dev server.**
- The before/after table is in the report, all 26 rows, with any difference called out by name.
- The `/setup` allowlist is proven unchanged.
- Self-reviewed line by line.
- The report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-301, DEF-279, DEF-257, DEF-246; `PROJECT_BIBLE.md` §13 row 189;
`docs/discovery/33-def-279-live-trigger-bodies.md`.
