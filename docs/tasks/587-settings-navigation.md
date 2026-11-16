# T-587 — Settings that an admin or a manager can find and understand

**Status:** DECIDED by Ian, 15 Nov 2026 (relayed by BOSS from his own answers); build as S1-S3. Navigation and labels only: no migration, no new setting, no new capability. Author: settings session. Design review: UI UX (impeccable, Operate mode).

## DECIDED (Ian, 15 Nov 2026)
1. **Option B.** Built as S1, S2, S3, three small PRs.
2. **Renames approved:** Kitchen setup -> "Kitchen stations"; Clock lane -> **"Failed clock punches"** (Ian's pick over UI UX's "Clock punch problems"); POS link -> "Link to POS store"; Sales channels -> "Sales channels (walk-in, Grab, Foodpanda)"; POS tablet(s) -> "POS tablets and cash registers"; "Menu hours" stays.
3. **Renames NOT approved, current names stay:** "Business rules" and "Wastage Monitor".
4. **KEEP the "Find a setting" box** (it also matches old names). Ian chose to keep it over UI UX's suggestion to drop it. It goes in S3. (The table and slice text below that say otherwise are superseded by this section.)
5. Rows not cards, and the sections This store / Company / People and access / Devices and connections, are approved.
6. Queue: PRs go to the merger via BOSS with census and pin numbers; branch pushed when S1 opens; wait for #271 and #273 before touching their files, #272 is held.
**Not this task:** moving data out of Firestore (T-586), the one store screen (T-586 S1, after Lipa go-live), POS v2 under `/pos`.
**In flight, do not touch until merged:** #273 T-582 `/admin/pos-tablets`, #271 T-533 `/admin/stores/[id]` POS mode, #272 T-583 inventory locations.

## Problem (measured on main 4bd009f, `settings-audit` map of 24 settings surfaces)
1. **Three front doors for the same things.** The Setup group in the sidebar (10 links), the `/settings` hub (12 cards) and `/admin/stores/[id]`. A person must already know which door holds their setting.
2. **The hub is incomplete.** It lists 12 cards and omits Users and roles, Position access defaults, Kitchen setup, Menu hours, Clock terminals, Clock lane, Payroll rates, Usage source, Recurring bills.
3. **One flat list, three different kinds of setting.** Company-wide (admin), this store's (manager) and people/access are mixed in one grid, so a manager reads six cards they cannot change ("Admin only" is written at the end of a long sentence, or not at all).
4. **A manager is let into screens that refuse the save.** Organisation and Expense categories open for a manager (they inherit the hub's `manage_store_settings`) and refuse only at Save.
5. **Cashiers see admin-ish links.** Clock terminals and Clock lane have no route key, so the sidebar shows them to every signed-in person.
6. **Words that need a developer to decode:** "Clock lane", "POS link", "Kitchen setup", "Wastage Monitor", "Business rules" (hides the VAT and withholding rates), "Usage tolerance" vs "Usage source". Spelling differs (Organisation / Organization).
7. **Same setting, two names or two places:** POS tablets (`/settings/pos-tablet` and `/admin/pos-tablets`; T-582 reshapes the second), withholding figures in Business rules and Payroll rates, Budgets nav + hub card.
8. Back links to Settings exist on some children and not others.

## Principles
- One door: **Settings** is where every business setting is reachable, in at most two clicks. (Ian's standing rule: every business value has a UI door.)
- Group by **what the person is doing**, in their words, not by module names.
- Show each person **what they can change**, and say plainly what they can only view. Hide what they cannot even read (same ROUTE_CAPABILITY map as the sidebar, T-288, so the two cannot drift).
- Plain labels first, the old name stays findable (a search box and "also called").
- No new capability and no new settings table; a card is a link plus a sentence.

## Options
**A. Tidy.** Fix labels, add the missing cards to the hub, group the hub, add the back link everywhere. Sidebar unchanged. Smallest, safest; the three doors remain.
**B. One door (recommended).** A, plus: the hub is grouped into four sections — **This store** (what a manager changes), **Company** (admin), **People and access**, **Devices and connections**; each entry is a ROW (label, one-line hint, "View only" tag where it applies, chevron; the whole row is the link, 44 px tall; one bordered panel per section, two panels side by side on wide screens), not a card; entries are role-aware (hidden if no read right, "View only" tag if read without write) and show the old name as "also called"; the sidebar Setup group shrinks to **Settings**, **Users and roles**, **Stores** (the rest are reached from the hub). Nav-route-reachability keeps passing because every child stays linked from the hub.
**C. Store first.** Pick the store once at the top of Settings and every per-store screen follows it. Biggest win for owners of several stores, but it needs T-586's one store screen to land first. Later, not now.

## Recommended hub (option B), real labels
| Section | Row (plain label) | Was | Who changes |
|---|---|---|---|
| This store | Menu hours | Menu hours (T-567 ruling: keep this word) | manager |
| This store | Kitchen stations | Kitchen setup | manager |
| This store | Sales channels (walk-in, Grab, Foodpanda) | Sales channels | manager |
| This store | Wastage Monitor | (name kept, Ian) | manager |
| This store | Attendance and pay rules | Attendance & payroll | manager |
| This store | Spending limits | Budgets / Expense budgets | manager |
| This store | Recurring bills | Recurring bills | manager |
| This store | Store positions | Store positions | manager |
| Company | Company name, TIN and tax | Organisation | admin |
| Company | Expense categories | Expense categories | admin |
| Company | Business rules | (name kept, Ian) | admin |
| Company | Payroll rates (SSS, PhilHealth, Pag-IBIG, tax) | Payroll rates | admin |
| Company | Stock usage tolerance | Usage tolerance | admin |
| Company | Stock usage source | Usage source | admin |
| Company | Stores (open, close, stock model) | Stores | admin |
| People and access | Users and roles | Users and roles | admin |
| People and access | What each position can do | Position access defaults | admin |
| Devices and connections | POS tablets and cash registers | POS tablet(s) | manager pairs, admin registers (after T-582) |
| Devices and connections | Clock terminals | Clock terminals | manager sees, admin sets |
| Devices and connections | Failed clock punches | Clock lane | manager |
| Devices and connections | Link to POS store | POS link | admin |
Words reviewed by UI UX (15 Nov); the old name appears under the row as "also called …". Rows, not the T-582/T-583 cards: those are records with actions, a hub is navigation. A cookbook entry, if ever added, uses the `post_production` key (#272).

## Slices (each its own small PR, nav/labels only, freeze-safe 20 Nov–14 Dec)
- **S1** hub regrouped, missing cards added, plain labels, "also called", back link on every child, spelling. No sidebar change.
- **S2** role-aware cards (hide / "View only") from ROUTE_CAPABILITY, and give Clock terminals and Clock lane a route key so cashiers stop seeing them.
- **S3** sidebar Setup group shrinks to three links. A "Find a setting" box is deliberately NOT built (UI UX: with four sections, about 21 rows and "also called", the browser's find covers it; add a plain filter later only if Ian asks).
- Wait for #273 before touching the POS tablet card; wait for #271 before linking to the store page's new POS sections.

## Pins and guards expected to move (reported as numbers in each PR)
`nav-route-reachability`, action-link-sweep, page-description sweep (T-348), census R rows; no capability or migration pins.

## Verify
Render at 390 px and desktop, manager and admin and cashier sessions (practice copy, port 9008 lock from BOSS); `nav-route-reachability` green; a test that every route in the settings audit appears on the hub for the role that can read it.

## Out of scope
Moving data (T-586), a new "settings" capability (settings-unification problem 11), the store-first picker (C), T-586's store sections.
