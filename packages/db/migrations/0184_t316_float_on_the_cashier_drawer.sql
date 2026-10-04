-- T-316 S1 (docs/tasks/316-till-floor-on-the-cashier-account.md §4, A1, A6) — the till float
-- becomes a TARGET on the cashier's own cash drawer (GL 1110), not a side pocket on 1115.
--
-- ONE CONCERN: the float_target shape CHECK. A target is now legal only on a cash / cashier / 1110
-- account. Re-adding the constraint VALIDATES every existing row, so a database that still holds
-- a float target on a 1115 account fails this migration loudly instead of migrating a balance
-- (A1 measured 0 such rows on production). `1110` only, never `1110`-or-`1115`.
--
-- DELIBERATELY UNTOUCHED: money_accounts_one_float_per_store (one target per store is still the
-- property), and the 1115 GL account in the chart (history may name it).
alter table "money_accounts" drop constraint "money_accounts_float_target_shape_check";
--> statement-breakpoint
alter table "money_accounts" add constraint "money_accounts_float_target_shape_check" check ("money_accounts"."float_target" is null or ("money_accounts"."instrument" = 'cash' and "money_accounts"."custodian" = 'cashier' and "money_accounts"."gl_account_code" = '1110'));
