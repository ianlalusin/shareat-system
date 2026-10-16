# T-434 — Staff photo and signature (upload, replace, remove; signature guarded)

**Status:** spec written 2026-10-16, not started
**Model:** Sonnet (auth + files). Write any spec amendment in plan mode.
**Sources:** Ian 2026-10-16 (incl. answers to Q1-Q3 the same day); bible row 353 (standing): *"strictly guard staff and customer info, especially the signature; enforce proper rules"*.

## Goal, in plain words

A manager can put a staff member's **photo** and **signature** on file, replace them, or remove them.
The signature is later **printed on documents** (payslips, cash advance forms, ID cards). It is **not**
an approval method — PINs do that. Staff cannot upload their own. Because a signature image can be
forged, only payroll people and admins can ever see it, every view is recorded, and it never appears
on a card, a list or an export.

## What exists (verified 2026-10-16)

- `employments.photo_file_id` (`packages/db/schema/employment.ts:201-202`, migration 0080). Read by
  `employmentRepo.photoFileIds` (`packages/db/src/repo/employment.ts:444`); shown on the Staff wall
  (`apps/erp/src/app/staff/page.tsx:51-71`) behind `canViewPhoto` (`apps/erp/src/lib/photo-link.ts`).
  **No writer, no upload UI.**
- Broker: `packages/domain/src/files/index.ts` — per-purpose type/size limits (`PURPOSE_LIMITS`),
  app-wide 1 MB image ceiling (`MAX_IMAGE_BYTES`), EXIF stripping (`stripImageMetadata`,
  `@shareat/core/exif`), read capability per purpose (`PURPOSE_CAPABILITY`), short-lived signed URLs
  (`readFileUrl`), `canReadFile(s)`. Upload pattern to copy: AP invoice receipt
  (`apps/erp/src/app/ap/actions.ts`, `apps/erp/src/app/ap/invoices/[id]/page.tsx`).
- ⚠️ `stored_files.purpose` is a DB CHECK (`0032_t141_stored_files.sql:38`) with **no staff purpose**.
  Today a staff photo could only be filed as `onboarding_document` — wrong purpose, wrong limits.
- `apps/erp/src/components/PhotoInput.tsx` (file picker; `accept` prop, default `image/*,application/pdf`).
- v1: signature is a PNG **data URL** on the staff doc plus a history (`ERP-rebuild/src/types/index.ts:739-743`,
  `staff-details-client.tsx` `SignaturePad`, `memo-print.ts:18`). Goal to keep: draw once, reuse on paper.

## Decisions

