# T-548 — Every modal: fixed header, fixed action footer, one scrollbar

Status: SPEC (Opus), 2026-11-07. Ian, via BOSS: "for modal like the receipt add header and footer so only the middle
scroll and limit to just 1 scrollbar all modals". Impeccable `layout` + `adapt`, refinement of an Operate surface.
Branch `t548-modal-frame`, worktree `wt-t548`. Queue slot from BOSS.

## Today (origin/main f5f0944)
- `components/ui/Dialog.tsx` already draws a header (title, description, Close), a scrolling body
  (`.erp-dialog-body`, `overflow-y-auto`) and an optional `footer`. But:
  1. The page behind the modal still scrolls (native `showModal()` does not lock it), so two scrollbars show.
  2. The `<dialog>` element keeps the UA default `overflow: auto`, so when the panel is taller than `max-height`
     the dialog AND the body can both scroll.
  3. The 73 `<FormModal>`s pass their whole form as `children`, so Save/Cancel sit at the bottom of the scrolling
     body and scroll out of view on long forms (the settlement form, the loan form, the receipt).
  4. Some modal bodies hold their own `max-h-* overflow-y-auto` areas: a second vertical scrollbar.
- `FormModal` has no `footer`. Lightbox (`components/upload/Lightbox.tsx`) is a separate raw `<dialog>`.

## Ruling: the actions stay INSIDE the form, pinned with `position: sticky`
Moving Save out of the `<form>` into `Dialog`'s footer (linked by `form="id"`) was rejected:
- `SubmitButton` uses `useFormStatus`, which only sees its own form, so the button would lose "Saving…" and allow
  a double submit.
- `SubmitButton` and the "Save is off until…" line read `CheckContext`, which only exists inside the
  `CheckedForm`.

So: the form's action row is pinned to the bottom of the one scrolling body. It looks and behaves as a fixed footer
(only the middle scrolls), and every button keeps its form, its pending state and its check line.

## Design

### S0 — kit (one builder, first; everything else depends on it)
1. **One scrollbar.**
   - In `globals.css`, add `html:has(.erp-dialog[open]) { overflow: hidden; }` so the page behind is locked while
     any modal is open. Pure CSS, so no listener to leak. Check `scrollbar-gutter`, so the page does not jump
     sideways when the scrollbar disappears; add `scrollbar-gutter: stable` on `html` only if the jump is visible.
   - `.erp-dialog { overflow: hidden; }`, so the dialog element never scrolls itself.
   - The panel's inner flex column fills the dialog height: header and footer `shrink-0`, body
     `min-h-0 flex-1 overflow-y-auto overscroll-contain`. At phone width (< 640px) the dialog is already full
     screen (100dvh). Keep that.
2. **`DialogActions`**, a new kit component exported from `@/components/ui`:
   - A `div` with `data-dialog-actions` holding the action buttons, right-aligned, gap-2, wrapping on phones.
   - Inside `.erp-dialog-body` it is `position: sticky; bottom: 0`, with surface background and a top hairline.
     Negative inline margins match the body padding, so it spans edge to edge. Bottom padding is
     `max(py, env(safe-area-inset-bottom))` on phones.
   - Outside a dialog (the same form rendered inline somewhere) it is an ordinary row: scope the sticky rule to
     `.erp-dialog-body [data-dialog-actions]`.
3. **The check line rides in the band.** `CheckedForm` renders `<CheckSummary>` after its children, which today
   puts it under the action row and lets it scroll away. When the form contains a `DialogActions`, the summary
   must render INSIDE the sticky band, directly above the buttons, with exactly one live region. A disabled Save
   is never unexplained (T-440 Q2). Pick the smallest way:
   - `DialogActions` renders the summary from `CheckContext`, and `CheckedForm` skips its own when an actions band
     registered through context; or
   - an equivalent approach.
   Add a test: one `aria-live` region, inside the band.
4. **`Dialog.footer`** stays for dialogs whose actions are not a form (receipt-style viewers, Lightbox if
   converted, confirmation panels). Footer: `shrink-0 border-t`, the same padding and alignment as `DialogActions`.
5. **Close button:** keep its current behaviour. PR #191 (T-545, DeepSeek, unmerged) changes only its size, to
   44px on touch. Don't change the Close button markup beyond what this task needs. At rebase, keep #191's version.
