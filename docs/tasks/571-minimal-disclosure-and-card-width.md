# T-571 — A collapsed card that holds nothing but a button, and the half-empty card row

Status: **BUILT** on branch `fix/disclosure-minimal` (worktree `.worktrees/disclosure`), from `origin/main`
`9b4041d`, 8 Nov 2026. Ian, on the deployed supplier page (`erp2.shareat.net/ap/suppliers/01a148a4-…`):

> "find every instance of this card which collapse but only has a minimal content like just this one it just have
> 1 button. the button in here can be taken out of the card, the details card may use full wdth of the page."

Screenshots: the page's details card ends halfway across a 1600 px window, and below it a full-width bordered card
whose summary is **Edit this supplier** — expanded, it contains one pencil button and nothing else.

## Today (origin/main `9b4041d`)

- **T-448 moved every record form into a dialog.** `EditableRecord`'s LOCKED state is now a single pencil button
  (`components/forms/EditableRecord.tsx`, `EditableRecordView`): the form lives in `<Dialog>`, mounted but closed.
- The supplier page still wrapped that record in a native `<details>` + `<summary>Edit this supplier</summary>` —
  written before T-448, when the form was inline and the card had something to reveal. After T-448 the card opens
  onto one button. Same page, `apps/erp/src/app/ap/suppliers/[id]/page.tsx`.
- **Detail pages are a two-column grid at ≥1440 px** (`globals.css`, "compact … detail layouts" commit
  `79d4c4f`): `\[data-sectioned\] > *` spans both columns, but `> section:not(:has(table))` was forced to ONE
  column — even when it was the only card in its row. The supplier's details card has no table, so it sat in
  column 1 with column 2 empty.

## Sweep — every disclosure, and how many hold only a button

All 35 `<details>` blocks under `apps/erp/src` were read (access-defaults' nested grids, the revoked/retired
lists, the payment/template/budget forms, the raw-event and history panels, `ClosedMonthOverride`,
`DisclosureCard`). **Exactly one held a lone action**: the supplier page's card around `EditableRecord`. Every
other one reveals real content (a list, or a form with fields). So the fix below is one card, and the guard keeps
it that way.

## Design

### The button leaves the card

- The `<details>`/`<summary>` is deleted. The `EditableRecord` moves into the **details card's header row**, beside
  the heading of the facts it edits — the same placement `items/[id]`, `fixed-assets/[id]` and `staff/[employeeId]`
  already use for their per-section pencils.
- The card's `sr-only` `<h2>Supplier details</h2>` becomes visible, so the header row has something to sit beside.
- Nothing else on the record changes: same `SUPPLIER_ADD_RULES`, same `editSupplierAction`, same `hidden`
  `supplierId`, same `typed` reopen (a refused save still lands with the dialog open, because
  `EditableRecord`'s own initial state is "editing" when `typed` is present — the `<details open>` it used to
  rely on is not needed).

### A card shares the row only with another card

`globals.css`, inside the existing `@media (min-width: 1440px)` block. Replaces the blanket
`> section:not(:has(table)) { grid-column: auto; }` with the two halves of a pair:

```css
/* first of a pair: has a table-less section right after it */
.erp-page[data-view="detail"][data-sectioned] > section:not(:has(table)):has(+ section:not(:has(table))),
/* second of a pair: has a table-less section right before it */
.erp-page[data-view="detail"][data-sectioned] > section:not(:has(table)) + section:not(:has(table)) { grid-column: auto; }
```

| layout | before | after |
|---|---|---|
| one table-less card, then a table/no card | half width, right half empty | **full width** |
| two table-less cards together | side by side | side by side (unchanged) |
| two pairs, or four in a row | two per row | two per row (unchanged) |
| a run of three | 2 + 1 (the third half, empty beside it) | unchanged — see "not fixed" |

## Contract

- No field, action, permission, rule, sentence or route changes. The form still posts exactly the same names
  (`name`, `vatStatus`, `classification`, `status`, `termsMode`, `issuesOfficialReceipt`, `bankName`,
  `bankAccountName`, `bankAccountNumber`, `notes`, and `creditTermsDays` through `nativeAttrs`).
- The undo/cancel semantics of `EditableRecord` are untouched (the dialog is the same component).
- Two measured censuses move because a control CEASED TO EXIST (the removed `<summary>`), never to make a test
  pass: `action-link-sweep` total 1540 → 1539, FAIL 115 → 114, and the `app/ap/suppliers/[id]/page.tsx` 20 px
  baseline entry is removed (`touch-target-baseline.json`). Each carries a dated comment line, as that file
  requires. `t450-phone-table-*`, `t452`, `t440-s2` and `t384` censuses re-run unchanged.

## Out (recorded, not done)

- **A run of three table-less cards** still leaves the third alone in a half-width cell. CSS cannot count a run;
  fixing it needs either a one-column grid (which would undo the deliberate two-up) or a server-side layout
  decision. No page has such a run today except access-defaults' nested grids, which are not `sectioned`.
- `components/ui/DisclosureCard.tsx` has **no production caller** — every page hand-rolls `<details>`. Kept (never
  delete a feature unasked); noted in DEF-822 so it is not rediscovered.
- POS and Customer apps: separate apps, own layouts.

## Tests

`apps/erp/tests/t571-minimal-disclosure-and-width.test.ts` — 9 tests:

- **the scanner, with a control:** a fabricated `<details><EditableRecord/></details>` is reported, a
  `<details><form>…</form></details>` is not; the real tree reports none.
- the supplier page has no `<details>`, no `Edit this supplier` summary, the pencil between the heading and the
  facts, and every edited field still present.
- the pair rule: both selectors are in `globals.css`, the second half is evaluated against a real DOM (a
  table-less `section` after another table-less one matches; one after a table card does not), and the old blanket
  rule is gone. ⚠️ happy-dom 21 cannot evaluate a `:has()` nested inside a `:has()`, so the first half is pinned
  as source (Chrome 105+/Safari 15.4+/Firefox 121+ evaluate it) — said in the test, not hidden.

## Verification (measured, 8 Nov 2026)

- **`npx tsc --noEmit`** (root `tsconfig.json`): clean, exit 0.
- **`npm run build`**: exit 0; every route still `ƒ (Dynamic)`.
- **`t571-minimal-disclosure-and-width.test.ts`**: 9/9.
- **`action-link-sweep`**: 14/14 after the measured baseline moves above (1540 → 1539, FAIL 115 → 114, the
  supplier page's 20 px entry removed).
- **Guards that read this page or its form:** `t440-s9-applies-when` (renders the real `SupplierDetailPage`
  component and reads the `creditTermsDays` input out of the markup — green, which is this page's render check),
  `t389-keep-typing-guard`, `t384-s3-lock-and-save-guard`, `t411-row-link-census`, `t406-account-code-guard`,
  `t380-s4-guard`, `t348-page-description-sweep` — green.
- **`t440-s2-live-check-guard`**: 42/42 on its own (it takes ~40 s; the default 5 s per-test timeout expires when
  the whole unit project runs in parallel on this laptop, which is why it is recorded separately).

### Not done, and why

- **The integration render** (`t389-s1-supplier-web`) cannot run here: the local test database is behind
  `origin/main`'s schema (`column "counterparty_org_id" of relation "suppliers" does not exist`), so it fails on
  setup for reasons that predate this change. Applying migrations to the shared local `shareat_test` database
  while other lanes may be using it is not this task's call. The unit render above exercises the same component.
- **A browser click-through.** No signed-in session is available locally and production is not touched, so the
  visual result (one full-width details card, pencil in its header) is reasoned from the CSS and the render, not
  photographed.
