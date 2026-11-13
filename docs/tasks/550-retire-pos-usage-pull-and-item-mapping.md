# T-550 — Retire "POS usage pull" and "POS item mapping" (keep the data)

> **Status:** spec written 8 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Authority:** bible row 452 (Ian, 8 Nov): v1 and v2 are separate backends. Only a v1 store's sales and stock stay
> in v1; suppliers and AP, payroll, expenses, cash requests and customers and AR are org-wide in the v2 ERP for every
> store from 1 Jan 2027. Mapping v1 records into v2 does not pay off.
> **Migration:** none. **No destructive migration:** every table and its rows stay (`pos-mapping`, the usage-pull
> drafts and their history). **Risk:** low to medium. This removes screens only, and the guard census moves. The
> builder is Sonnet. Use Haiku for the census sweeps.

## Goal

Remove two ERP pages that only served v1 stores in the v2 ERP, without losing any stored data:
- **POS usage pull**: `/inventory/pos-usage`;
- **POS item mapping**: `/inventory/pos-map`.

After this, nobody can open, link to or act on them, and nothing in the v2 ERP pulls usage from POS v1.

## Out of scope (Ian answered these on 8 Nov, row 452 a and b; this task does not act on them)

| Out | Why |
|---|---|
| Switching off the T-472 nightly receipt bridge | Row 452 (a): **it stops now**. It is a systemd timer on the production host with no ERP screen, so **Ian runs the stop himself** (`sudo systemctl disable --now shareat-pos-receipt-bridge.timer`); no agent touches the server and this task changes no code for it. Its tables and copied rows stay |
| Stopping T-396, the 06:00 v1 day import, for v1 stores | Row 452 (b): it keeps importing until 2026-12-31 and stops for v1 stores from 2027-01-01. The 2026 rows stay. The code change is a separate task (T-551), not this one |
| Any change to sales days, posting, stock levels or the usage history already recorded | Data stays as it is. No re-booking |
| Dropping tables or columns | "Keep the data tables" (BOSS, 8 Nov). A later task may drop them after the 2027 cutover, if Ian wants |

## R1 — What to remove

1. **The page folders** `apps/erp/src/app/inventory/pos-usage/` and `apps/erp/src/app/inventory/pos-map/`: the page,
   actions, lib and any child routes. A request for either path now gets the app's normal 404.
2. **Navigation:** the two entries in `apps/erp/src/components/nav.tsx`, lines 90–91, "POS usage pull" and "POS item
   mapping".
3. **Route capabilities:** their entries in `apps/erp/src/lib/route-capability.ts`, if they exist. If they don't, a
   prefix covers them; then remove nothing.
4. **Any other link** to those paths (grep `'/inventory/pos-usage'` and `'/inventory/pos-map'` across `apps/erp/src`).
   That includes flash redirects, cross-links from the usage pages, and help text.
5. **Domain and repo code used only by those pages** (the usage-pull planner, the mapping writes):
   - **Do not delete it in this task.** If a function loses its last production caller, add it to the production-caller
     baseline's known-unused list with the reason "T-550: page retired (row 452); domain kept until the cutover
     decision".
   - Keep `domain-actions-have-callers` honest the same way, with an INTERNAL or RETIRED row per function, each with
     that reason.
   - The domain code stays, so a later decision can still read the data.
6. **Scheduled jobs:** if anything schedules the usage pull (the 14:00 auto-post from rows 341–342, a cron or the
   T-396 job), **list it in the hand-back. Do not disable it.** BOSS decides with Ian. If a job only ever acts through
   the retired page, say so.

## R2 — Tests and census

- **Delete the tests that only test the removed pages:**
  - `apps/erp/tests/integration/t375-s5-pos-usage-page.test.ts`;
  - `t403-pos-map-page-gating.test.ts`;
  - the page parts of `t373-s1-pos-usage-picker` and `t374-s7-pos-usage-void-action`;
  - `t401-s6-usage-ui`, only where it renders `/inventory/pos-usage`;
  - and any other test that only renders these pages.
  For every deleted file, list what it guarded and why that guard no longer applies.
- **Keep or adjust the domain and repo tests.** The data and domain still exist, so their tests stay unless they
  exercise only page wiring.
- **Census files:**
  - `action-link-sweep` (the counts go down; report the new numbers for BOSS);
  - `touch-target-baseline.json`;
  - `t348-page-description-sweep`;
  - `t411-row-link-census`;
  - `t412-destructive-census`;
  - `nav-route-reachability`;
  - `route-capability-coverage`;
  - `t380-s5-guard`;
  - `t387-s4-stamp-wiring`;
  - `t440-s5-stock-rules`;
  - `t548-modal-frame`;
  - `flash.test`;
  - `t343-s7-wrapper-refusals`.
  Remove only the entries for the deleted paths. **Never loosen a guard's logic.** Report every baseline delta.
- **New guard** (`apps/erp/tests/t550-retired-pages.test.ts`):
  - no file under `apps/erp/src` contains the strings `/inventory/pos-usage` or `/inventory/pos-map`;
  - the two folders do not exist;
  - the nav has no "POS usage pull" or "POS item mapping".
  The reason in its header is row 452.

## R3 — Gates

Typecheck · the unit project · the integration files touching inventory, usage and mapping · the census set above.
Use the lane's own `_test` DB and its **own `npm ci`** (no junction). **Never print any `.env.local` value.**

## Hand-back must include

- the deleted files;
- the census deltas, with a reason for each;
- the functions newly marked unused or retired;
- every scheduled job that touches the usage pull, with its trigger and schedule.
