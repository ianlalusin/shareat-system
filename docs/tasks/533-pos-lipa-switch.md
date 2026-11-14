# T-533 — Lipa switch: store POS mode screen, Lipa setup load, pre-flight check, soak plan, runbook, go/no-go

> **Status:** spec written 8 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Migration:** none expected. `pos_stores` already grants UPDATE on `mode`, `live_from`, `state_version`,
> `changed_by` and `changed_at` (0238:1050). If the builder finds one is needed, stop and ask BOSS for a number.
> **Risk:** high. The mode switch decides whether real sales are booked. The builder and the auditor are Sonnet.
> **Depends on:** T-523 through T-531, T-539 S3, T-546 and T-530a. The soak needs the APK shell (T-532) or a browser on
> the tablet.
> **Design:** §8 (switch-over) and §8a (December bridge). **Bible:** rows 313, 379 (pre-2027 POS data is test data,
> purged at the 2027 cutover), 390, 430, 431 (7 Dec; the soak gates it), 435, 436, 449 and 450.
> **Dates:** soak #1 Sat 28 Nov · soak #2 at the latest Wed 2 Dec · go/no-go Fri 4 Dec · Lipa live Mon 7 Dec.

## Goal

Make the Lipa switch a short list of small, checked, audited steps, never a scramble:
1. **A screen to set a store's POS mode** (off, test, live from a date), with a roll-back. Nothing sets
   `pos_stores.mode` today.
2. **A one-time load** of Lipa's stands and discount presets from v1, read-only from v1.
3. **A pre-flight check** that lists every gap before the switch, in plain words.
4. **The soak plan, the runbook, a staff training sheet and the go/no-go pack**, written as docs and shown on the board.

**v1's goal (§1.2d):** a store kept trading through the old Firebase trial with no clean switch day; numbers moved
by hand. **v2:** one switch at a business-day boundary (§8), every step audited, and roll-back possible the next
morning without mixing two sources on one day.

## Out of scope

| Out | Why |
|---|---|
| Malvar, Davao and Padre Garcia | 2027, one a week (§9) |
| Moving loyalty balances | Row 432: no loyalty in release 1 |
| Purging the test-mode POS rows | Row 379: pre-2027 POS rows are purged by the **2027 cutover purge** (`cutover/classification.ts`, purge class). T-531 already ignores unclosed receipts dated before `live_from`. **There is no separate purge for go-live.** State this in the runbook |
| The APK build itself | T-532 |

## R1 — Store POS mode (domain, plus a screen on `/admin/stores`)

Domain functions `packages/domain/src/pos/store-mode.ts`:
- `setStorePosMode(tx, actor, {storeId, mode: 'off'|'test'|'live', liveFrom?: date, reason})`:
  - **Capability:** an admin only (`manage_stores`, or the capability `/admin/stores` already uses; reuse it, do not
    invent one). Switching a store to live is not a store manager's call.
  - **The row:** creates the store's `pos_stores` row with `mode 'off'` the first time.
  - **`live`:**
    - needs `liveFrom` to be today's business date or later;
    - refused if a live sales day (any source) already exists for any date from `liveFrom` on, with "Sales day <date>
      already exists. Switch from the next day.";
    - **refused unless the pre-flight check (R3) has no blocking item**;
    - the business-day boundary is enforced by the date.
  - **Back from live** (`test` or `off`): the roll-back.
    - Allowed only if no Z has closed on or after `liveFrom`. Otherwise refused with "Days are already closed on the
      new POS. Roll back from the next day." Rolling back from a later date is a new live→off with a fresh date: keep
      it simple, so release 1 rolls back only to before the first Z.
    - The v1 day feed resumes for those dates through the existing import, because the 0247 guard keys on `mode` and
      `live_from`.
  - **Reason:** required, 1–200 characters.
  - **Effects:** bumps `state_version`, sets `changed_by` and `changed_at`, and writes the audit `pos.store_mode_set`
    with before and after (mode, live_from, reason).
- **Screen:** on `/admin/stores/[id]`, a **POS** card shows the current mode, `live_from`, who changed it and when,
  and the pre-flight summary. It has a Set mode form: mode, live-from date, reason, and a confirm step showing exactly
  what will happen ("From 7 Dec 2026, Lipa's sales days come from the new POS; the v1 day feed stops for Lipa").
- **Tests (each ✅ with its ✗):**
  - an admin switches to live on a future date;
  - a store manager is refused;
  - a date with an existing sales day is refused;
  - a blocking pre-flight item is refused;
  - roll-back before the first Z works, and the v1 import works again for those dates;
  - roll-back after a Z is refused;
  - audit and `state_version` are correct;
  - a test store creates no sales day on Z (T-531).

## R2 — Lipa one-time load (ops script, read-only from v1)

`packages/etl/src/pos-v2/load-store-setup.ts`, plus a CLI entry `npm run pos:load-setup -- --store <erpStoreId> --dry-run`:
- **Reads v1 (Firestore, read-only)** through the existing `packages/etl-firestore` client and its credentials, for the
  store's linked v1 store (`pos_v1_store_links`):
  - the table and stand list;
  - the discount presets (name, percent or fixed, value).
  It **never writes to Firestore**.
