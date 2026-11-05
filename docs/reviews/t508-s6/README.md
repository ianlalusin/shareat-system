# T-508 S6 - practice-copy proof: the ERP menu feeds the POS

Practice copy only (local `_test` database, local Firebase emulators). ERP on 9008, POS on 9019 with `POS_MENU_SOURCE=erp`.
Seeded by `scripts/practice-erp-seed.ts`: Practice Co / Practice Branch, stations Grill and Drinks, 5 items routed (2 packages, 2 a-la-carte, 1 refill),
a Flavours option group on the refill. No logins or secrets are in these files.

How to repeat: start emulators, seed Firestore and the ERP, start the ERP and the POS (steps in `apps/pos/emulator/PRACTICE.md`), sign in to both.
`api-*.txt` is `GET /api/pos2/menu` with the practice manager token, practice store header and the linked tablet's device id (stations, items and their station, "not on POS").

| Step | Result | Evidence |
|---|---|---|
| (a) POS shows the ERP packages | PASS. New Session lists Classic Unlimited P399 and Premium Unlimited P599 (the Firestore-only Supreme P799 is absent, so the list is the ERP's). Flavours Garlic Butter, Original, Spicy come from the ERP option group. | `a-pos-packages-from-erp.jpg`, `api-1-baseline.txt` |
| (b) Rename a station in the ERP `/kitchen` page (Grill to Charcoal Grill); after a POS refresh a new ticket shows the new name | PASS. The POS Kitchen screen tab reads "Charcoal Grill" and the new Table 2 ticket sits on it. The menu content hash changed. | `b-1-erp-kitchen-before.jpg`, `b-2-erp-kitchen-renamed.jpg`, `b-3-pos-kitchen-tab-renamed.jpg`, `api-2-after-rename.txt` |
| (c) Remove a route (Pork Belly Plate) | PASS. After a POS refresh the add-ons picker no longer lists it; the ERP shows the "Not on the POS yet" panel naming it; the API lists it under notOnPos. | `c-1-pos-addons-without-removed-item.jpg`, `c-2-erp-not-on-pos-panel.jpg`, `api-3-after-route-removed.txt` |
| (d) Open a table with a package; the kitchen ticket lands on Grill | PASS. Table 1 / Classic Unlimited ticket appears on the Grill tab (taken before the rename in the same run). | `d-kitchen-ticket-on-grill.jpg` |

Notes: `b-1` was taken on an earlier run of the same seed (identical view). The ticket's "Flv: Unknown" label is the old kitchen screen not resolving
ERP flavour ids to names; it is cosmetic and outside S6.
