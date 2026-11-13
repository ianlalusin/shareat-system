# T-568 S1 — People and Inventory UI pass

Ian, 2026-11-08: *"evaluate the screens of the app and improve the ui. cards that must be table on
wide screen. tables that must be card on phone screen. do the people and invventory group."*

## The brief, tightened

On a wide screen a collection of records is a **table**: one row per record, a real header, aligned
numbers. On a phone the same collection is a **card list** that shows the two or three facts a
manager acts on without opening it. Everything else is shared: one page header, one filter bar, one
table surface, one empty state, one button vocabulary. Copy is written for the person using the
screen; task IDs and internal history stay in comments.

## What changed

| Screen | Before | After |
|---|---|---|
| `/staff` | Defaulted to the lanyard card wall; roster was an overflow-scrolling `ul` | Defaults to the **Roster table** (Photo / Person / Position / Today / Status); Cards is opt-in |
| `/admin/users` | Raw table; phone cards hid Stores and grants | Shared table; phone cards show **Stores 9 · Extra grants 0** and a visible Manage link |
| `/inventory` | Seven inline shortcuts, plain faint KPI figures | One section nav, a proper ledger-tie KPI panel, truck empty state |
| `/inventory/low-stock` | On a phone the `<thead>` rendered as a card and the input label read "ThresholdA number of 0 or more" | Header stays hidden, card reads **Threshold**, item/unit/code visible |
| `/inventory/usage` | Two raw tables with bold serif headers | Shared table surface; phone cards titled Room / Kind, not a date |
| `/inventory/counts` | "Open count" was a red eye icon | Visible **Open count** button |
| `/inventory/locations`, `/deliveries`, `/items`, `/payroll`, `/attendance` | Mixed raw tables and ad-hoc card lists | Shared table / card treatment and visible filter buttons |

## Findings that drove the work

1. **The phone-card annotator had two real bugs.** Any `HelpTip` button inside a `<th>` marked the
   whole header as "controls", so the header row became a card. Hidden tooltip prose was also being
   concatenated into the card label. Both are fixed and covered by a test.
2. **A filter submitted with an eye icon.** `Button` auto-turns the word "Show" into an eye, which is
   indistinguishable from a view toggle. `FilterRow` now passes `icon={null}`.
3. **The staff roster defaulted to a card wall on desktop.** It is now a table, and the same markup
   becomes a card list on a phone.
4. **Phone cards lost their key values.** The numbers were there; their labels were not. Key values
   now keep an inline label, so "9" reads "Stores 9".
5. **Titles were cut to one line.** Two-line clamp means "T343S6C Test Item (slab)" is readable
   instead of "T343S6C Test Ite…".

## Screenshots

All pairs are 1440×900 desktop or 390×844 phone, captured from the production build.

- [Staff — desktop](./compare-staff-desktop.png)
- [Users and roles — desktop](./compare-admin-users-desktop.png)
- [Users and roles — phone](./compare-admin-users-phone.png)
- [Inventory — desktop](./compare-inventory-desktop.png)
- [Usage & wastage — desktop](./compare-usage-desktop.png)
- [Low stock — phone](./compare-low-stock-phone.png)
- [Low stock threshold card — zoom](./compare-low-stock-threshold-zoom.png)
- [Items — phone](./compare-items-phone.png)

Raw before/after files are in this folder as `before-*.png` / `after-*.png`.

## Verification

- `npm run typecheck` — clean.
- Focused UI suites — green (52 tests across the shared table, filter, staff and row-link guards).
- `npm run build` — clean.
- Full ERP suite — 3,953 passed / 5 failed; the failures are pre-existing environment issues
  (two 5 s cold-import timeouts, one Windows `spawnSync ENOENT`, one test that passes alone).

## Still owed

`/admin/users/[personId]` remains a 7,800 px capability wall (12,600 px on a phone). It needs
search, grouping and progressive disclosure before it is usable on a phone. It is the next People
task, not a table/card patch.
