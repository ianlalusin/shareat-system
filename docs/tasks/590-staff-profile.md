# T-590 — Staff profile page redesign (/staff/[employmentId])

Ian, 16 Nov 2026: "improve that page too — screenshot first, evaluate, then design well."

## What is wrong today (screenshots of erp2, 1440 wide)

1. No profile header. The top is a name plus a grey meta line with a code (`SE-001`) and a raw date.
   No photo, no status, no position.
2. The `sectioned` two-column flow leaves large empty holes: a short card sits beside a tall one
   (Positions next to the PIN form, Documents beside the agreement form, empty space beside Photo).
3. Forms are always open: the PIN box, the full "record agreement" form (7 fields), the signature
   canvas and the "End employment" form are all on screen at once, each with a red "Save is off
   until…" line. The page reads as a wall of half-filled forms.
4. Every card opens with a paragraph of explanation.
5. "End employment" — the only dangerous action — sits in the grid like any other card.
6. The photo is buried at the bottom although it is what identifies the person.

## Contract

- **No behaviour change.** The same server actions, field names, hidden inputs, rules
  (`STAFF_*_RULES`, `PAYROLL_DEDUCTION_AGREEMENT_RULES`), gates (`requirePageAccess`, `govIds`
  null-hiding, `view.canAct`, `isEnded`, `roleOnly`), `typedFor` refills and ConfirmDestructive tier
  (`admin-pin`) stay. Only the drawing moves.
- Reuse the kit only: `FormModal` (components/ui/Dialog.tsx), `EditableRecord`, `CheckedForm`,
  `Badge`, `Banner`, `HelpTip`, `Button` (R1: primary = icon + word), `ConfirmDestructive`.
  No new component unless a piece is used twice on this page (the avatar may be a small local
  function in this folder).
- Never put a `FormModal` inside another `<form>`.
- Words: plain (T-589 rules R1–R3): "store", never "branch"; en-PH long dates ("February 19, 2026");
  no ticket numbers, no code words.

## The new layout

### 1. Profile header (full width)
- Left: a 64 px round avatar — the staff photo (`/files/{photoFileId}`) when there is one, else the
  initials on a neutral circle.
- Name (h1). One line under it: primary position (or the role title for roleOnly) · store ·
  employment type ("Regular", capitalised) · "Started February 19, 2026".
- Pills beside the name: **Active** (success) or **Ended on <date>** (neutral);
  **No sign-in PIN** (warning) when `livePin` is null and the employment is open.
- Staff code shown small and muted after the meta line ("Staff code SE-001").
- Right (wraps under on phone): the PIN action — **Issue PIN** (primary) when there is none,
  **Re-issue PIN** (secondary) when there is one — opening a `FormModal` that holds, in order:
  the multi-store warning Banner (unchanged logic, shown BEFORE the field), the existing PIN
  `CheckedForm`, and the "signs this person out everywhere" note. Hidden when ended.
- The ended notice stays, as one line under the header.

### 2. Two columns on ≥ lg (main 2/3, side 1/3); one column on phone
Each column stacks its own cards, so no holes. Drop `sectioned` from `<Page>`.

**Main column**
1. **Name** — the EditableRecord as now. Help text shortened to one line; the "saved in one box"
   case keeps its sentence because it tells the admin what to do.
2. **Positions** — as now. When none are assigned, the locked view says "No position yet".
3. **Government numbers** — as now (summary shows only "On file"/"Not set"). The payroll rule
   moves into a `HelpTip` beside the heading.
4. **Charges and repayment agreements** (`DeductionAgreementsSection`):
   - The legal explanation moves into a `HelpTip`.
   - The waiting list stays. When `view.canAct && waiting.length > 0`, the "Record signed
     agreement" form moves into a `FormModal` (size `lg`) opened by a **Record agreement** button in
     the section header. Its fields are unchanged.
   - Active agreements and history stay as lists.
5. **Documents** (`DocumentsSection`) — unchanged content.

**Side column**
1. **Access** — one card, three rows, each a 44 px row link with a chevron:
   - "Sign-in PIN" — "Issued September 14, 2026" or "Not issued — this person cannot sign in"
     (warning ink). No form here; the form is the header's modal.
   - "Role and access" — "Which screens they can open" → `/admin/users/{personId}`.
   - "Clock-in card and fingerprint" → `/staff/{id}/credentials`.
2. **Photo and signature** — photo upload and signature pad as now (forms unchanged). Help text
   one line: "Photo prints on the ID card. Signature prints on payslips and cash forms."

### 3. End employment (full width, last)
- Not ended: one row — "End employment" heading, the line "The record stays visible. An
  administrator approves with their own PIN.", and a danger-outline **End employment** button
  that opens a `FormModal` holding the existing `CheckedForm` (end date, status, ConfirmDestructive
  admin-pin). Status options show "Resigned" / "Terminated" (capitalised label, value unchanged).
- Ended: the one line "Ended <date> as <status>." as now.

## Checks
- `tsc`, the erp unit suite, and the census guards re-measured (never hand-edited):
  action-link-sweep, touch-target, t412 destructive census, form-grid / editable-record / live-check
  guards, PAGES ledger (mark `/staff/[employmentId]` with this PR).
- Integration tests that render this page (grep `staff/` in tests/integration) — fix only
  assertions that read the old drawing.
- Render at 1440, 1280 and 390 on port 9028 (docs/SMOKETEST.md), with: an employee with a pending
  charge and no PIN; one with a PIN and photo; an ended one. No sideways scroll, no console errors,
  modals open and close.
