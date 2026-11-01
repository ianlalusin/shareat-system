# T-505: ERP screen to register, list and revoke POS v2 tablets, and to clear a tablet's approval lock

**Status:** SPEC 1 Nov 2026 (POS2 switch-on session). T-505 given by BOSS 1 Nov, asked for by Ian 1 Nov ("admin or super admin can add a tablet as a terminal in the UI").
Process (BOSS): spec, then tests first, then build, then audit. Migration: none expected (ask BOSS for a number if one turns out to be needed; next free 0225).

## 1. The problem in plain words

A POS v2 tablet can approve refunds only after an administrator links its device id to the store's terminal person (T-424). Today that
means running `scripts/provision-terminal.ts --link-pos-device` by hand on the production server. On 31 Oct the Lipa switch-on needed it
three times and hit two more gaps that only a UI would have hidden:

1. Linking is a command line job: one wrong id and nothing explains why.
2. When the tablet's approval PIN is locked (5 wrong PINs in a day), the ERP cannot clear it: a terminal person has no page in
   `/admin/users` (`userDetail` lists people only, so `/admin/users/<terminal id>` is 404). Clearing it took a one-off script.

## 2. Rulings

- **R1. One new page, `/admin/pos-tablets`.** Not an extension of `/attendance/terminals`: that screen is the CLOCK-IN terminal (T-159, attendance punches); this is the POS tablet link. Different table, different meaning.
- **R2. Who.** Admin and super-admin only, for reading and writing. Capability `provision_clock_terminal` (store-scoped; admin/super-admin in the matrix), the one `provisionPosTerminalLink` and `revokePosTerminalLink` already check. **No new capability.** Registered in `ROUTE_CAPABILITY` and the nav; the read gate (T-288) applies.
- **R3. Store picker** at the top, same shape as `/attendance/terminals` (`?store=`). Only stores the actor may administer.
- **R4. Section "Linked tablets".** The store's ACTIVE link (device id, terminal no., terminal person name, linked on, linked by) and its last 10 revoked links. A **Revoke** button on the active one calls `revokePosTerminalLink`, through the same confirm pattern the other destructive buttons use (`ConfirmDestructive`).
- **R5. Section "Register a tablet".** Fields: device id (a uuid, pasted from the tablet's Settings > Terminal > Copy; trimmed, lower-cased), terminal no. (1 to 99), terminal person (a select of the store's terminal persons that hold a live firebase credential at that store). Submit calls `provisionPosTerminalLink`. If the store already has an active link, the form says in words, before submit, "This replaces the tablet ending ...abcd". The success message names the new link and the one it revoked.
- **R6. No terminal person yet.** If the store has none, the section says so and names the next step (create the store's tablet login in the Firebase console, then `provision-terminal --uid`). **Creating a terminal person from the UI is out of scope**: it needs a Firebase account this app cannot make.
- **R7. Section "Approval lock".** For each terminal person of the store: `pinAttemptsRepo.statusForActor`. Locked: "Locked since <time>. It lifts by itself after 24 hours." with a **Clear the lock** button calling `resetApprovalPinCap` (capability `manage_users`, org-scoped; the actor is an admin and is never the terminal, so the "nobody clears their own" rule does not bite). Not locked: "Not locked."
- **R8. No migration, no new table.** Only new READ functions, all in `packages/db/src/repo/` (the only place SQL is written): `posTerminalLinksRepo.listForStore(tx, orgId, storeId, { revokedLimit })` and `accessRepo.terminalPersonsForStore(tx, orgId, storeId)`. The writes are the three existing domain functions; this screen adds no SQL of its own.
- **R9. Errors** show through the existing flash pattern with the domain's own sentence. A device id that is not a uuid is refused before any query (the domain already does; the form also checks shape).
- **R10. Audit.** Provision, revoke and clear each already write an audit row inside their own transaction. The page adds none and never writes outside those calls.
- **R11. Out of scope.** Device pairing (T-464); anything inside the POS app; the terminal person creation (R6); clock terminals.

## 3. Tests (written first; real Postgres on a dedicated `_test` database for the integration half, any `_test` DB name per the no-lane-DB rule)

| Id | Case | Expected | Kills |
|---|---|---|---|
| P1 | Admin registers a device for store A | one active link row, audit row, `revokedLinkId` null | R5 |
| P2 | Same store again with a new device | new active link; the old one `revoked_at` set in the same transaction; one active link per store | R5 replace |
| P3 | A manager (no `provision_clock_terminal`) calls the register action and the revoke action | refused, nothing written | R2 |
| P4 | Device id `not-a-uuid`, and a device id already active at another store | refused with the domain sentence, nothing written | R9 |
| P5 | Revoke the active link | `revoked_at` and `revoked_by` set, audit row; revoking twice is refused | R4 |
| P6 | Terminal person capped (5 misses): clear | status `capped:false`; one `auth.approval_pin_cap_reset` audit row; clearing a not-capped terminal writes nothing | R7 |
| P7 | `listForStore` and `terminalPersonsForStore` for store A | only A's rows; a second org's store returns nothing (RLS) | R8 |
| P8 | Route census | `/admin/pos-tablets` is in `ROUTE_CAPABILITY` with `provision_clock_terminal`, in the nav, reachable; the destructive and row-link censuses are re-MEASURED, never edited by hand | R2 |
| P9 | Page unit: no terminal person | shows the R6 sentence and no form | R6 |

## 4. Plain-words acceptance (what Ian checks on the screen)
Sign in as admin, open Setup > POS tablets (right after Clock terminals), pick SharEat Lipa, paste a device id, press Register: the list shows the new tablet and the old one is marked revoked. A manager opening the same address is refused. A locked tablet shows "Locked since ..." and one button clears it.

## 5. Fences
Write only: the new page and its actions/lib under `apps/erp/src/app/admin/pos-tablets/`, the two read functions in `packages/db/src/repo/`, the nav and route-capability registrations, the tests, this spec, and the T-505 rows in the bible/register. Not `packages/domain/src/pos/terminal-link.ts`, not `scripts/provision-terminal.ts` (it stays as the fallback).

## 6. Open questions
- **Q1 (Ian).** Show the full device id or only its last 4 characters? Recommend the last 4 plus a copy button, since the id is not a secret but is long.
- **Q2 (BOSS) — ANSWERED 1 Nov.** Menu home: the Setup group, right after "Clock terminals", labelled "POS tablets" (follows the 1 Nov sidebar regroup, bible row 410).
