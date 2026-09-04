# Handoff — 2026-09-04

## Where things stand

**Phase 3 is 20 of 20 built — complete.** T-177 (POS item mapping and the daily usage pull) was
the last piece, unblocked once T-176's recipe/unit-conversion module shipped earlier today.
Alongside it, a separate session closed all eight accounting-foundation audit findings from
today's earlier audit (T-207 batch 1, T-208 batch 2 — DEF-156 through DEF-163). Production stays
live at https://erp2.shareat.net, unaffected by any of this.

## Gates at `5678d35` (HEAD, T-177)

**typecheck clean · unit 1013/1014 (1 pre-existing skip, unrelated) · integration 2257/2257 (full
suite, two runs — a repo-wide capability-matrix test needed `request_pos_map` added to its
universally-granted list after the first run) · build exit 0** (dev server confirmed stopped
first; `apps/erp/next-env.d.ts`'s dev↔build toggle is the only file the build itself touches,
committed alongside this handoff to keep the tree clean, per this repo's own standing note).
**Live-smoketested on 9008** end to end against a mock local POS server standing in for the real
`api/external/sold-items` (real `fetch`, not an injected stub): built a plan, finalized the direct
section, confirmed on-hand dropped by the sold quantity and a real `Dr 5160 / Cr 1310` entry
posted at FIFO cost.

Two commits before this one, from a different session, also gate-verified independently at the
time: `0b58842` (T-208) and `c3b7c3b` (T-207) — see their own commit messages for those numbers.

## What happened this session

**T-177 — POS item mapping and the daily usage pull, the mechanism this project's own exit gate
(Phase 3) cannot verify on its own.** A POS item now maps to one stock item, a production recipe
(exploded to one line per ingredient), or an explicit "sells, consumes no stock" — the third mode
is a recorded decision, not an absence, and stops the item resurfacing as unmapped every day.
Physical quantity only (sold + comped − voided, already netted by POS's own `sold-items` endpoint,
never the billable figure). At finalize, the server re-fetches POS live and rebuilds the plan,
refusing (`PLAN_CHANGED`) if a confirmed line no longer matches reality in either direction, and a
frozen location's lines get their own database savepoint so one frozen room never blocks the rest
of the day's pull. Finalize writes through T-168's existing usage-record layer and T-164's posting
engine — no second implementation of consumption. Meat maps like anything else now; v1's exclusion
(no per-location meat tracking) is closed structurally by T-145/T-161 and does not carry forward.

⚠️ **Two reasoned additions beyond the task doc's own contract table**, both documented in
`packages/db/schema/pos-mapping.ts`'s header: a `location_id` column on both `pos_item_maps` (a
per-item override) and `pos_usage_pulls` (the pull's own default) — v1 carries the identical field,
and a store can have more than one active operating room (T-160), so the contract as literally
written could not actually post anywhere. And three `*_finalized_at` timestamps plus a stricter
live-pull uniqueness (`where status <> 'void'`, not the literal `where status = 'planned'`) — the
spec's own wording didn't leave enough state to make "finalize is section-scoped and idempotent"
true independent of which individual lines succeeded.

⭐ **DEF-165 found in passing, logged, not fixed** — `production/index.ts`'s `scaleRecipeToTarget`
(T-176) divides its own already-correct result by an extra 1000, making its answer 1000x too
small. Dormant: zero callers anywhere, zero test coverage, so nothing has hit it. Out of T-177's
file scope to fix; `plan.ts`'s own recipe-scaling code has the corrected math with a citation.

**T-207/T-208 — the accounting-foundation audit closed out**, by a different concurrent session in
this shared tree: DEF-156 (a loan-entry reversal that didn't check the entry actually belonged to
the loan), DEF-157 (reimbursements payable had no payment path), DEF-158 (AR's credit-limit gate
lived in one caller instead of the primitive), DEF-159 (cash-request floats had no
liquidate-before-new-float gate or ageing alarm), DEF-160 (⛔ voiding a CAPEX expense left the
fixed asset it capitalised standing and still depreciating), DEF-161/162 (two chart-of-accounts
seeding/documentation corrections), DEF-163 (prepaid write-off had no undo counterpart). Full
detail in `docs/DEFECTS-REGISTER.md` and `docs/tasks/207-*.md`/`208-*.md`.

**Roadmap brought current**: Phase 3's chip moved from "19 of 20 built" to "20 of 20 built" and the
phase card itself from `s-active` to `s-done`; the masthead's gate counts and "Now in Phase 3"
line updated to today's real numbers; T-177's task row gained `t-done` and a real note. **T-207/
T-208 checked and deliberately NOT added to the roadmap** — they're `DEFECTS-REGISTER.md`-tracked
remediation work, not phase-plan tasks, and don't appear there at all (confirmed by grep before
concluding this).