6. **Lightbox:**
   - Give it the same lock and single-scroll rules (its own `<dialog>`).
   - Do not convert it to `Dialog` unless that is a small diff.

### S1–S4 — the site sweep (parallel builders, disjoint files)
For every `<FormModal>` / `<Dialog>` / `EditableRecord` modal and its child form:
- Wrap the form's existing action row (SubmitButton, secondary buttons, cancel/back links) in `<DialogActions>`.
  It must be the form's LAST child. Keep the buttons, their order, names, `formAction`s and variants exactly as
  they are.
- Remove any nested vertical scroll inside the modal body: `max-h-* overflow-y-auto` / `overflow-auto` on inner
  divs. Horizontal `overflow-x-auto` on wide tables stays (that is not a second vertical scrollbar).
- Leave a site alone when it has no action row (a read-only modal), or when its actions are per row inside a list
  (e.g. a row's own Remove button). List those in the hand-back.
- Never nest a FormModal inside another `<form>`.
- Forms that are also rendered outside a modal keep working, because `DialogActions` is a plain row there.
- Do not add Cancel buttons. The header's Close is the cancel; that is unchanged.

Slices, by file:
- **S1 money:**
  - ap/page, ap/invoices/[id], ap/suppliers/page, ap/suppliers/[id]
  - cash-requests/page, cash-requests/[id]
  - liabilities/page, liabilities/[id]
  - loans/page, loans/[id]
  - money-accounts, money-transfers
  - owners/page, owners/[id]
  - prepaid/page, prepaid/[id]
  - remittance, service-charge, statutory-discounts
- **S2 inventory, commissary, trade, menu:**
  - inventory/{counts, counts/[id], deliveries, locations, pos-map, production, transfers, usage}
  - commissary/{catalogue, orders, orders/[id]}
  - trade/orders, items, wastage
  - menu/page, menu/DaypartsSection, menu/items/[id], menu/prices, menu/requests
- **S3 people, settings, customers, admin:**
  - attendance/leave/page, attendance/leave/CertificateView
  - payroll/page, payroll/rates
  - settings/{attendance, expense-categories, pos-link, usage-tolerance}
  - customers/{page, [customerId], price-lists, price-lists/[id]}
  - admin/stores, cutover/opening
- **S4 components:**
  - components/forms/EditableRecord
  - components/upload/{PhotoThumb, PhotoUpload, Lightbox}
  - components/SignaturePad
- ⛔ **Not here:**
  - `channel-settlements/review/DayDetail.tsx`, `SettlementForm.tsx`, `channel-settlements/actions.ts` (the
    settlement lane's files, S6/S6d). The record form is no longer a modal since T-544.
  - The POS receipt (`app/pos/_payment/ReceiptScreen.tsx`) is in PR #196 on lane/pos-screens. Don't touch that
    branch. After #196 merges it becomes **T-548 S5**, a follow-up: the receipt's Reprint/Done move to
    `Dialog.footer`.

## Contract
- No behaviour change. Same forms, field names, actions, rules, permissions and button order. Only the placement
  (pinned) and the scroll containment change.
- No migration, no domain change.
- Censuses and baselines (action-link-sweep, touch-target, form-grid, editable-record, live-check, t450 inventory)
  are re-measured, never hand-edited. Any number that moves goes to BOSS.

## Verification
- Typecheck.
- The unit project.
- Census tests.
- New tests:
  - `DialogActions` is the last child of each swept form: a source scan over the swept files, so a new modal
    without one is caught.
  - One `aria-live` check line inside the band.
  - No `overflow-y-auto` / `max-h-` inside modal children in the swept files: a scan with a named allow list.
- Integration tests that render the swept pages: update only assertions that read the old drawing.
- Rendered Impeccable check, before (origin/main) and after, at 1440 and 390, port 9028, scratch `shareat_test_*` DB.
  Modals to open:
  - a long form (loans/[id] Record payment, or the commissary order)
  - a short form (ap/suppliers + Add)
  - EditableRecord edit
  - Lightbox
  For each:
  - scroll the body: the header and action band stay put, the page behind does not move, and the document shows
    exactly one vertical scrollbar
  - with a blocked Save, the "Save is off until…" line shows in the band
  - a real save through one pinned button still shows "Saving…" and lands
