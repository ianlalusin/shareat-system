# T-584 — Documents: templated HR documents (memo, COE, NTE, contract)

> Status: SPEC (BOSS, 2026-11-15). Ian's rulings 15 Nov (bible rows owed, see §9).
> Migration: **0259** (next free on the coordination board). Task number from the board.

## 1. Goal

Admins and store managers produce standard documents for an employee — a Certificate of Employment
(COE), a memo, a notice to explain (NTE), an employment contract — from templates, instead of
retyping Word files. Every issued document is numbered, kept, and reprintable. Signatures come from
the one signature each person already has on file (T-434), attached only when that person enters
their own PIN.

**v1 goal (§1.2d):** v1 has no document generator; memos are uploaded files
(`ERP-rebuild` `GET /api/memos/document`). Nothing to port; this is new.

## 2. Rulings this spec rests on (Ian, 15 Nov)

| # | Ruling |
|---|---|
| R1 | Build the smaller first version: template library, fill from the employee record, edit, issue with a number, print / save as PDF from the browser. No server-side PDF. |
| R2 | Admins write templates. Admins **and** store managers issue documents; a manager only for staff of a store in their scope. |
| R3 | Each person has **one** saved signature, saved and updated in **one place** (the staff page, T-434 `persons.signature_file_id`), and it is reused across the app. |
| R4 | A signature is attached to a document only when **its owner enters their own staff PIN**. This applies to the issuer and to the employee. A saved signature is never stamped without the owner's PIN. |
| R5 | Template wording comes from Ian's current files; admins enter it through the template screen. Nothing is seeded. |
| R6 | A waiver/quitclaim template is **not** offered until a lawyer has reviewed its wording (Ian's call when it is ready). |
| R7 | **Every version of an issued document is kept and maintained. Any change to an issued document needs every signature again.** (Ian, 15 Nov.) A revision is a new version of the same document (same number, `v2`, `v3`…); signatures belong to one version; a new version starts unsigned. |

## 3. Scope

**In**
1. **Templates** (`/documents/templates`): create, edit, retire. Fields: name, kind
   (`coe | memo | nte | contract | other`), body, which signature slots it needs
   (`issuer`, `employee`, or both). Every save creates a new **version**; old versions stay readable and are never edited.
2. **Issue** (`/documents/new`): pick a template (its latest version) and an employee (optional
   for a general memo). The body is filled with merge fields (§5). The issuer may edit the filled
   text, then **Issue**. The issued document stores its frozen final text, the template version id,
   the issuer, the time, the employee and store, and a number `DOC-YYYY-NNNN` (per org, per year;
   unique, gaps allowed).
3. **Sign** (on the issued document): one button per signature slot still unsigned. The owner
   (the issuer, or the employee handed the device) enters **their own** Employee ID + PIN. On success
   the slot records the person, the time, and their current `signature_file_id`. That file is
   **copied by reference at signing time**, so a later signature update does not change past
   documents. No saved signature means a refusal in plain words: "Save a signature on the staff page first".
4. **Register** (`/documents`): issued documents, newest first, filter by store / employee /
   kind; the staff page shows that employee's documents. Reprint any time.
5. **Print**: an A4 print page with org legal name, TIN, the store's address and branch code as the
   letterhead (all from the database), the document number, the body, and the signature slots
   (signed image, or a blank line with the name if unsigned). The same `@media print` / `@page A4`
   approach as `apps/erp/src/app/trade/orders/[id]/print/page.tsx`. "Save as PDF" is the browser's.
6. **Revise (R7)**: an issued, non-void document can be revised by a holder of `issue_documents` for its store.
   This needs a reason. The revision creates **version N+1** with the new text, the reviser and the time, and
   **all signature slots start empty again**. Earlier versions, and their signatures, stay readable and printable as they were.
   The register and print show the current version, labelled "Version N of DOC-YYYY-NNNN". A "History" list shows every version: who, when, why, and its signatures. A version's text is never edited in place.
7. **Void**: an issued document can be voided with a reason (admin, or the issuing store's manager).
   It stays in the register marked VOID, and its print shows VOID. Never deleted.

**Out (deliberately)**
- Server-side PDF and any headless browser: the 4 GB droplet must not render (never build or render there).
- Drawing a fresh signature per document: R3 and R4 replace it.
- Salary on a COE from data: pay rates (T-189) are not built. The issuer may type it into the editable text.
- Waiver/quitclaim: R6.
- Staff self-service requests, e-mailing documents, uploading signed scans, Word import: later, if asked.
- Rich-text HTML templates: see §6. Plain text with a tiny markup only.

## 4. Data (migration 0259, hand-authored per ADR-012)

- `document_templates` (org-scoped): id, org_id, name, kind, retired_at, created_by, created_at.
- `document_template_versions` (append-only): id, org_id, template_id, version_no, body,
  signature_slots (subset of `issuer`, `employee`), created_by, created_at. Unique (template_id, version_no).
- `issued_documents`: id, org_id, store_id (nullable for an org-wide memo), number (unique per org),
  template_version_id, employment_id (nullable), issued_by, issued_at, voided_at, voided_by,
  void_reason. Only the void columns may change after insert (trigger).
- `issued_document_versions` (append-only, trigger refuses UPDATE/DELETE): id, org_id,
  issued_document_id, version_no, body, reason (null for v1), created_by, created_at. Unique
  (issued_document_id, version_no). The current version is the highest version_no.
- `issued_document_signatures` (append-only): id, org_id, issued_document_version_id, slot,
  person_id, signature_file_id, signed_at. Unique (issued_document_version_id, slot). A signature
  belongs to ONE version, so a new version is unsigned by construction (R7). Signing is refused on any version that is not the current one.
- Same-org foreign keys on every reference (the house pattern). RLS forced. Classify all four
  tables in `cutover/classification.ts` and the RLS registry. Journal: idx above main's last, `when` above main's last (DEF-039).

## 5. Merge fields

A fixed whitelist, resolved on the server at issue time. An unknown `{{field}}` is refused at
template save, with the bad name shown.

`{{employee.full_name}} {{employee.staff_code}} {{employee.position}} {{employee.status}}
{{employee.started_on}} {{employee.ended_on}} {{store.name}} {{store.address}}
{{store.tin_branch_code}} {{org.legal_name}} {{org.trading_name}} {{org.tin}} {{issuer.full_name}}
{{issuer.position}} {{today}}`

Dates are printed in long form in Manila time ("15 November 2026"). A missing value renders as a visible
`[missing: employee.ended_on]` in the editor and **blocks Issue** until the issuer edits it out or
fills it in. Builder: confirm each field's source (persons, employment_positions, stores) and drop
any that does not exist. Report what was dropped; don't invent columns.

## 6. Rendering safety

The body is **plain text** with a minimal markup: blank line = paragraph, `# ` = heading,
`**bold**`. It is rendered by React as text nodes. No `dangerouslySetInnerHTML`, no HTML stored or
rendered, so there is no XSS surface. A test proves `<script>` in a template body prints as literal text.

## 7. Capabilities (CAPABILITY-MATRIX; each ✅ needs a test proving the ✗)

| Capability | Scope | Holders |
|---|---|---|
| `manage_document_templates` | org | super_admin, admin |
| `issue_documents` | store | super_admin, admin, manager |
| `view_documents` | store | super_admin, admin, manager |

Signing needs no capability: it needs the signer's own valid PIN, and the signer must be the
issuer (issuer slot) or the document's employee (employee slot). Use `verifyPin` / the staff PIN
lookup already used by the POS sign-in (T-464). Reuse its lockout and attempt cap; don't write a new
PIN path. A wrong PIN is audited and refused with one generic message. The signature image is shown
only on the issued document's own page and print, to viewers holding `view_documents` for that store.
That is an explicit, narrow exception to `view_staff_signature` (bible row 353): the person's own PIN put it there.

Every write is audited (template version saved, document issued, signed, voided, PIN refused).
Add the new actions to the audit catalogue.

## 8. Tests (tester writes them first, red then green)

1. A manager issues for own-store staff ✅; for another store's staff ✗.
2. Staff with no capability is refused `/documents`, `/documents/new` and the print page by URL (not only a hidden link).
3. Template save refuses an unknown merge field. Issue is blocked while any `[missing: …]` remains.
4. The issued body cannot be updated (DB trigger), only voided. A voided print shows VOID.
5. Sign: the right person and right PIN ✅. Another person's PIN for the employee slot ✗. Wrong PIN ✗ (audited, capped). No saved signature ✗ (plain message).
6. A later signature change does not alter an already-signed document.
7. Template edit makes v2; a document issued from v1 still shows v1's text and id.
8. The `<script>` body prints as text.
9. Numbering is unique per org per year under two concurrent issues.
10. R7: revising a signed v1 creates v2 with every slot empty. v1 still prints with its signatures. Signing v1 after v2 exists ✗. Updating or deleting a version row ✗ (trigger). Revise on a voided document ✗. Revise without a reason ✗.
Each guard gets a mutant. Run the guards that bit recent PRs:
- t343 throw ratchet;
- t384 G7/G8 (EditableRecord, Save label);
- t389 G10 keep-typing on the template form;
- t440 live-checks;
- action-link-sweep;
- the classification and RLS registry guards.
The migration is gated on the FULL suite on a fresh DB.

## 9. Bible rows owed (wrap-up)

- Ian 15 Nov: the Documents page is built small (R1/R2/R5/R6).
- Ian 15 Nov: **every version of an issued document is kept; any change needs every signature again** (R7).
- Ian 15 Nov: **one signature per person, saved in one place, reused across the app, attached only with the owner's PIN** (R3/R4). This is app-wide: future signature uses (payslips, cash advance forms) follow the same rule.