**No decision from Ian this session needs a durable home beyond what's already recorded** — every
design call in T-177 was an implementer-level completion of an underspecified contract (documented
in-code, in the task doc, and DEF-165 in the register), the same disposition T-176 used for its own
two spec-defects. Nothing rose to a bible-amendment-level decision.

## Pick up here

1. **Phase 3 is done.** The next phase-plan work is whatever `PROJECT_BIBLE.md` §10's phase table
   names next — this session didn't open it, so state it plainly rather than guess.
2. **DEF-153** (bible infra summary / ADR-002 §5 still describing the rejected Cloud SQL +
   Firebase App Hosting architecture) is still open — an Opus-planner edit, unrelated to today.
3. Housekeeping, non-blocking: a small "T-177 Smoketest" store/item/person was left in
   `shareat_dev` from live-smoketesting T-177 (matches existing smoketest debris already in that
   database from prior sessions — Milkis/Pork-smoketest items, etc.). Harmless; delete whenever
   convenient.

## Do not decide these alone — they are Ian's

- **T-177's `POS_API_URL`/`POS_API_KEY`** are not configured anywhere real yet — no live POS
  integration existed before today. The pull will show a clear "not configured" error until a real
  environment sets them. Not a bug; just needs Ian's POS API key when the store is ready to go live
  with this feature.
- Carried over, still open: **DEF-154/155** (T-176 spec-vs-account-router mismatch — recommendation
  unchanged: correct the spec text, don't add an unused `prepped` item kind) and **T-178's
  staff-charge disposition** (one flag flip away, waiting on Ian).

## Traps that have actually bitten (this area, right now)

- **A store can hold more than one active `operating` room** (T-160's `role` is not unique per
  store) — any new POS-adjacent feature that assumes "the" operating location will silently pick
  the wrong one for a multi-room store. T-177 resolves this with a per-map override falling back to
  a per-pull default; reuse that shape rather than re-deriving it.
- **A DB-level refusal (a frozen location, a closed period) THROWS — it does not return
  `{ ok: false }`.** A batch loop that wants "this item failed, the rest still succeed" needs its
  own Postgres savepoint (`tx.transaction()`) per group, never a bare `try`/`catch` with no
  savepoint — the first DB-level throw otherwise aborts the whole outer transaction and even the
  `catch` block's own writes are refused. See DEF-090's original lesson; T-177's `usage-pull.ts`
  applies it again for frozen-location groups.
- **Two sessions sharing one working tree will both touch `docs/DEFECTS-REGISTER.md`,
  `classification.ts`, `rls/registry.ts`, and barrel files, and both may need `repo/findings.ts`.**
  Coordinating directly by name (`SendMessage`) before either touches the shared file worked
  cleanly today — confirm neither side is mid-edit, let one land, then layer the other on top.

## The paste-ready prompt

```
Working in C:\Users\ianla\webapps\shareat-system. Read docs/RULES.md, then
PROJECT_BIBLE.md §10's phase table to find what comes after Phase 3 (now fully
built — 20 of 20). Run `ListAgents` first to check for a busy peer before
running any gate. Pick the next unstarted task doc under docs/tasks/, read it
in full, and follow docs/RULES.md's TDD and definition-of-done exactly:
typecheck, unit, integration against real Postgres, live-smoketested on 9008,
self-reviewed, then update that task doc's own status line and
docs/ROADMAP.html before committing.
```
