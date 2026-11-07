# T-544 — Channel settlements: one sidebar entry with tabs, and recording a settlement as a page

Status: SPEC (Opus), 2026-11-07. Queue slot from BOSS. Ian sent a screenshot of the "Record a settlement" modal and said: "improve not good
in the eye better to have it as page than modal. and can you compress 3 settlement pages on sidebar into just 1. use
tab if needed". Impeccable `layout`, applied as a refinement of an Operate-mode surface: keep the kit, the tokens and
every behaviour, and change only the drawing.

## Today (origin/main 27ba97a)
- The sidebar (`apps/erp/src/components/nav.tsx:40-44`) has three entries: Channel settlements, Upload settlement
  files and Review settlement days.
- `/channel-settlements/page.tsx:236` opens a `FormModal size="lg"` holding `SettlementForm.tsx` (573 lines). The
  form has two columns, a long description, ⛔ developer notes ("the legacy system… ₱198,148.29"), an icon-only
  submit (a pink paper-plane), and a cramped "Check the payout" side panel. Waiting-day rows link to
  `?channel=&day=#record`, which opens the modal (`defaultOpen`). `PlatformAgingSection.tsx:75` links to
  `?channel=` as well.

## ⛔ File boundary (BOSS, 7 Nov)
The settlement lane is editing these files, uncommitted, for T-511 S6. **Do not touch them:**
- `channel-settlements/SettlementForm.tsx`
- `channel-settlements/actions.ts`
- everything under `channel-settlements/review/`
- `channel-settlements/upload/actions.ts`

This task moves only the wrapper. Part B's form-layout list is a **hand-back to the settlement lane**, not work
for this task.

## Design (as built here)
### A. One entry, three tabs
- `nav.tsx` keeps only the Channel settlements entry, and it shows as current on every `/channel-settlements/*`
  route. Check how `SidebarNav` matches the current page, and match by prefix if it doesn't already.
- New kit component `components/ui/SectionTabs.tsx`: a `<nav aria-label>` of plain links, with
  `aria-current="page"` on the current one.
  - An underline strip on tokens: the current tab has a 2px brand bottom border and ink text; the others are muted
    and turn ink on hover.
  - At least 44px tall on touch screens. On phones it scrolls sideways and never wraps.
  - Props: `items`, `current`.
- `channel-settlements/layout.tsx` (server): `requireSession`, then `heldCapabilities` decides which tabs to show:
  - Overview: always
  - Upload files: needs `upload_settlement_files`
  - Review days: needs `record_ar_collection`

  It renders a small client `SettlementTabs` that reads `usePathname()` for the current tab and renders nothing on
  `/channel-settlements/record`. The layout is what lets `review/page.tsx` get tabs without being edited.
  `ROUTE_CAPABILITY` does not change.
- Page `h1`s stay as they are, because review/ can't be edited. The tabs sit above each page's own header.

### B. The record page
- `record/page.tsx`: loads exactly the data and props `page.tsx` passes to `<SettlementForm>` today, and renders it
  unchanged.
  - Header: "Record a settlement", a back link "← Channel settlements", and the modal's description, shortened as
    below.
  - Width: the page's normal content width. No modal chrome.
- `page.tsx`:
  - The FormModal is gone. Its trigger becomes a `+ Record settlement` link-button to `/record` (the kit's
    link-button style).
  - The waiting-row links go to `/record?channel=&day=`.
  - **Before `withFlash`**, if `channel` or `day` is in the query, `redirect()` to `/record` with the same query
    (for old bookmarks and for `PlatformAgingSection`'s `?channel=`).
- `actions.ts` is not touched. A post error still lands on the Overview with its banner, just as the closed modal
  did. Hand-back: the settlement lane should redirect record errors to `/record`.

### Form-layout hand-back (for the settlement lane, NOT this task)
- **SettlementForm layout.** Change only the drawing; every `name`, rule and handler stays identical.
  - On wide screens (lg and up), use a two-column page grid: the form on the left, at most about 44rem wide, and on
    the right a sticky "Check the payout" panel (`top-4`). On narrower screens there is one column, with the panel
    after the form.
  - The form has four labelled sections, each with an `h2` and a hairline divider, not nested bordered boxes:
    1. **Which day**: Channel and Day being settled, plus the "Banks into …" line as the hint for Channel. The day
       `<select>` must not clip the reported amount: give it the full row or a wider column.
    2. **The payout**: Gross the platform settled, Net actually deposited, Payout reference and Settled on.
    3. **What the platform deducted**: six inputs in a 3-column grid on wide screens and 2 columns on phones. Under
       the heading goes one short muted line: "Each fee posts to its own account. A deduction can be negative: a
       promo credit stays a minus."
    4. **Loan docked from the payout (optional)**: a `<details>` that opens on its own when a loan field has a
       value (from keep-typing) or the channel has an active loan. Otherwise it stays closed.
  - The panel holds:
    - Channel, Waiting balance and Verified day.
    - The preview `dl`.
    - A secondary button "Check the numbers" and a primary **text** button "Post settlement", kept disabled until a
      preview has run, as today.
    - One muted line: "Book platform fees here only. Don't also log them as an expense."
  - Remove the ⛔ characters and the "legacy system… ₱198,148.29" sentence from what users see. Keep them as code
    comments, since they are the why.
  - The `<details>` rule from the audit applies: no colour-only signals, money via the existing formatter, and no
    `text-neutral-300/400` (the T-514 guard).

## Contract
No behaviour change: the same actions, field names, preview call, posting, permissions and flash messages. This
adds one route (`/record`) and one kit component (`SectionTabs`), and removes two nav entries. No migration and no
domain change. Every census or baseline that moves (nav/route lists, action-link-sweep, touch-target, t450
inventory, form-grid, editable-record) is re-measured, never hand-edited. Any changed number goes to BOSS.

## Verification
- Typecheck.
- The unit suite plus the census tests.
- The integration tests that touch `/channel-settlements`, the settlement actions or the nav: grep for
  "Record a settlement", "channel-settlements", "Upload settlement files" and "Review settlement days". Update only
  the assertions that read the old drawing.
- A test that `/channel-settlements?channel=X&day=Y` redirects to `/record?channel=X&day=Y`.
- A test that the tabs hide Upload files and Review days without their capabilities, and render nothing on /record.
- A rendered Impeccable check at 1440 and 390 on port 9028 with a throwaway `shareat_test_*` DB seeded with one
  channel, one waiting day and one loan:
  - the Overview with tabs
  - the record page, empty and after "Check the numbers"
  - Upload files and Review days with tabs
  - the sidebar showing one entry, current on every tab
  - a real post of one settlement through the page
