# T-568 S1 — Money, Trade, Franchise, Reports and Setup UI pass

Ian, 2026-11-09: keep the staff page as **cards**, improve the card but never turn it into a table;
then do Money, Trade, Franchise, Reports and Setup in one branch, one audit, one merge later.

## What changed

| Screen | Before | After |
|---|---|---|
| `/staff` | Tall lanyard card, one per row | Compact ID badge, grouped by On shift / On break / Off today; roster table stays optional |
| Nav | Money owners, outbound trade mixed into Trade | New **Franchise** group; Trade is supplier-facing only |
| `/money-accounts` | 45-row fixed table, Store/Kind overlapped | Filtered, grouped by account type; one table per type; phone card hides edit/retire behind the chevron |
| `/money-transfers` | 48 loose balance cards | Store × account matrix with totals; one card per store on a phone |
| `/settings/pos-link` | Nine open forms (13,300 px on phone) | Nine disclosures (1,042 px on phone) |
| `/settings/expense-categories` | 19,938 px on phone; title cut to "Capit al…" | Grouped/filtered, 4,152 px; full category name and posting account |
| `/findings` | Every finding and missed month fully open | Collapsed disclosures; action opens where used (7,720 → 2,964 px phone) |
| `/trade/orders` | New-order form open on a phone | Disclosure; 844 px |

## Screenshots

- [Staff ID cards — desktop](./compare-staff-desktop.png)
- [Money accounts — desktop](./compare-money-accounts-desktop.png)
- [Money accounts — phone](./compare-money-accounts-phone.png)
- [Money transfers — desktop](./compare-money-transfers-desktop.png)
- [POS link — phone](./compare-pos-link-phone.png)
- [Expense categories — phone](./compare-expense-categories-phone.png)
- [Findings — desktop](./compare-findings-desktop.png)
- [Trade orders — phone](./compare-trade-orders-phone.png)

Raw before/after files are in this folder as `before-*.png` / `after-*.png`.

## Verification

- `npm run typecheck` — clean.
- Focused suites green: staff, nav reachability, row-link census, phone table cards/coverage,
  page-description sweep, full-width ratchet, action-link sweep.
- Full ERP unit run: 3,954 passed / 4 failed; all four are pre-existing environment failures
  (three cold-import timeouts, one Windows `spawnSync` path error).
- `npm run build` — clean.
