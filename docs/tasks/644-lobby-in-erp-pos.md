# T-644: The customer lobby moves into the live POS (ERP /pos), so apps/pos can be deleted (T-588)

**Owner:** builder (Sonnet), one slice at a time. **Auditor:** Sonnet (security + authorization; claims slice also money/personal data). **Spec:** BOSS (Opus), 26 Nov 2026. **No migration expected** (if a slice finds it needs one, stop and ask BOSS for a number; next free 0289).

**Ian, 26 Nov 2026:** "Move lobby first" (before retiring pos2, T-588).

## Why
apps/pos (pos2) is the ONLY caller of the 16 `*ForTerminal` lobby / birthday / claims functions. The lobby is live at Lipa (docs/ops/customer-lobby-runbook.md:311). Deleting apps/pos today would switch it off. Discovery: shareat-coord/specs/644-discovery is this file's §Facts.

## Facts (origin/main, verified by discovery 26 Nov)
- pos2 identifies the tablet by Firebase token + `pos_terminal_links` → `TerminalActor`, no `authorize()` (apps/pos/src/server/pos2/lobbyRun.ts:18-35).
- ERP /pos identifies the tablet by pairing cookie + a signed-in ERP person holding `record_sale` (packages/auth/src/sessions.ts:542-568; apps/erp/src/app/pos/layout.tsx:23-32).
- **Actor twins already exist and are unused**: lobby/staff.ts:53-83 (parkWalkIn, listLobbyEntries, callEntry, seatEntry, removeEntry), birthday.ts:237-250, claims.ts:322-335. They `authorize(record_sale)`. USE THESE. Do not build a TerminalActor in ERP.
- Missing actor twins: pause/resume, claimStatus, and the extra parts of `listForTerminal`: `lobbyEnabled`, `paused`, each party's `lines`, and the **`lobby_stores.pos_seen_at` stamp**. Diners can check in only while that stamp is under 5 minutes old (checkin.ts:16). ⛔ The stamp is load-bearing.
- `seatForTerminal`/`seatEntry` does NOT open a table; it records `{sessionId, standLabel, joinUrl}` on the entry (core.ts:151-164).
- ERP tabs are a closed list in apps/erp/src/app/pos/_shell/tabs.ts:12-19. `_reservations/Reservations.tsx` is the closest pattern (list + Seat sheet: seat the table event, then the reservation-seated event, Reservations.tsx:141).
- ERP state poll (`/api/pos/state`, 3 s, version-gated) has no lobby field. Lobby tables do not bump `state_version`.

