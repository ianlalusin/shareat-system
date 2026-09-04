-- 0128 — T-209a: the balance sheet view.
-- docs/tasks/209-reporting-read-model-and-statements.md
--
-- HAND-WRITTEN, per DEF-073. Never edited after apply.
--
-- Mirrors v_income_statement's TYPE-signed convention (packages/db/schema/views.ts's own
-- top comment for the full reasoning), not v_trial_balance's/v_account_balance's
-- per-account normal_balance convention — the latter breaks a type-bucketed total for
-- account 1590 (accumulated depreciation: type=asset, normal_balance=credit). Restricted
-- to asset/liability/equity, the mirror image of v_income_statement's income/expense
-- restriction.
CREATE VIEW "public"."v_balance_sheet" AS (
  select
    je.org_id as org_id,
    jl.store_id as store_id,
    jl.account_id as account_id,
    a.code as account_code,
    a.name as account_name,
    a.type as account_type,
    je.entry_date as entry_date,
    je.source_type as source_type,
    coalesce(sum(jl.debit), 0)::numeric(14,2) as debit_total,
    coalesce(sum(jl.credit), 0)::numeric(14,2) as credit_total,
    (case
      when a.type = 'asset' then coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
      else coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
    end)::numeric(14,2) as net_amount
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  join accounts a on a.id = jl.account_id
  where je.status in ('posted', 'reversed')
    and a.type in ('asset', 'liability', 'equity')
  group by je.org_id, jl.store_id, jl.account_id, a.code, a.name, a.type, je.entry_date, je.source_type
);
