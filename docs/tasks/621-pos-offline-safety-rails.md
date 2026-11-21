# T-621: POS offline safety rails (update gate, ₱50k unsent warning, X-slip every 4 offline hours)

**Owner:** builder (Sonnet) on the **DELL PC** (no database there: unit tests only; CI runs the migration and the full
suite). Auditor: Sonnet. **Spec:** BOSS (Opus), 21 Nov 2026.
**MIGRATION 0274** (seed two business-rule rows, hand-authored per ADR-012 §5; copy the shape of
`packages/db/migrations/0273_t614_pos_receipt_lookup_days.sql` and its journal entry, `when` = previous + 86400000).
**No Ian decision:** the values are decided (bible row 276; `docs/plans/pos-v2-design.md` lines 149-150, 385). Per the
no-hard-coded-settings rule they become business rules with a screen (Settings > Business rules already lists every
registry key, so no new page).

## Why

All three were promised in the POS v2 design (T-530 line 320) and none exists in `apps/erp/src/app/pos` or
`apps/erp/src/lib/pos-device`. Lipa goes live 7 Dec (row 431). Offline is rare at Lipa (1 offline receipt in 13,561 in
v1, `docs/discovery/42`), so this is insurance, but the update gate guards every deploy during service.

## S1 — update gate (the most important part)

Today `apps/erp/public/sw.js:136-146` calls `skipWaiting()` on install and `clients.claim()` on activate, and activation
deletes every older `shareat-pos-*` cache. A deploy during service therefore swaps the worker under an open till; the open
page keeps old code whose not-yet-loaded chunks were just deleted, so it can break offline.

- `sw.js`: stop calling `skipWaiting()` on install. Add a message handler: `{ type: 'activate-now' }` → `skipWaiting()`.
  Keep `clients.claim()` on activate.
- `apps/erp/src/app/pos/_shell/offline-sw.ts`: watch `reg.waiting` / `updatefound`. When a new worker is waiting, the page
  posts `activate-now` **only when** the outbox has 0 waiting events, no payment screen is open, and the till is online;
  then reloads once on `controllerchange`. Until then it checks again each time one of those three changes.
- Show a quiet note in the shell while held: "An update is ready. It loads when the waiting sales have sent." Never a
  modal, never blocks selling.
- First install (no controller yet) still activates at once.
- Update the existing `offline-sw.test.ts` pins (it pins `PREFIX`/`SHELL_KEY`); add the new message to what it pins.

## S2 — two business rules (registry + migration 0274 + snapshot)

- `packages/domain/src/business-rules/registry.ts`, namespace `pos`, `capability: RULE_ADMIN_CAPABILITY`, beside
  `pos.receipt_lookup_days`:
  - `pos.offline_unsent_warn_amount`: unit pesos, default `50000`, min `1000`, max `1000000`. Label "Unsent offline sales
    that warn the manager". Help in plain words: selling continues; it only warns.
  - `pos.offline_xslip_hours`: unit hours, default `4`, min `1`, max `24`. Label "Hours offline between automatic X-slips".
- `pos-rules.ts` readers for both; `packages/domain/src/pos/snapshot.ts:31` and `shared.ts`: carry both in `rules`
  (amount as centavos integer, like `saleVarianceToleranceCentavos`).
- Migration 0274 seeds the starting rows exactly like 0273.
- Re-measure the registry unit pins (`t512-registry`, `t558`/`t575`/`t576` registry tests use exact counts; raise honestly).

## S3 — ₱50k unsent warning

- Pure helper (e.g. `_shell/unsent-total.ts`): sum `device.total` of queued `sale.completed` events in the outbox, exact
  money (use the existing money helpers, never floats).
- In the shell top bar, when offline and the sum ≥ the rule: a warning band "₱52,300 in sales not sent yet. Keep selling;
  call the manager." Visible to everyone at the till (the manager is the one called). Selling never stops.

## S4 — X-slip every N offline hours

- When the till has been offline for N hours (rule), and again every N hours while still offline, print an **offline
  X-slip** once per period (remember the last one printed in the device meta store, so a reload does not reprint).
- Content, built only from the device's own outbox (the server reading is unreachable offline): store, terminal, "OFFLINE
  X-SLIP - not a BIR reading", offline since, printed at, sales count, total, total by tender, number of events waiting to
  send. New formatter `formatOfflineXSlip` in `apps/erp/src/lib/pos-print/reading-text.ts` beside `formatXSlip`, same layout
  widths; printed through the existing print path the Till tab uses.
- If no printer is paired, show it on screen instead with a Print button; never block selling.

## Tests (each with a mutant that goes red)

1. Gate decision helper (pure): waiting=0 + no payment + online → activate; any one false → hold (mutant: ignore the
   payment-screen flag → red). `sw.js` message test: no `skipWaiting` on install (mutant: put it back → red).
2. Unsent sum: exact centavos over several sales, refunds ignored if not `sale.completed` (mutant: float sum → red on a
   ₱0.10 + ₱0.20 case).
3. X-slip timing: prints at N h, not again before 2N h, survives reload via meta (mutant: no meta → prints twice).
4. `formatOfflineXSlip` snapshot of lines at 58 mm and 80 mm widths; totals by tender add up to the total.
5. Registry: both keys present with the stated default/min/max.

- `npm run census:write` and commit what it changes. Typecheck: `npx tsc -p apps/erp/tsconfig.json --noEmit` (DELL has
  7.9 GB; close other apps first). PR description notes "migration 0274: needs CI full suite".
