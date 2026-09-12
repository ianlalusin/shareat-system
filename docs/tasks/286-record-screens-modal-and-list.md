# T-286 — settings screens are a stack of always-open edit forms

> ⚠️ **SPEC ONLY. No code in this task yet.** Task number provisional pending allocation.

**Ian, 2026-09-12:** *"there are pages like sales channel that when an item is saved it remains a
form, good for quick edit but easy to be mistakenly edited and the new item is always at the bottom
of the page. look for pages that has this set up and improve. separate the create edit modal called
by a button. once saved switch to grid, table or card view."*

## The population, measured

Every row on these screens renders a **complete, always-editable form**, and the create form sits
at the bottom of the page below all of them:

| Screen | Shape |
|---|---|
| `settings/sales-channels/page.tsx` | Every active channel is a full `ChannelForm`; "Add a channel" at the bottom |
| `inventory/locations/page.tsx` | `updateLocationAction` form per row; `createLocationAction` at the bottom |
| `expenses/recurring/page.tsx` | `updateTemplateAction` per row with its own `submitLabel`; "Add a template" at the bottom |
| `settings/expense-categories/page.tsx` | "Add a category" at the bottom |
| `money-accounts/page.tsx` | "Add a money account" at the bottom |

Ian's two complaints are both structural, not cosmetic:
- **Accidental edits** — a live text input beside every record, on a touch screen.
- **The new item lands at the bottom** — because the create form is the last element and the list
  is not ordered for a reader.

## ⛔ The constraint that shapes the whole design

These pages are **server components with no client bundle**, deliberately. `ChannelForm`'s own
header: *"these screens are server components with no client bundle, and the honest arrangement is
to show the field with the condition written next to it."* The app runs on counter tablets.

⭐ **So a React-state modal is the wrong instrument** — it converts five zero-JS screens into
client components to solve a layout problem.

### The recommendation: route-based create/edit, rendered as an intercepting-route modal

- `/settings/sales-channels` — a **table**, read-only, one row per channel.
- `/settings/sales-channels/new` and `/settings/sales-channels/[id]/edit` — real routes holding the
  existing form, unchanged.
- Next's intercepting routes render those as an overlay when reached from the list, and as a full
  page on direct navigation or refresh.

This gives Ian exactly what he asked for — a button, a modal, a table after save — and **with
JavaScript off it degrades to an ordinary page instead of breaking**. The forms themselves are
lifted, not rewritten; the server actions do not change at all.

⚠️ **Verify the intercepting-route API against `node_modules/next/dist/docs/` before building.**
CLAUDE.md's standing warning: this is not the Next.js in your training data, and the app is on
**16.3.2**.

## ⭐ Decide the pattern ONCE, then apply it five times

RULES §3 makes UI/UX a third authority: *one uniform, reusable pattern set*, familiar-but-upgraded,
**and POS is the presentation benchmark where it and ERP-rebuild disagree**. T-259 has prior art on
a sweep like this being told to resolve its hard cases first and explicitly not widen.

**So this task is sequenced deliberately:**

1. **Slice 1 — `settings/sales-channels` alone**, producing a reusable `RecordList` + route-modal
   pattern. Ian reviews the real screen.
2. **Slice 2 — the other four**, mechanically, only after slice 1 is approved.

⛔ **Do not start slice 2 on momentum.** Five screens converted to a pattern Ian has not seen is
five screens to re-do.

### Before designing the table: read POS

`webapps/POS` is the benchmark and is read-only. Its list screens are the reference for density,
row actions and how a record opens. **Read it as requirements, never as design** (RULES §3).

## The hard cases, which slice 1 must resolve rather than defer

1. **`sales-channels` has THREE actions per record** — update, retire, and (when retired)
   reactivate. A table row needs somewhere for the destructive one that is not next to the edit.
2. **The remittance radios carry no `defaultChecked` on create, deliberately** — `is_remitted_daily`
   is NOT NULL with no default and "unanswered" must survive to the server and be refused. ⛔ A
   create route must not acquire a default by accident.
3. **`inventory/locations` rows are not independent** — one default room per store, one Receiving
   room per store, and the single-room rule (now reachable via T-284). Editing one row can refuse
   because of another.
4. **Ordering.** Ian's "always at the bottom" is partly the create form's position and partly that
   nothing orders the list for a reader. Decide the order explicitly — name, or active-then-retired
   — rather than inheriting the repo's return order.
5. **The touch-target census.** `apps/erp/tests/action-link-sweep.test.ts` pins 151 FAIL / 56
   UNRESOLVED per file. A five-screen rewrite moves that a lot; entries must be adjudicated, not
   regenerated wholesale — the baseline's own `_note` forbids editing it to make a regression
   disappear.

## Open question for Ian

**Table, grid, or cards?** He offered all three. Recommendation: **table** on `sales-channels`,
`money-accounts` and `expense-categories` (short rows, scannable, sortable) and **cards** on
`inventory/locations`, whose rows carry role/purpose/default badges that read poorly in columns.
Worth a look at one real screen before committing the other four.
