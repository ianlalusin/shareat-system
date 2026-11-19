# T-611: "Copy from another store" for menu hours, prices, kitchen routes and discount presets

**Owner:** builder (Sonnet), one slice at a time. **Spec:** BOSS (Opus), 19 Nov 2026.
**Ian, 19 Nov 2026:** "add a helper … to easily copy the settings from one store to other store … then a checkbox where to copy it"; after the ROI study, **"A, go"**: four screens, in this order.
**No migration expected.** If one seems needed, stop and report.

## Why this scope (from the ROI study)

- The menu catalog is org-scoped, so copying works **within one org**: Lipa → Malvar and future branches. Cross-org targets (Davao, franchises) would need a catalog copy first; they're **out**.
- Value by size: store prices and option prices (200–400 rows/store), kitchen routes (100–180), menu hours (2–3, needed before time-of-day prices), discount presets (3–8).
- Access defaults already have copy (`apps/erp/src/app/admin/access-defaults/actions.ts:110-208`). Business rules are already org-wide.
- **Pattern to follow:** v1's checklist copy-to-stores (`ERP-rebuild/src/lib/actions/manager-daily-report.actions.ts:84-150`, UI `recurring-checklist.tsx`; read-only): admin only, checkboxes for target stores, additive, skips what exists.

## The shared copy window (built in S1, reused by S2 and S3)

- Each covered screen gets a **"Copy from another store…"** button (admin only), which opens one shared dialog component:
  1. Pick the **source** store (default: the screen's current store).
  2. Tick **target** stores (checkboxes, same org, active stores only, the source excluded).
  3. Options, where the slice allows: **"Replace existing"**, off by default.
  4. **Preview** (server-computed, read-only): per target, "N to add · M already the same · K different (kept unless Replace is on)", with an expandable list.
  5. **Confirm** with the admin PIN (the existing destructive-action approval, T-412 Tier P, as on the staff record), then apply.
- **Apply:** one transaction per target store. All-or-nothing per target; a failure on one target doesn't undo the others, and the result lists each target's outcome.
  - Writes go **through the existing domain write functions** of each setting, so their guards, audit rows and effective dating stay in force. **Never raw SQL.**
- **Audit:** one `settings.copied` row per target: kind, source store, counts added/replaced/skipped.
- **Capability:** reuse the capability each screen already needs to edit, held at **every** target store, plus admin role. No new capability unless the build forces one (then stop and report).

## Slices

### S1: menu hours and store prices (+ option prices)

- **Menu hours** (`menu_dayparts`): copy by **name**.
  - A target with no hour of that name gets it.
  - With Replace on, a same-name hour's days and times are updated through `updateDaypart`.
  - T-610's overlap refusal applies: an overlap refuses that target with the T-610 sentence. (T-610 must merge first.)
- **Store prices** (`menu_offers`, `menu_option_offers`): for each live source offer (variant × channel × daypart), set the target's live offer.
  - Map the daypart by **name** to the target's hour. If the target lacks that hour, copy the hours first (the preview says so) or skip that offer with the reason.
  - Missing at the target → a new offer effective now. Same price → skip. Different → kept, unless Replace is on; then a new effective-dated offer replaces it. **History is never edited.**
  - A variant not offered at the source is never withdrawn at the target, so copying never removes items.
  - Go through the existing offer writer and its 0233/0196 guards.
- **Screens:** `/menu/hours` and `/menu/prices`.

### S2: kitchen stations and routes

- **Stations** copied by **name** (missing → created).
- **Routes** (item → station) copied by item and station name.
  - Missing → added. A different station at the target → kept, unless Replace is on.
- **Screen:** `/kitchen`. Use the existing kitchen writers.

### S3: discount presets

- `pos_discount_presets` copied by **name**: missing → added; a different rate or rule → kept, unless Replace is on.
- Statutory SC/PWD rules stay org-wide and are not copied.
- **Screen:** wherever presets are edited (find it; if presets have no screen, add the copy button to `/admin/pos-tablets` beside the stands, and report).

## Never copied (refused by design; the preview never offers them)

- tenders and money accounts
- sales channels' money accounts and platform store codes
- tablets, terminals, pairings and clock terminals
- POS mode
- store identity (name, address, TIN branch code, contact)
- stands (floor plan)

## Tests (per slice, integration on any `_test` DB; each with a mutant that goes red)

- The preview counts match the apply.
- Additive by default: different target values are kept; Replace off vs on.
- Prices: history rows are untouched, the new offer is effective now, and the daypart is mapped by name. A missing target hour is skipped, or copied first, as the preview said.
- A target in another org is refused. A non-admin is refused, as is an admin without the edit right at a target.
- One target failing (e.g. a T-610 overlap) leaves the other targets applied.
- The audit row has the counts. A wrong admin PIN is refused.
- **Mutants:** Replace ignored (overwrites anyway) → red; the org check dropped → red; editing history instead of a new offer → red.
- **Pins:** t343, domain-actions-have-callers, the T-412 destructive census (copy is Tier P), touch census, the audit catalogue ceilings.

## Out (with reasons)

- **Cross-org copy (Davao, franchises):** needs a catalog copy; a separate task if wanted.
- **Stock thresholds, attendance config, sales-channel names:** small gains; later if Ian asks.
- **Scheduled or automatic sync between stores:** copying is a one-off act. Live sync would hide per-store differences the manager owns (row 316: the manager sets prices).
- **Copying a whole store in one click:** the four screens cover setup; a "copy everything" wizard can come later, built on these.
