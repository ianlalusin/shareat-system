# T-491 — A lobby check-in is never committed before the phone holds its device cookie

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: Codex audit twelfth pass, finding F14
(`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-twelfth-pass.md`), re-verified on origin/main. Branch
`audit/t491-lobby-cookie-first`. Defect DEF-782. Numbers from the orchestrator (BOARD.md).

## Finding — DEF-782 (P2: a diner's first check-in can be orphaned)
`apps/customer/src/server/lobby/handlers.ts`: `:62-63` `cookie = readCookie(req) ?? newCookieValue()`; `:73`
`deviceHash = hmacHex(secret, cookie)`; `:67-81` `checkIn` commits inside `withOrgPrincipal` BEFORE the response is
built; `:92` `Set-Cookie` only on that success response. If the response is lost, the retry (same `clientRequestId`,
kept by `createCheckInAttempt`, `apps/customer/src/app/lobby/lobby-view.ts:25-33`) has no cookie, so a new hash;
`packages/db/src/repo/lobby.ts:263-269` answers `request_taken` (another phone used this id), mapped to
`LOBBY_BAD_INPUT` 400 (`packages/domain/src/lobby/checkin.ts:179`). The first entry stays in the queue, invisible to its
own diner, until it expires.

## Rulings
1. **Server: no cookie, no commit.** In the check-in handler, when the request carries no `lobby_dev` cookie, do NOT
   call `checkIn`; answer `428` (Precondition Required) with a refusal code `LOBBY_COOKIE_NEEDED` (add it beside the
   existing lobby refusal codes, same shape) and a `Set-Cookie` header carrying a fresh `newCookieValue()` (same
   attributes as today, `setCookieHeader`). Nothing is written. With a cookie, behaviour is unchanged (and the success
   response no longer needs to set one, since the request already had it).
2. **Client: one silent retry.** `apps/customer/src/data/http-lobby-data.ts` check-in: on `428` with
   `LOBBY_COOKIE_NEEDED`, retry the SAME request (same `clientRequestId`, same body) exactly once; the browser now holds
   the cookie (`credentials: 'include'`). A second `428` is shown as the existing server-error state. No other route
   changes.
3. The repo's `request_taken` rule (never reveal an entry by request id alone) is unchanged.
4. A lost response AFTER the cookie exists is already safe: the retry carries the same cookie, same hash, and the repo
   returns the same entry (`exists`).

## Tests (red first)
- `apps/customer/src/server/__tests__/lobby-routes.test.ts`: (a) check-in without a cookie → 428, `LOBBY_COOKIE_NEEDED`,
  a `Set-Cookie` with the existing attributes, and NO entry created; (b) the lost-response case: first check-in WITH the
  cookie commits, its response is discarded, the retry with the same cookie + same `clientRequestId` returns the SAME
  entry; (c) another phone (different cookie) reusing the id still gets `request_taken` (A5 unchanged). Update existing
  tests whose `mk()` sends no cookie for a check-in that should succeed: give them a cookie (no assertion weakened).
- `apps/customer/src/data/__tests__/lobby-data.test.ts`: 428 then 200 → one retry, same body, success; 428 twice →
  error state; any other status → no retry.

## Files
`apps/customer/src/server/lobby/handlers.ts`, the lobby refusal codes file it uses, `apps/customer/src/data/http-lobby-data.ts`,
the two test files above (plus any other lobby test whose no-cookie check-in expected success), `docs/DEFECTS-REGISTER.md`
(section E, DEF-782, full row shape — run `tests/unit/register-row-shape.test.ts`). Nothing in packages/.

## Acceptance
New tests red on origin/main for the stated reasons, then green; all customer-app tests green
(`npx vitest run` over apps/customer); customer typecheck clean; the WHOLE unit project green
(`npx vitest run --project unit`), not only guard/census files.
