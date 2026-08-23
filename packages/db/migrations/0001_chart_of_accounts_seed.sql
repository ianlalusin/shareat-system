-- T-102 — chart of accounts seed. docs/tasks/102-chart-of-accounts-seed.md.
--
-- Source of truth: docs/decisions/COA-ALIGNMENT.md §2, amended 2026-08-23 by Ian (revenue
-- collapsed to two accounts: 4200 take-out is REMOVED, its meaning absorbed into 4150,
-- which is active rather than reserved). The VALUES lists below are generated verbatim
-- from packages/db/seed/chart-of-accounts.ts — that file is the canonical source; this
-- migration is a point-in-time application of it and is never edited after being applied
-- anywhere (bible §2 rule 8). A further change is a NEW migration.
--
-- Reference data, not a fixture (bible §4.4 / §16.9): every row is is_system = true,
-- applied idempotently by (org_id, code) via ON CONFLICT ... DO NOTHING (never DO UPDATE
-- — re-running this must change zero existing rows, not just skip duplicate codes).
--
-- This migration seeds every organization that EXISTS AT THE TIME IT RUNS. A brand-new
-- org created afterward is not reached by a migration that already ran — a future
-- "create organization" flow must call packages/db/seed/chart-of-accounts.ts's
-- `seedChartOfAccounts()` directly for its own org id, reusing the same exported list.
--
-- Two phases, because a leaf's parent_id can only be resolved once its header is
-- committed. The hierarchy is flat (Contract §1): every leaf's parent is one of the
-- seven header rows directly, never another leaf — consistent with T-101's
-- accounts_postable_no_children trigger, which every row below satisfies (all leaves are
-- is_postable = true and none is referenced as another leaf's parent).
--
-- Several deliberate omissions and judgment calls are recorded in the seed file's own
-- comments and in the task report — most importantly: 1520/1530 (a reserved number gap
-- in the Property & equipment range, not seeded as rows) and the 7000/7350 type calls,
-- which the source documents leave genuinely ambiguous.

-- Phase 1 — the seven non-postable headers.
insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, legacy_code, status)
select
  o.id, v.code, v.name, v.type, v.normal_balance, null, false, true, v.legacy_code, v.status
from organizations o
cross join (values
    ('1000', 'Assets', 'asset', 'debit', null, 'active'),
    ('2000', 'Liabilities', 'liability', 'credit', null, 'active'),
    ('3000', 'Equity', 'equity', 'credit', null, 'active'),
    ('4000', 'Revenue', 'income', 'credit', null, 'active'),
    ('5000', 'Cost of sales', 'expense', 'debit', null, 'active'),
    ('6000', 'Operating expenses', 'expense', 'debit', null, 'active'),
    ('7000', 'Other income and expense', 'income', 'credit', null, 'active')
) as v(code, name, type, normal_balance, legacy_code, status)
on conflict (org_id, code) do nothing;
--> statement-breakpoint

-- Phase 2 — every postable leaf account, parented to its range's header.
insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, legacy_code, status)
select
  o.id, v.code, v.name, v.type, v.normal_balance, p.id, true, true, v.legacy_code, v.status
