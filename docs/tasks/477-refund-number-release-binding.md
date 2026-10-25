# T-477 — The refund-number release route closes only this tablet's own, plausible numbers

**Status:** spec written 2026-10-24 (Opus planner, AUDIT session). Source: Codex audit fifth pass (2026-10-24,
`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-24-fifth-pass.md`, new P2), re-verified on `audit/t474-pos-refund-z`
ff8a01c. Same branch (PR #56, stacked on `claude/pos-v2-t470`). Defect DEF-771. Numbers from the AUDIT block.

## Finding — DEF-771 (P2, authorization)
`apps/pos/src/server/pos2/refund-number-release.ts` (T-474) checks only store membership, role and that the number is
well formed for (store code, terminalNo, terminalSeq). It never ties the request to the tablet that owns that terminal,
and never bounds the sequence. Any active cashier of the store can tombstone any number on any terminal, e.g.
`terminalSeq = 999999`; `lib/terminal/claim.ts` `highestSeq` counts tombstones, so the next claim of that terminal starts
past `MAX_TERMINAL_SEQ` and every receipt on it is refused. Smaller values fence another tablet's pending numbers.

## Rulings
1. **Bound to the registered tablet.** The body must carry `deviceId` (UUID, as other routes). The server resolves the
   device's registered terminal through the SAME trusted ERP link the PIN path uses
   (`auth.resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId })` in `server/pos2/deps.ts`), exposed as a new port
   `Pos2Deps.resolveTerminalNo({ posStoreId, deviceId }): Promise<number | null>` (no PIN). No link, or a link whose
   `terminalNo` differs from the body's → 403 "This tablet is not registered for that terminal." Firestore
   `terminals/{TT}` claim docs are NOT consulted (they are client-written; rule M10/B1 in `types.ts`).
2. **Bounded sequence.** Inside the transaction, read the highest existing `receiptNumbers` sequence for that store code
   + terminal (a doc-id range query, as `claim.ts` `highestSeq` does; tombstones count). A release is allowed only when
   `terminalSeq <= highest + RELEASE_WINDOW` with `RELEASE_WINDOW = 1000` (the same size as `RELEASE_GAP`). Beyond it →
   409 "That number is too far ahead of this terminal's receipts; a manager must check it." and nothing is written. The
   tablet's reconcile treats any refusal as "cannot tell": the row stays reserved for a person (already the T-474 rule).
3. Everything else in T-474 Finding 5 is unchanged (idempotent `released`/`used` answers, tombstone shape,
   `releasedBy`). The tablet client (`reconcileRunner.ts` via `postPos2`) already sends `deviceId`.

## Tests (red first) — `apps/pos/src/server/__tests__/refund-number-release.test.ts`
- missing/invalid `deviceId` → 400; device with no link → 403; link for terminal 2 asking to close terminal 1 → 403;
  none writes a tombstone;
- `terminalSeq = 999999` with highest existing seq 5 → 409, no tombstone; `highest + 1000` → allowed;
  `highest + 1001` → 409;
- the happy path and the existing release/refund race tests still pass with a linked device;
- reconcile: a 403/409 from the release call leaves the row reserved (existing "throw → reserved" case covers it; assert).
Fakes: extend the test deps with `resolveTerminalNo`; do not hit Postgres or Firebase.

## Files
`apps/pos/src/server/pos2/refund-number-release.ts`, `apps/pos/src/server/pos2/types.ts`, `apps/pos/src/server/pos2/deps.ts`,
the server test helper that builds `Pos2Deps` (wherever `makeDeps` lives), `apps/pos/src/server/__tests__/refund-number-release.test.ts`,
`apps/pos/src/lib/outbox/reconcile.test.ts` (one assertion), `docs/tasks/474-…md` (one line pointing here),
`docs/DEFECTS-REGISTER.md` (section E, DEF-771), `apps/pos/V1-COPY.md` only if it tracks an edited file. Nothing else.

## Acceptance
New tests red on ff8a01c for the stated reason, then green; whole POS suite green; POS typecheck clean;
`tests/unit/pos-v2-*`, `app-boundaries`, `app-workspaces` and the guard/census files green.
