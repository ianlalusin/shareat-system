-- T-102b — the 17 accounts T-102 missed. docs/tasks/102b-chart-of-accounts-completion.md.
-- Closes DEF-035.
--
-- T-102 (migration 0001) seeded 75 accounts from COA-ALIGNMENT.md §2, which gives
-- account GROUPS. §4 gives the expense-category -> account MAPPING and introduces a
-- finer breakdown — 17 accounts §2 never names on its own. §2's own summary rows for the
-- 5xxx/6xxx ranges point at §4 for this detail ("6200 Rent · 6300 Utilities · ... see
-- §4"), so the omission was always visible in the source document; T-102's spec pointed
-- only at §2, and the implementer seeded exactly what was asked. See DEF-035 in
-- docs/DEFECTS-REGISTER.md for the full account of the defect.
--
-- Not a schema change — no drizzle-kit snapshot, matching 0002, 0004 and 0005's own
-- precedent (all hand-written, none generated). The seven header rows (1000..7000)
-- already exist from migration 0001; this migration only inserts new LEAF rows under the
-- existing 5000 and 6000 headers.
--
-- Reference data, not a fixture (bible §4.4 / §16.9): every row is_system = true,
-- applied idempotently by (org_id, code) via ON CONFLICT ... DO NOTHING (never DO UPDATE
-- — re-running this must change zero existing rows). None of the 17 carries a
-- legacy_code: every one is either genuinely new or fed by a free-text v1 expense
-- category, never a stable 1:1 v1 account id (Contract, "Things that will bite" #2).
--
-- Cost of sales additions (COA-ALIGNMENT §4.1) — 5110-5170, parented to 5000:
--   5170 COGS — commissary transfers carries an INTER-STORE WARNING: Commissary
--   Purchases is not a third-party cost. At store level it is real spend, but
--   CONSOLIDATED it must ELIMINATE against the commissary's transfer-out, or the same
--   peso is COUNTED TWICE — once when the commissary buys the raw material (into 1330),
--   again when the branch "buys" from the commissary (into this account). That is why it
--   is kept separate from 5110 rather than folded in — same reciprocal-elimination shape
--   as the 1250/2150 due-from/due-to pair. See packages/db/seed/chart-of-accounts.ts's
--   comment on the 5170 leaf() call for the same warning, kept in sync with this file.
--
-- Operating expense additions (COA-ALIGNMENT §4.2) — 10 accounts, parented to 6000:
--   6160, 6510, 6620, 6630, 6650, 6850, 6860, 6870, 6880, 6890.
insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, legacy_code, status)
select
  o.id, v.code, v.name, v.type, v.normal_balance, p.id, true, true, v.legacy_code, v.status
from organizations o
cross join (values
    ('5110', 'COGS — meat', 'expense', 'debit', '5000', null, 'active'),
    ('5120', 'COGS — sides', 'expense', 'debit', '5000', null, 'active'),
    ('5130', 'COGS — condiments and seasoning', 'expense', 'debit', '5000', null, 'active'),
    ('5140', 'COGS — sauces and dips', 'expense', 'debit', '5000', null, 'active'),
    ('5150', 'COGS — packaging', 'expense', 'debit', '5000', null, 'active'),
    ('5160', 'COGS — retail and consumables', 'expense', 'debit', '5000', null, 'active'),
    ('5170', 'COGS — commissary transfers', 'expense', 'debit', '5000', null, 'active'),
    ('6160', 'Employee benefits and welfare', 'expense', 'debit', '6000', null, 'active'),
    ('6510', 'Smallwares', 'expense', 'debit', '6000', null, 'active'),
    ('6620', 'Pest control and waste management', 'expense', 'debit', '6000', null, 'active'),
    ('6630', 'Vehicle and transportation', 'expense', 'debit', '6000', null, 'active'),
    ('6650', 'Marketing and advertising', 'expense', 'debit', '6000', null, 'active'),
    ('6850', 'Administrative expenses', 'expense', 'debit', '6000', null, 'active'),
    ('6860', 'Bad debt expense', 'expense', 'debit', '6000', null, 'active'),
    ('6870', 'Bank charges', 'expense', 'debit', '6000', null, 'active'),
    ('6880', 'Insurance', 'expense', 'debit', '6000', null, 'active'),
    ('6890', 'Subscriptions and software', 'expense', 'debit', '6000', null, 'active')
) as v(code, name, type, normal_balance, parent_code, legacy_code, status)
join accounts p on p.org_id = o.id and p.code = v.parent_code
on conflict (org_id, code) do nothing;