from organizations o
cross join (values
    ('1110', 'Cash on hand — cashier', 'asset', 'debit', '1000', 'cash__cashier', 'active'),
    ('1120', 'Cash on hand — staff custodian', 'asset', 'debit', '1000', 'cash__staff', 'active'),
    ('1130', 'Cash on hand — office', 'asset', 'debit', '1000', 'cash__office', 'active'),
    ('1140', 'E-wallet / online channels', 'asset', 'debit', '1000', null, 'active'),
    ('1210', 'Accounts receivable', 'asset', 'debit', '1000', null, 'active'),
    ('1220', 'Channel receivable', 'asset', 'debit', '1000', null, 'active'),
    ('1221', 'Channel clearing — Grab', 'asset', 'debit', '1000', 'clearing__grab', 'active'),
    ('1222', 'Channel clearing — Foodpanda', 'asset', 'debit', '1000', 'clearing__foodpanda', 'active'),
    ('1230', 'Advances to employees', 'asset', 'debit', '1000', null, 'active'),
    ('1240', 'Advances to suppliers', 'asset', 'debit', '1000', null, 'active'),
    ('1250', 'Due from related store', 'asset', 'debit', '1000', null, 'active'),
    ('1310', 'Inventory — raw materials', 'asset', 'debit', '1000', null, 'active'),
    ('1320', 'Inventory — supplies and packaging', 'asset', 'debit', '1000', null, 'active'),
    ('1330', 'Inventory — prepped / commissary goods', 'asset', 'debit', '1000', null, 'active'),
    ('1340', 'Inventory in transit (branch orders)', 'asset', 'debit', '1000', null, 'active'),
    ('1400', 'Prepaid expenses', 'asset', 'debit', '1000', null, 'active'),
    ('1510', 'Property and equipment', 'asset', 'debit', '1000', null, 'active'),
    ('1590', 'Accumulated depreciation', 'asset', 'credit', '1000', null, 'active'),
    ('2110', 'Accounts payable', 'liability', 'credit', '2000', null, 'active'),
    ('2130', 'Reimbursements payable to employees', 'liability', 'credit', '2000', null, 'active'),
    ('2140', 'Customer store credits payable', 'liability', 'credit', '2000', 'others__store_credits', 'active'),
    ('2145', 'Unredeemed vouchers', 'liability', 'credit', '2000', null, 'reserved'),
    ('2150', 'Due to related store', 'liability', 'credit', '2000', null, 'active'),
    ('2210', 'SSS payable', 'liability', 'credit', '2000', null, 'active'),
    ('2220', 'PhilHealth payable', 'liability', 'credit', '2000', null, 'active'),
    ('2230', 'Pag-IBIG payable', 'liability', 'credit', '2000', null, 'active'),
    ('2240', 'Withholding tax payable', 'liability', 'credit', '2000', null, 'active'),
    ('2250', 'VAT payable', 'liability', 'credit', '2000', null, 'reserved'),
    ('2300', 'Salaries and wages payable', 'liability', 'credit', '2000', 'liability__salaries_payable', 'active'),
    ('2400', 'Loans payable', 'liability', 'credit', '2000', null, 'active'),
    ('2900', 'Suspense — void cash', 'liability', 'credit', '2000', 'liability__void_cash_suspense', 'active'),
    ('3100', 'Owner''s capital', 'equity', 'credit', '3000', 'equity__capital', 'active'),
    ('3200', 'Owner''s drawings', 'equity', 'credit', '3000', null, 'active'),
    ('3300', 'Retained earnings', 'equity', 'credit', '3000', null, 'active'),
    ('3900', 'Opening balance equity', 'equity', 'credit', '3000', 'equity__opening_balance', 'active'),
    ('4100', 'Food sales — unlimited (unli)', 'income', 'credit', '4000', null, 'active'),
    ('4150', 'Food sales — à la carte (dine-in, take-out and delivery)', 'income', 'credit', '4000', null, 'active'),
    ('4400', 'Beverage sales', 'income', 'credit', '4000', null, 'active'),
    ('4900', 'Sales discounts', 'income', 'debit', '4000', null, 'active'),
    ('4910', 'Loyalty points redeemed', 'income', 'debit', '4000', 'others__points', 'active'),
    ('4920', 'Vouchers redeemed', 'income', 'debit', '4000', 'others__voucher', 'reserved'),
    ('4950', 'Sales returns and voids', 'income', 'debit', '4000', null, 'active'),
    ('5100', 'COGS — food', 'expense', 'debit', '5000', null, 'active'),
    ('5200', 'COGS — beverage', 'expense', 'debit', '5000', null, 'active'),
    ('5300', 'Wastage and spoilage', 'expense', 'debit', '5000', 'expense__order_wastage', 'active'),
    ('5400', 'Inventory adjustment', 'expense', 'debit', '5000', null, 'active'),
    ('6100', 'Salaries and wages', 'expense', 'debit', '6000', 'expense__salary', 'active'),
    ('6110', 'Employer SSS contributions', 'expense', 'debit', '6000', null, 'active'),
    ('6120', 'Employer PhilHealth contributions', 'expense', 'debit', '6000', null, 'active'),
    ('6130', 'Employer Pag-IBIG contributions', 'expense', 'debit', '6000', null, 'active'),
    ('6140', '13th month pay', 'expense', 'debit', '6000', null, 'active'),
    ('6150', 'Salary additions and allowances', 'expense', 'debit', '6000', 'expense__salary_additions', 'active'),
    ('6200', 'Rent', 'expense', 'debit', '6000', null, 'active'),
    ('6300', 'Utilities', 'expense', 'debit', '6000', null, 'active'),
    ('6400', 'Platform and channel fees', 'expense', 'debit', '6000', 'expense__platform_fee', 'active'),
    ('6410', 'Online order expenses', 'expense', 'debit', '6000', 'expense__online_order_expenses', 'active'),
    ('6500', 'Supplies', 'expense', 'debit', '6000', null, 'active'),
    ('6600', 'Repairs and maintenance', 'expense', 'debit', '6000', null, 'active'),
    ('6700', 'Depreciation', 'expense', 'debit', '6000', 'expense__depreciation', 'active'),
    ('6750', 'Amortisation', 'expense', 'debit', '6000', 'expense__amortization', 'active'),
    ('6800', 'Taxes and licences', 'expense', 'debit', '6000', 'expense__tax', 'active'),
    ('6900', 'Other operating expenses', 'expense', 'debit', '6000', null, 'active'),
    ('7100', 'Platform settlement gain', 'income', 'credit', '7000', 'income__platform_settlement_gain', 'active'),
    ('7200', 'Interest expense', 'expense', 'debit', '7000', 'expense__interest', 'active'),
    ('7310', 'Staff charge recovery', 'income', 'credit', '7000', 'income__charge_recovery', 'active'),
    ('7320', 'Wastage recovery', 'income', 'credit', '7000', 'income__wastage_recovery', 'active'),
    ('7350', 'Cash over and short', 'expense', 'debit', '7000', null, 'active'),
    ('7400', 'Loss on disposal of assets', 'expense', 'debit', '7000', 'expense__loss_on_disposal', 'active')
) as v(code, name, type, normal_balance, parent_code, legacy_code, status)
join accounts p on p.org_id = o.id and p.code = v.parent_code
on conflict (org_id, code) do nothing;