1. **Signature lives on the PERSON: `persons.signature_file_id`** (nullable FK → `stored_files`, restrict).
   A signature is a legal mark of the human, not of a job; a person with employments at two stores has
   one signature, and a second copy per employment would drift. The photo **stays on the employment**
   (T-154 put it there: it is the store's ID-card picture, and a badge is per store).
2. **Migration: yes — `0204_t434_staff_photo_and_signature.sql`** (0203 is T-433's). Journal idx 204,
   `when` 1803699107084 (0203's 1803612707084 + 86400000). ⛔ **T-433 must merge first.** Adds `persons.signature_file_id`; widens
   `stored_files_purpose_check` with `staff_photo` and `staff_signature`; hand-authored per ADR-012 §5;
   update `same-org-fk-exemptions.ts`, classification and RLS registry if the guard asks. Full suite on a
   fresh gate DB (memory: full suite for migrations).
3. **Signature input: sign on screen only (Ian, Q3).** No scan/image upload for now. A canvas pad exported as PNG and sent through the same
   broker upload as a normal file (multipart bytes, never a data URL in the DB, action args or logs).
   Why: a scanned image needs a scanner and cropping and arrives with paper background; a pad is what v1
   staff already used.
4. **Photo input:** `PhotoInput` with `accept="image/*"` and `capture="user"` (phone front camera);
   existing client compression to 950 KB applies.
5. **Limits:** `staff_photo` jpeg/png/webp; `staff_signature` **png only**; both under `MAX_IMAGE_BYTES`;
   EXIF stripped by the broker (already automatic).
6. **Who can CHANGE (upload/replace/remove):** `enrol_staff` (store; super/admin/manager ✅, staff ✗),
   at the store of an OPEN employment of that person. Self-service refused even if the actor holds
   `enrol_staff` (actor person = target person).
7. **Who can SEE:**
   - Photo: unchanged level — `PURPOSE_CAPABILITY.staff_photo = 'enrol_staff'` at the file's store,
     checked in the loader via `canReadFiles` (as today), not only the UI.
   - Signature (Ian, Q1+Q2): may view **iff** the actor holds **`view_staff_signature`** at the file's
     store, **OR** holds **`enrol_staff`** (the upload capability) at a store where that person has an
     OPEN employment. `view_staff_signature` is NEW: store-scoped; super ✅, admin ✅ (automatic),
     manager ✗, staff ✗; position-grantable (e.g. payroll clerk); it does **not** grant `run_payroll`.
     Add the matrix row. Because this is an OR, `staff_signature` gets its own check function in the
     files module (`assertCanReadSignature`), used by both `readFileUrl` and `canReadFiles` — not a
     single `PURPOSE_CAPABILITY` entry. Everyone else sees only the text **"Signature on file"** (a
     boolean from the loader, never the file id).
8. **Where the signature may appear:** only on the staff detail page (`staff/[employmentId]`) as a
   "View signature" link that mints a short-lived URL per click through `readFileUrl`. Never on the Staff
   wall, cards, lists, search results or any export/CSV; loaders for those never select the column.
9. **Audit:** `staff_photo.set|replaced|removed`, `staff_signature.set|replaced|removed`, and
   `staff_signature.viewed` (actor, time, target person id; never the storage path or URL).
   **DEF-668 (part):** the audit for views is written INSIDE `readFileUrl`, after authorize, for every
   `staff_signature` read, and for `staff_photo` too (`staff_photo.viewed`) — same code path, so cheap.
   Signature links live **60 s** (`expiresInSeconds: 60`, enforced in `readFileUrl` for that purpose, not
   by the caller); photo stays at the 300 s default. Other purposes in DEF-668 stay open. Replace keeps
   the old file row (restrict FK) — the orphan sweep is not allowed to collect a file an audit row names.
10. **Prints that will use it (not built here):** payslip (`apps/erp/src/app/payroll/page.tsx` produces
    slips, no print yet), cash advance form (`cash-requests`, no print yet), staff ID card (T-387 wall,
    no print yet). Each later print calls one domain read `signatureForPrint(actor, personId)` that is
    gated and audited like a view. That function **is** built here.

## BUILDER paths (source)

- `packages/db/migrations/0204_t434_staff_photo_and_signature.sql` + `meta/_journal.json` entry (idx 204)
- `packages/db/schema/persons.ts`, `packages/db/schema/stored-files.ts` (`FILE_PURPOSES`)
- `packages/db/src/repo/persons.ts`, `packages/db/src/repo/employment.ts` (`setPhotoFileId`)
- `packages/db/src/rls/same-org-fk-exemptions.ts`, cutover classification / RLS registry if required
- `packages/domain/src/files/index.ts` (limits, `PURPOSE_CAPABILITY`)
- `packages/domain/src/people/index.ts` (`setStaffPhoto`, `removeStaffPhoto`, `setStaffSignature`,
  `removeStaffSignature`, `viewStaffSignatureUrl`, `signatureForPrint`)
- `packages/auth/` capability list; `docs/decisions/CAPABILITY-MATRIX.md` (new row)
- `apps/erp/src/app/staff/actions.ts`, `apps/erp/src/app/staff/[employmentId]/page.tsx`,
  `apps/erp/src/components/SignaturePad.tsx` (new), `apps/erp/src/components/PhotoInput.tsx` (capture prop)

## TESTER paths (tests only, disjoint)

- `tests/integration/t434-staff-photo-signature.test.ts`
- `tests/unit/t434-signature-pad.test.ts`
- `apps/erp/tests/t434-staff-signature-surfaces.test.ts`

## Cases (each names the mutant it kills)

1. Manager uploads a photo for an open employment at own store → column set, audit `staff_photo.set`. *Mutant: writer never persists.*
2. Replace photo → new id, old file row kept, audit `replaced`. *Mutant: replace deletes old row / skips audit.*
3. Remove photo → null, audit `removed`. *Mutant: remove is a no-op.*
4. Manager uploads signature PNG → `persons.signature_file_id` set, purpose `staff_signature`, audit. *Mutant: stored on employment or wrong purpose.*
5. Signature as jpeg or over 1 MB → refused. *Mutant: png-only/size limit dropped.*
6. A `data:` string anywhere in the signature action input → refused; no `data:` in any persons/stored_files column. *Mutant: data URL accepted.*
7. Stored photo bytes have no EXIF GPS. *Mutant: strip bypassed for new purpose.*
8. Staff-role actor uploads/removes → refused. *Mutant: capability check removed.*
9. Manager of store B on a store-A-only person → refused. *Mutant: store scope dropped.*
10. Manager uploads own signature → refused. *Mutant: self-service guard removed.*
11. Admin and a `view_staff_signature` position holder get a short-lived URL; each view writes `staff_signature.viewed` with actor, time, person. *Mutant: view not audited.*
12. Staff member, manager of another store, and a cashier each get only `hasSignature: true` ("Signature on file"): no file id in loader data, no link, refusal text names no file, path or person detail. *Mutant: loader returns the id and only the UI hides it.*
13. Store-A manager (holds `enrol_staff` at A, not `view_staff_signature`) CAN view the signature of a person with an open employment at A, and the view is audited; after that employment ends, cannot. *Mutant: uploader branch dropped, or not tied to an OPEN employment at the actor's store.*
14. Staff wall, staff list loaders and every staff export contain no `signature` field or signature file id. *Mutant: column added to a list select.*
15. `readFileUrl` for a signature by an unauthorised actor throws and writes no `viewed` row. *Mutant: audit written before authorize.*
16. Signature view URL is never logged (logger spy sees no URL/path). *Mutant: URL logged.*
17. Photo visibility unchanged: `enrol_staff` at the file's store sees it; another store does not. *Mutant: photo opened to all signed-in users.*
18. `signatureForPrint` is gated and audited exactly as a view. *Mutant: print path skips the check.*
19. Signature pad exports a PNG `Blob` (not a data URL) to the action. *Mutant: pad sends `toDataURL()`.*
20. Matrix row `view_staff_signature`: manager ✗ and staff ✗ fire; admin ✅ without any grant; a position grant gives a staff member view but `run_payroll` stays refused. *Mutant: role defaults grant it, or it implies `run_payroll`.*
21. Signature link expires at 60 s even if the caller passes 300. *Mutant: caller-supplied expiry honoured.*
22. Every `readFileUrl` for `staff_photo` writes `staff_photo.viewed`. *Mutant: photo view unaudited.*

## Out of scope

Building the payslip, cash advance and ID-card prints; signature history screen; staff self-service.
