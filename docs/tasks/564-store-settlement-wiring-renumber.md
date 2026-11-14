# T-564 — Store settlement wiring (T-515 re-applied on main) and migration renumber

Status: SPEC (Opus), 2026-11-14. Source: audit F4 (P1) in shareat-audits `audit-2026-11-11-review-backlog-followups.md`;
BOSS ruled "re-apply on top of main" and reserved migration **0257** on the board.
Branch `lane/t564-store-settlement-renumber`, based on origin/main 93e638a. BOSS commits/PRs/merges; Ian's word is
needed before merge (it changes money behaviour: settlement preview). Never push from the lane.

## Why
T-515 (commits e8e1fb1 + 04955a4 on `feat/store-settlement-settings`) was built on an old base and never merged. Its
migration `0213_t515_...` has the same number and date as main's applied `0213_t398_...`. Main also moved the settlement
code (S6c/S7: charge netting, locks, variance). A straight rebase conflicts in 16 files, including money code.
T-515's intent is in `docs/tasks/515-store-settings-and-settlement-config.md` (read via `git show e8e1fb1:...`).

## Facts found on main (re-verify before building; main moves)
- Main already has T-515's two headline fields, built differently and used by the file intake:
  `sales_channels.platform` (= T-515 `settlement_platform`) and `sales_channels.platform_store_code`
  (= T-515 `foodpanda_partner_code`; unique per org + platform, case-insensitive, 3–12 alphanumeric, admin-only writer
  with audit, migration 0228). T-515 decision 1 (partner code unique per org) is already true.
- `gatherSettlementContext` (`packages/domain/src/channel-settlements/index.ts`) and `settlementConfigBlockers` were
  rewritten on main (settleChargeIds, lockCharges, chargeNetting, variance). T-515's version must NOT come back.
- No reader exists for `store_key`, `match_labels`, `file_hints`, `bank_hints`, `wastage_email_ingest_enabled`
  (neither on main nor in e8e1fb1). `resolveStoreForSettlement` has no caller.
- `/remittance` already has a cash-policy editor (`remittance/actions.ts` `setCashPolicyAction`).
- `IssueAdminPinForm.tsx` and its t440-s2 EXEMPT entry come from an unmerged UI commit: drop both.
- 04955a4 is docs only (T-515 doc + review README, action-link-sweep count 1427→1431).

## Rulings
1. **No duplicates.** Do not add `sales_channels.settlement_platform` or `store_channel_settlement_configs.foodpanda_partner_code`.
   Screens and warnings use main's `platform` and `platform_store_code`.
2. **Keep Ian's T-515 decision 2 (faithful port) for what main lacks:** new table `store_channel_settlement_configs`
   (`store_key` lowercase slug, unique per org, immutable once saved; `match_labels text[]`; `file_hints text[]`;
   `wastage_email_ingest_enabled boolean default false`) and `sales_channels.bank_hints text[] default '{}'`.
   Said plainly in the task doc: **stored, not yet used by intake.** Do not invent a reader.
3. **Migration `0257_t564_store_channel_settlement_config`**, hand-authored (ADR-012 §5): header, table, composite
   same-org FK to stores, unique indexes (org+store, org+store_key), RLS ENABLE + FORCE via `app_current_org()`,
   grants SELECT/INSERT/UPDATE, registries (`rls/registry.ts`, `cutover/classification.ts`), journal entry LAST with
   `idx` 257 and `when` = main's 0256 `when` (1808191907084) + 86,400,000 = **1808278307084**. Do not touch main's
   0213_t398. Re-read main's journal first; if a higher idx exists, use the next free number above it and tell BOSS.
4. **Wiring warnings**, a pure read on the settlement preview (`storeKey`, `wiringWarnings`): (1) the store has no key
   (no wiring row); (2) the store has a key but no match labels and no file hints, so there is nothing to match by.
   **Amended 2026-11-14 (BOSS ruling):** the third warning in the first draft, "channel has a platform but no
   `platform_store_code`", is DROPPED: main's `sales_channels_platform_code_pair_check` makes it impossible
   (both set or both null). Warnings never block posting and are not in `blockers`. `settlementConfigBlockers`,
   netting, locks and variance are unchanged.
5. **Cash handling:** no second cash-policy form. The store page links to the existing `/remittance` cash settings,
   Sales channels and POS link.
6. **UI doors (Ian's standing rule):** the "Settlement wiring" panel on `/settings/sales-channels` edits store key (once),
   labels, hints, email-ingest; bank hints per channel. Capability `manage_store_settings` (existing), audit row on
   change, plain words, no codes, field rules via the existing `field-rules/settings.ts` pattern.
7. Commit subjects on the new branch say T-564 (not T-515). The 10 other stale commits never land.

## Build order (Sonnet builder; tests first)
1. `git cherry-pick -n e8e1fb1`; on every conflict keep main's side and re-add only the pieces in rulings 2–6.
2. Drop: IssueAdminPinForm hunk + EXEMPT entry, settlement_platform, foodpanda_partner_code, cash form, the review PNGs.
3. Apply 04955a4's doc edits (counts re-measured, not copied). Write the T-564 notes into the T-515 doc's status line.
4. Re-measure with the repo runners (never hand-edit): action-link-sweep, t511-s2b-source-shape,
   domain-actions-have-callers (`listStoreChannelSettlementConfigs` may need a row), production-caller baseline.
5. Tests: store key 23505 on duplicate; immutable key; RLS isolation (other org sees nothing); warnings content;
   preview unchanged when no config; migration-journal, rls-registry, cutover-classification guards.

## Checks (fresh `shareat_test_*` DBs, one file at a time, `--testTimeout=90000 --maxWorkers=2`)
(a) fresh install from zero; (b) UPGRADE: migrate to main's head WITHOUT 0257, then apply 0257 only; both green.
`npx tsc --noEmit`. Settlement integration tests (channel-settlements, t511-*) still green. Money audit (Sonnet) before hand-back.

## Out of scope
Any reader for labels/hints; moving the Foodpanda code per store; POS settings from T-515's audit table; renders (sign-in blocked; Ian looks after merge).