- **Writes through the domain:**
  - `pos_stands`, upserted by stand number;
  - `pos_discount_presets`, upserted by name, active;
  - one audit per row, using the load's own actor.
- **Idempotent:** a second run changes nothing. `--dry-run` prints the plan as counts and names, writes nothing, and
  shows no secrets.
- **Reports, but never auto-fixes:**
  - tenders without `pos_v1_alias` (needed by the December bridge);
  - menu items without a kitchen station;
  - packages without refill items;
  - staff at the store without a badge code or a PIN.
- **Tests:** a fake v1 source with stands and presets:
  - the dry run writes nothing;
  - a real run inserts them;
  - a re-run makes no change;
  - a preset with value 0 or a percent over 100 is refused in words;
  - the report lists each gap kind.

## R3 — Pre-flight check (domain read plus a page)

`posPreflight(tx, actor, {storeId})` returns `{blocking: Item[], warnings: Item[]}`. Each item has a plain sentence and a
link to the screen that fixes it.

**Blocking:**
- no `pos_stores` row;
- no active stands;
- no tender of kind cash;
- a tender without `pos_v1_alias` while the store is v1-linked and the date is on or before 2026-12-31 (needed by the
  bridge);
- no `pos_terminals` row linked to a live pairing (T-546);
- the business rules not seeded (VAT, SC/PWD, start hour, table warning; T-539);
- no person at the store with `record_sale`;
- no person at the store who is manager or above with a PIN (needed to approve a Z, rows 390 and 449);
- `POS_FIREBASE_SA_KEY_FILE` not configured while v1-linked and dated on or before 2026-12-31. This is checked by an
  injected probe that reads presence only and never prints a value.

**Warnings:**
- menu items without a station;
- packages without refill items;
- staff without a badge code or a PIN;
- no discount presets.

**Page:** `/admin/stores/[id]/pos-preflight` (admin). The R1 card shows the counts and links to this page.

**Tests:** each blocking and warning item fires on its own; a fully set-up fixture has none.

## R4 — Docs (written by the builder, checked by the planner)

1. **`docs/runbooks/pos-lipa-switch.md`**. The §8 table becomes exact steps with owners and times. It covers:
   - a week before: pre-flight green;
   - a day before: pair the tablet, install the APK beside the old app, make a test sale in test mode;
   - the closing night on the old app: close every table, empty the outbox, print the final v1 Z;
   - the opening morning:
     - the admin sets mode live from today on `/admin/stores`;
     - the trial app is signed out, guard (2) of §8a;
     - the 06:00 v1 import skips Lipa automatically (the 0247 guard);
   - the first week's daily checks:
     - receipt count against the till;
     - the quarantine list is empty;
     - the Z is closed and verified by a manager (row 449);
     - the bridge document has been sent;
   - roll-back: the next morning only, before any Z, through R1.
   It also states that the test-mode rows are purged by the 2027 cutover, not now.
2. **`docs/runbooks/pos-soak-plan.md`**. Soak #1 on Sat 28 Nov, at Lipa during a quiet window, in **test mode**, with
   real staff, the real tablet and the real printer. A scripted list of about 30 actions, each with a pass mark:
   - seat, add, heads, refill, kitchen serve;
   - discounts, including a senior with an ID;
   - split pay with GCash plus cash;
   - offline for 10 minutes: sell, print, switch cashier, reconnect, drain, nothing quarantined;
   - X and Z, including a wrong PIN 5 times;
   - reprint;
   - un-pair and re-pair.
   It records findings as defects. Soak #2 runs by Wed 2 Dec if #1 has any blocker.
3. **`docs/runbooks/pos-staff-sheet.md`**. A one-page sheet for cashiers, servers and the kitchen, in plain words.
   **English plus Tagalog lines** where staff need them (the builder writes English; the planner or Ian adds the
   Tagalog). It covers: sign-in, seat, add, pay, offline, Z, and who to call.
4. **`docs/runbooks/pos-go-no-go.md`**. The checklist for Fri 4 Dec:
   - soak results;
   - pre-flight green;
   - every PR merged and deployed (#196, T-539 S3, T-546, T-529, T-531, T-530a, T-528e);
   - CI green on main;
   - backups verified;
   - roll-back understood.
   Ian decides go or no-go.

## R5 — Gates

Typecheck · unit · the integration files for R1–R3, plus t531 (closing in a test store creates no sales day) and the
0247 guard. Use the lane's own `_test` DB and its own `npm ci`. **Never print any `.env.local` value, and never print
any Firestore credential or document id beyond counts.**

## Ian's answers (11 Nov 2026; bible rows 456, 457)

- **O1, row 456.** Switching a store live, or back, is allowed for the roles **`admin` and `super_admin` only**. R1's
  capability check must accept exactly those two roles. Store managers are refused, which is tested. Reuse the
  existing role ranking (T-531 R10 used it); do not invent a new one.
- **O2, row 457.** Soak #1 runs at **Lipa on Saturday 28 November, 2–4 p.m.**, in test mode. `pos-soak-plan.md` states
  that window. Soak #2 runs by Wednesday 2 December if #1 has a blocker.