## Rulings (BOSS)
1. **Actor:** ERP person + pairing store via the existing actor twins. Store comes from `effectiveStore(pairing, …)` (pos/lib.ts:31), never from the body. Audit source stays as the twins write it.
2. **Transport:** server actions with `requireActor` + `actionStore`, like apps/erp/src/app/pos/refills/actions.ts. Online-only: the lobby needs the server anyway. Offline shows "Lobby needs the internet" and disables the buttons.
3. **Poll:** the Lobby tab polls its own list action every 10 s (pos2's beat), one in flight at a time. **The list action stamps `pos_seen_at`, and the poll runs while the POS is open on ANY tab** (mount the poller in the POS shell, not only on the Lobby tab). Reason: pos2 stamped from the always-visible cashier card, and Lipa's runbook says the lobby closes after 5 minutes without it. The Lobby tab shows a count badge.
4. **joinUrl = null.** ERP has no join-link source. The diner's phone shows the counter message (seatCore accepts null, core.ts:156).
5. **Birthday audio:** copy the two mp3s into apps/erp/public/sounds and play them with a plain `<audio>` element. No native plugin. If the real-tablet test fails, that becomes a follow-up (copy BirthdaySongPlugin into apps/pos-shell).
6. **Claims `statutoryDinerRef` = `${sessionId}:${dinerNo}`** (1-80 chars). Approving a claim does not apply a discount by itself. At payment, `DiscountSheet` pre-fills senior/PWD diner rows from the session's APPROVED claims: name, ID and diner number. The cashier still confirms. The money rule stays at payment (bill.ts:274), unchanged.

## Slices (each its own PR, in order)
**S1 — Lobby line (read + act, no seating).**
- Domain: actor `listLobby(tx, actor, {storeId})` returns `{lobbyEnabled, paused, entries (with lines), …}` and stamps `pos_seen_at` (reuse `listForTerminal`'s core). Actor `setLobbyPaused`.
- ERP: server actions list / park walk-in / call / remove (with confirm) / pause-resume.
- UI: Lobby tab (tabs.ts, `record_sale`) with the waiting count, a Paused badge, a Pause/Resume button, a tap-only code keypad + "Add walk-in", and rows with Call / Remove, a Called badge and "tap in by hand" for lines with no menu match. Shell-level 10 s poller (ruling 3).
- Tests: the stamp is written by the list action (mutant: drop the stamp → red); a person without record_sale is refused; the store comes from the pairing, not the body; pause round-trips.

**S2 — Seat.**
- The Seat button opens the same sheet as the Orders seat. It pre-fills heads = party size and the party's lines, mapped variantId → item via the snapshot menu. Lines with no match are listed for "tap in by hand".
- On confirm: send `stand.opened` through the outbox (new uuid), then call `seatEntry {sessionId, standLabel: stand number, joinUrl: null}`.
- If the lobby step fails after the table opened, the row shows "Seated, link not saved — Retry". The retry is kept in localStorage, ids only, like pos2's lobbyPending.ts.
- Tests: two-step order, retry path, mapping, and the offline refusal.

**Known gap (S2).** If the server later refuses the queued `stand.opened` (for example "stand in use (race)"; the outbox drops conflicts), the lobby already says seated with no table. The cashier sees the outbox conflict notice and must seat the party again from Orders. Reconciliation is out of scope for S2.

**S3 — Birthday songs.** List / accept (now or at a time) / decline (the 3 fixed reasons from pos2's birthdayPresets.ts) / played. The scheduler is a port of apps/pos/src/lib/birthday/scheduler.ts: 10 s countdown with Stop, localStorage per store with ids and times only, drops requests older than 30 min. Ruling 5 for audio. Use a banner, not a dialog, while the Orders sheet is open.

**S3 built (26 Nov).** Shell-level `BirthdayPrompt` (its own single-flight 10 s poll, scheduler and player; `listBirthdaysAction` / `acceptBirthdayAction` / `declineBirthdayAction` / `markBirthdayPlayedAction`, paired tablet only, `onlyStoreId` on the staff twins). The two mp3s are in `apps/erp/public/sounds`; they are NOT precached by `sw.js` (the lobby is online-only, the file is streamed when played). A song the browser refuses to start shows a "Tap to play" bar (held in memory only; a reload drops it and the server expires the request 30 minutes after its time). The domain now checks the accept time and the decline reason AFTER the store check. Tablet test at Lipa still owed (ruling 5).

**S4 — Discount claims.** Actor `claimStatus` twin. A claims strip on the Lobby tab and a claim dialog: open → name/ID kept in the dialog's memory only (masked in the list) → "card seen" tick → approve with ruling 6's ref, or reject with fixed reason chips only (no free text). `DiscountSheet` pre-fill per ruling 6. Tests: approve refused without cardSeen / without a seated session; free-text reject refused; no ID number in any list projection; the pre-fill never applies a discount without the cashier's confirm.

**S4 built (26 Nov).** Domain: `claimStatus` and `approvedClaimsForSession` actor twins, `onlyStoreId` on `openClaim` / `approveClaim` / `rejectClaim`, repo `listApprovedClaimsOfSession`. Actions (paired tablet only): `listClaimsAction`, `openClaimAction`, `claimStatusAction`, `approveClaimAction` (ref = `${sessionId}:${dinerNo}`), `rejectClaimAction` (4 fixed codes), `approvedClaimsForSessionAction`. UI: `ClaimsStrip` on the Lobby tab, `ClaimDialog` (name and ID in its own memory only). **Ruling 6 gap, needs BOSS:** the database NULLs the name and ID number when a claim is approved (`lobby_discount_claims_personal_data_check`), so the payment screen can be pre-filled with the KIND, the DINER NUMBER and the ID LAST 4 only, not the name or full ID. `DiscountSheet` offers each approved claim as a quick-pick (kind + diner number; the cashier still taps Add discount) and `PaymentPanel` notes the last 4 under that diner's ID box. Options: keep this (no migration, no stored ID), or hand the name and ID from the dialog to the paying screen in tablet memory only, or a migration that keeps them to payment. `npm run census:write` is owed (touch-target totals).

**Then T-588** lands (branch chore/t588-retire-apps-pos), with the production-caller baseline showing the `*ForTerminal` names leaving (delete those terminal wrappers in T-588 if nothing calls them).

## Not in this task
Join links for ERP sessions. A native birthday plugin (unless S3's tablet test fails). Any change to the lobby's diner side (apps/customer).

census:write; tsc -p apps/erp + new package test files; impeccable for the Lobby tab; browser check on BIBO; real-tablet check at Lipa before T-588 production steps.
