# T-441: One photo-upload control with progress and preview

**Status:** 2026-10-25: COMPLETE. S1-S7 merged (#36, #39, #43, #52) and live. S8 (drag-drop, pan-zoom) recorded from Ian, not built.
**Ruling:** bible row 364 (Ian, 2026-10-17). Also row 353 (personal data strictly guarded; signatures strictest), row 171 /
§1.2c (one family of patterns), row 289 (an add form ends in Save), T-296 (1 MB photo cap, browser compression), T-141
(file broker), T-369 S2 (`/files/[fileId]`), T-434 (staff photo + signature), T-436 (leave certificates).
**Model:** Sonnet lanes, tester first then builder, Sonnet auditor. S2 is sweep-shaped (row 298, Workflow pre-approved).
Amendments in plan mode (Opus).
**Migration:** none. App + one domain function + one route.

## 1. What Ian asked for

Every photo upload looks and behaves the same. Empty: a rounded square (a circle for a person's photo) on gray with an
upload icon. Uploading: the shape fills like water, showing REAL progress. Done: the picture sits inside the shape.
Click it: the full-size picture opens. The person is told what is happening at every step: picked, shrinking, uploading
N%, done, failed (with Retry). Guarded files keep their own read rules; the full-size view never uses a public URL.

## 2. Inventory - every file upload in the four apps (grep: `type="file"`, `accept=`, `PhotoInput`, `SignaturePad`,
`FILE_PURPOSES`, `PURPOSE_LIMITS`, `uploadBytes`)

| # | Screen | Purpose | Image/PDF | Guarded read? | Current UX |
|---|---|---|---|---|---|
| 1 | `/ap` log invoice (`ap/page.tsx:198`) | `receipt_photo` | image + PDF | standard (`/files`, capability+store) | `PhotoInput`: bare file input, one text line ("Compressed X -> Y"), no preview |
| 2 | `/customers/[id]` record payment (`AutoAllocateCollectionForm.tsx:307`) | `receipt_photo` (not `ar_collection_proof`, see §8 F2) | image only (`accept="image/*"`) | standard | `PhotoInput`, same |
| 3 | `/inventory/deliveries` new (`NewDeliveryForm.tsx:157`), required | `receipt_photo` | image + PDF | standard | `PhotoInput`, same |
| 4 | `/trade/orders/[id]` pay-now proof (`trade/orders/[id]/page.tsx:154`) | `receipt_photo` | image + PDF (default accept) | standard | `PhotoInput`, same |
| 5 | `/staff/[employmentId]` photo (`page.tsx:284`), `capture="user"` | `staff_photo` | image | personal data (row 353); `canViewPhoto` | `PhotoInput` + "View photo" link that navigates away |
| 6 | `/attendance/leave` certificate (`leave/page.tsx:433`) | `leave_document` | image | ⛔ GUARDED: own rule, 60 s link, every view/refusal audited | `PhotoInput` + "View certificate" button -> server action redirects to the signed URL |
| 7 | `/staff/[employmentId]` signature (`SignaturePad.tsx`) | `staff_signature` | drawn PNG, not picked | ⛔ STRICTEST: payroll/admin only, 60 s link, audited, never in lists/cards | canvas + Save; "View signature" -> server action redirect; "Saving..." text only |
| 8 | POS `/account` avatar (`apps/pos/src/app/account/page.tsx:192`) | Firebase `users/{uid}/avatar.jpg` | image | ⚠️ public `getDownloadURL` (§8 F3) | hidden input, spinner, toast |
| 9 | POS QR payment-proof capture (`QrDisplayModal.tsx:198`) | Firebase proof path | image, `capture="environment"` | per POS lifecycle rules | hidden input, "capturing" flag |
| - | POS QR scanner photo fallback (`QrScanner.tsx:234`) | none: decoded locally, never uploaded | image | n/a | NOT an upload; stays as is |
| - | Purposes with NO screen yet: `ar_collection_proof`, `memo_document` (PDF), `wastage_dispute`, `onboarding_document` (PDF) | - | - | - | must use the control when built (S7 guard) |
| - | Viewer-only surfaces: `/ap/invoices/[id]:194`, `/customers/[id]:439`, `/inventory/deliveries/[id]:94`, `/staff` list avatars (`StaffViews.tsx:71`) | - | - | standard | "View photo" text link opening a new tab |

CUSTOMER and Website: no file inputs. **Total: 7 ERP upload surfaces (6 `PhotoInput` + 1 `SignaturePad`), 2 POS uploads,
4 dormant purposes, 4 viewer surfaces.**

## 3. How uploads work today, and why progress cannot be real as-is

- Each form posts to a **server action**. The action reads `formData.get(name)` as a `File`, calls `uploadFile()`
  (T-141: purpose limits, capability gate, 1 MB image ceiling, EXIF/metadata strip, store-derived path, `stored_files`
  row) and the record insert **in one transaction**. `PhotoInput` compresses in the browser first (T-296, target 950 KB)
  and swaps the compressed file onto the input via `DataTransfer`. `bodySizeLimit: '26mb'` (`next.config`).
- A server action is sent by React with `fetch()`. **`fetch` gives no upload-progress events**, so a server action
  cannot report bytes sent. Any percentage shown today would be invented.
- The proxy (`apps/erp/src/proxy.ts`) matches only `/clock`, so `proxyClientMaxBodySize` does not apply to `/files/*`.
- Reads: `GET /files/[fileId]` (T-369) mints a per-request signed link through `readFileUrl` and 302s, `no-store`, uniform
  404. `readFileUrl` already routes `leave_document` (60 s, audited) and `staff_signature` (`signatureUrl`, 60 s, audited)
  through their own rules. `canReadFiles` deliberately never says yes for those two.

### Design choice (Q1): upload first, then claim (rec)

1. On pick, the control compresses (existing T-296 code, unchanged rules), then sends the file with
   **`XMLHttpRequest`** (it has `upload.onprogress`) to a new route **`POST /files/upload`** (purpose, storeId, file).
   The route calls the SAME `uploadFile()` (every rule above stays the one place) and returns `{ fileId, contentType,
   byteSize }`. The file is unlinked, so the nightly orphan sweep removes it after 24 h if the form is abandoned.
2. The control puts `<name>FileId` in a hidden input and clears the file input (bytes are not sent twice).
3. On Save, the action calls a shared helper `resolveUploadedFile(tx, actor, formData, name, { purpose, storeId })`:
   with a `FileId` it calls new domain **`claimUpload(tx, actor, { fileId, purpose, storeId })`**, which refuses unless
   the row exists in the actor's org, `uploaded_by` = the actor, `purpose` and `store_id` match the record's, `linked_to`
   is null and it is under 24 h old, AND links it (`linked_to` = the new record's id) in ONE conditional
   `UPDATE ... WHERE linked_to IS NULL ... RETURNING`, called after the record insert in the same transaction (audit A1:
   atomic = race-safe, and fixes DEF-672 for every migrated screen). Without a `FileId`
   (JavaScript off) it falls back to `uploadFile` on the posted `File`, exactly as today.
- **Route safety** (route handlers do not get the server-action origin check): session via `currentSession()` -> 401 JSON
  when absent (NOT `requireActor()`, whose redirect an XHR silently follows to a 200 sign-in page; audit A3); refuse
  unless `Origin` is present and its host equals `x-forwarded-host ?? host` (Next's own server-action rule; 403); purpose
  must be in `CONTROL_PURPOSES` = `receipt_photo`, `staff_photo`, `leave_document` only (purposes with a live claiming
  screen; dormant ones join when their screen ships; `staff_signature` never; audit A4); size/type refused BEFORE the body
  is buffered (audit A5); refusals return the domain's `userMessage` as JSON with 4xx;
  faults log kind only (same rule as `/files/[fileId]`); `Cache-Control: private, no-store`.
- **Store:** pages that know the store pass `storeId`. `/ap` picks the store in the form: the control reads the named
  store field (`storeField="storeId"`), shows "Choose a store first" until it has one, and if the store changes after
  upload it clears the photo and says why. `claimUpload` enforces the match regardless.
- Compression has no byte progress: shown as a labelled phase ("Shrinking photo...") with a slow indeterminate ripple,
  never a fake number. Upload % is `loaded / total` from XHR; `lengthComputable === false` -> labelled indeterminate.
- **Fallback if Ian picks Q1 (b):** keep server actions; the fill is indeterminate and labelled "Uploading..." (no %);
  S1 drops the route and `claimUpload`. Everything else in this spec stands.

## 4. The control

`apps/erp/src/components/upload/` (new folder; `PhotoInput.tsx` and its tests are deleted at the end of S2-S5):

| File | Kind | Job |
|---|---|---|
| `upload-rules.ts` | pure | `acceptFor(purpose)` and `allowsPdf(purpose)` derived from `PURPOSE_LIMITS` (one source with the server; move `PURPOSE_LIMITS`/`MAX_IMAGE_BYTES` to a db-free leaf `packages/domain/src/files/limits.ts`, re-exported from `files/index.ts`, imported by the browser through the same leaf path T-440 uses); `shapeFor(purpose)` (`staff_photo` -> circle, else square); `GUARDED_PURPOSES` (`leave_document`, `staff_signature`) |
| `upload-state.ts` | pure | reducer: `empty -> selected -> compressing -> uploading{loaded,total} -> done{fileId, preview} / failed{reason, retryable}`; `existing{fileId, kind, viewable}` for a file already on the record; `percent()` clamps 0-100, rounds down, never 100 until the server answered |
| `upload-xhr.ts` | browser | `sendFile(file, purpose, storeId, onProgress, signal)` -> `{fileId}`; abort on unmount/Replace; maps 4xx JSON to the server's message, network error to "Upload interrupted - check the connection and press Retry" |
| `PhotoUpload.tsx` | `'use client'` | the control (below) |
| `WaterFill.tsx` | `'use client'` | the fill: an inline SVG wave in `var(--progress)` over `var(--progress-soft)`, height = percent; wave drifts sideways only under `motion-safe:`; under reduced motion it is a flat level with no animation |
| `Lightbox.tsx` | `'use client'` | native `<dialog>` + `showModal()` (focus trap, Esc, inert page come free); Close button focused on open; focus returns to the opener on close; image `max-h-[90vh] max-w-[95vw] object-contain`; PDF opens as a link "Open PDF" (no embedded viewer) |
| `FileTile.tsx` | server-safe | PDF/non-image: document icon + file name + size inside the same shape; never an `<img>` of a PDF |

**Props:** `name`, `purpose`, `label` (used for alt text and the button name, e.g. "Receipt photo"), `required?`,
`capture?`, `storeId?` / `storeField?`, `existing?: { fileId: string; kind: 'image' | 'pdf' }` (passed ONLY when the
loader decided the viewer may open it).

**States (each has an icon AND words, never colour alone; one `aria-live="polite"` line announces changes):**

| State | Shape shows | Words under it |
|---|---|---|
| empty | gray (`bg-neutral-100 dark:bg-neutral-800`, `border-field-border`) + upload icon | "Add photo" (or "Add photo or PDF") |
| selected / compressing | local preview dimmed + ripple | "Shrinking photo..." |
| uploading | local preview + water rising, `role="progressbar"` with `aria-valuenow` | "Uploading 42%" |
| done | preview (local object URL of what was just picked; revoked on replace/unmount) | "Uploaded - 812 KB" + Replace, Remove |
| failed | preview or icon + danger border + warning icon | server/network message + **Retry** (re-sends the same compressed file) + Choose another |
| existing | thumbnail from `/files/{id}` (non-guarded only) | "On file" + Replace |

- The whole shape is a `<button>` (Enter/Space opens the picker when empty, opens the lightbox when there is a picture).
  The file input stays in the DOM (`sr-only`, never `display:none`) so `required` and no-JS still work.
- While compressing or uploading the control sets `setCustomValidity('Wait for the photo to finish uploading')` so the
  form cannot submit half-done. A hidden input cannot satisfy `required`: once a `FileId` is held the control REMOVES
  `required` from the file input (restores it on Remove), and the action still refuses when neither is posted (audit A8).
- Size 96 px (`h-24 w-24`), `rounded-[10px]` or `rounded-full`; fits `FormGrid` and the 375 px phone width.
- **Guarded purposes:** no thumbnail is ever fetched for a stored file. The shape shows a document/lock icon and "On
  file"; the lightbox fetches `/files/{id}` only when opened (one open = one audited view, which is row 353's rule), the
  `<img>` is unmounted on close, nothing is kept in state or storage, and the URL is never the storage URL.
  A just-picked file previews from its local object URL (the person's own bytes, nothing fetched).
- No-JS: plain file input posts the file; the server path is unchanged (T-296's guarantee holds).

**Signature (Q4):** the pad stays a drawn canvas, not a file pick. It adopts the shell: saved state is a tile "Signature
on file" (never a thumbnail; row 353 forbids it in cards), "View" opens the same Lightbox on `/files/{signatureFileId}`
(passed only when `canViewSignature`), Save shows Saving -> Saved / Failed + Retry. No percentage: it is a small PNG
through its own audited server action, and the words say so.

## 5. Slices

Every slice: tester writes failing tests first, builder makes them pass, auditor reviews; local run = slice tests +
touched guards + `vitest --changed`; full suite in CI on the PR (row 291). No jsdom in this repo: behaviour is proven in
pure modules + integration tests + the §6 smoke, and wiring by source-reading tests (same split as `photo-compression.ts`).

### S1 - control, lightbox, progress plumbing, `/ap` pilot
**Tester:** `apps/erp/tests/t441-s1-upload-state.test.ts`, `apps/erp/tests/t441-s1-upload-rules.test.ts`,
`packages/domain/tests/integration/t441-claim-upload.test.ts`, `apps/erp/tests/integration/t441-files-upload-route.test.ts`,
`apps/erp/tests/t441-s1-wiring.test.ts`.
**Builder:** `components/upload/*` (7 files), `packages/domain/src/files/limits.ts`, `files/index.ts` (`claimUpload`,
re-export), `packages/db/src/repo/files.ts` (`claimFile`, the conditional UPDATE; SQL lives only in repo/),
`packages/domain/package.json` (`"./files/limits"` export), `apps/erp/src/app/files/upload/route.ts`,
`apps/erp/src/lib/uploaded-file.ts`, `ap/page.tsx`, `ap/actions.ts`.
**Tests and the mutants they kill:**
- state: `percent` returns 100 before the server reply (M1); uploading -> done without a `fileId` (M2); failed loses the
  file so Retry cannot resend (M3); Replace does not abort the in-flight upload (M4).
- rules: `acceptFor` hard-coded instead of read from `PURPOSE_LIMITS` (M5: a test adds a type to a copy and expects it);
  `staff_photo` square (M6); `leave_document` missing from `GUARDED_PURPOSES` (M7).
- claimUpload: another person's file accepted (M8); wrong purpose (M9); wrong store (M10); already linked (M11); older
  than 24 h (M12); other org's id (M13: refused as not found, same message as a missing id).
- route: missing/foreign `Origin` accepted (M14); `staff_signature` accepted (M15); capability not held -> 200 (M16);
  over 1 MB image -> 200 (M17); response or log carries a path or signed URL (M18); missing `no-store` (M19).
- wiring: `/ap` action ignores `receiptPhotoFileId` (M20); no-JS `File` fallback removed (M21); Lightbox `src` built from
  anything but `/files/` (M22); guarded purpose renders a thumbnail `<img>` for a stored file (M23).
- audit additions: two concurrent claims of one id both succeed (M24, two transactions, second must be refused);
  claim leaves `linked_to` null (M25); claim of an id the sweep already deleted is not refused (M26); route with no
  session answers 3xx/200 instead of 401 JSON (M27); `memo_document`/`onboarding_document` accepted (M28);
  Content-Length over the purpose cap read before refusal / missing Content-Length accepted (M29); Lightbox `src`
  identical on a second open, so the browser image cache skips the audited GET (M30); no-JS `File` path saved but not
  linked (M31).

### S2 - the other receipt-photo callers (sweep, parallel-safe)
Customers payment, new delivery, trade pay-now. Each: swap `PhotoInput` for `PhotoUpload`, action uses
`resolveUploadedFile`. **Tester:** `apps/erp/tests/t441-s2-receipt-callers.test.ts` (per caller: control present, action
reads `<name>FileId`, fallback kept). **Builder:** `AutoAllocateCollectionForm.tsx`, `customers/actions.ts`,
`NewDeliveryForm.tsx`, `inventory/deliveries/actions.ts`, `trade/orders/[id]/page.tsx`, `trade/orders/actions.ts`.

S2 execution clarification (21 October): A5 in T-442 requires the trade proof to link to the
collection, not the order. Extend scope to `packages/domain/src/trade/index.ts` solely to forward
the existing `recordChargeWithCollection.collectionId` through `DispatchResult` (null for other
dispatches), and to real-PostgreSQL S2 action tests plus the T-442 census tests and review report.
The channel-settlement TODO in T-442 is outside the three S2 receipt callers; retain it visibly
pending a separately scoped writer change. No production backfill is authorized.
Verification: seven new wiring checks failed before implementation; all eight now pass.
Real PostgreSQL action coverage proves both preuploaded-id and native File saves for each of the
three callers, exact collection/delivery ownership and empty unlinked/problem censuses. Three
foreign-uploader refusals pin the exact sentence and unchanged documents, ledger, layers,
movements, orders and file rows. Existing pay-now and dispatch action checks also pass.
Local total: 321 unit/guard checks across 12 files; 61 PostgreSQL checks across five files,
one channel-certificate TODO retained. Typecheck and production build passed with no local
server for this checkout. No running-app approval is claimed; browser policy remains blocked.
Postcommit combined run: 320 passed, one server-module import exceeded five seconds (DEF-722,
logged in the register as supporting audit scope). Earlier run passed; serial repeat and fresh
CI remain required. No timeout, assertion or guard allowance was changed.

### S3 - staff photo (circle) - ⛔ runs BEFORE S5, never alongside it (both edit `staff-media.ts`, `staff/actions.ts`, `staff/[employmentId]/page.tsx`)
`setStaffPhoto` accepts `{ fileId } | { contentType, bytes }`; page passes `existing` only when `canViewPhoto`.
**Tester:** `packages/domain/tests/integration/t441-s3-staff-photo-claim.test.ts` (claim path links to the employment;
another store's file refused; the claim path keeps `setStaffPhoto`'s self-refusal: an `enrol_staff` holder cannot claim a
photo onto their OWN employment, M32), `apps/erp/tests/t441-s3-staff-photo-wiring.test.ts` (circle, `capture="user"`, no
`existing` for a viewer without rights - row 353 test). **Builder:** `people/staff-media.ts`, `staff/actions.ts`,
`staff/[employmentId]/page.tsx`.

### S4 - leave certificate (guarded)
`attachLeaveDocument` accepts a `fileId`. Loader passes `proofFileId` only when `decideLeaveDocumentRead` allows (decide
only, no audit row at load). "View certificate" becomes the Lightbox; the server-action redirect is removed.
**Tester:** `packages/domain/tests/integration/t441-s4-leave-claim.test.ts` (claim refused on cancelled/rejected; store
mismatch), `apps/erp/tests/integration/t441-s4-leave-view.test.ts` (unauthorised viewer: no fileId in the page data, no
View; authorised: each `/files/{id}` GET writes exactly one `leave_document.viewed`; a refused GET writes
`view_refused`). **Builder:** `leave/documents.ts`, `attendance/leave/actions.ts`, `attendance/leave/page.tsx`, loader.

### S5 - signature shell
`staffMediaView` exposes `signatureFileId` only when `canViewSignature`. **Tester:**
`apps/erp/tests/t441-s5-signature-shell.test.ts` (no fileId without rights; no `<img>` of the signature outside the
Lightbox; Save states present) + extend `t434-staff-signature-surfaces.test.ts`. **Builder:** `SignaturePad.tsx`,
`people/staff-media.ts`, `staff/[employmentId]/page.tsx`, `staff/actions.ts` (view action removed).

### S6 - viewer surfaces (Q2)
A read-only `PhotoThumb` (same shape + Lightbox, `existing` only) replaces the four "View photo" links. **Tester:**
`apps/erp/tests/t441-s6-viewers.test.ts`. **Builder:** `ap/invoices/[id]/page.tsx`, `customers/[customerId]/page.tsx`,
`inventory/deliveries/[id]/page.tsx`, `staff/StaffViews.tsx`.

### S7 - guard (last)
`apps/erp/tests/t441-s7-upload-guard.test.ts`: fails if `type="file"` appears anywhere under `apps/erp/src` outside
`components/upload/`; if `PhotoInput` is imported anywhere; if `<img` with a `/files/` src appears outside
`components/upload/`; if a server action reads `formData.get(...)` as a `File` without `resolveUploadedFile`. Each check
proven red on a planted file before green. Deletes `PhotoInput.tsx`; `photo-compression.ts` moves into `upload/`.

## 6. Smoke (§9.4, browser, port 9008, `docs/SMOKETEST.md`)

On `/ap` (S1), `/staff/[id]` (S3), `/attendance/leave` (S4), light AND dark, desktop AND 375 px: screenshots of empty,
uploading (throttle network to Slow 3G so the fill is visible mid-way), done, lightbox open, failed (block
`/files/upload` in devtools) then Retry succeeding. Keyboard-only pass: Tab to the shape, Enter picks, Enter opens the
lightbox, Esc closes, focus is back on the shape. Reduced-motion emulated: no wave movement, % still shown. Signed in
as a role without rights on `/attendance/leave`: no View, network shows no `/files/` request. Confirm in the DB that a
saved record's file is linked and an abandoned upload is unlinked.

## 7. Out of scope

POS uploads (rows 8-9; Q3). Changing T-296's compression rules or the 1 MB cap. Image cropping/rotation. Multiple files
per field. A PDF viewer inside the lightbox. Screens for the four dormant purposes. Thumbnails generated server-side.

## 8. Findings while mapping (for the orchestrator)

- **F1** `receipt_photo` uploads from rows 1-4 are never `linkFile`d; only the `restrict` FK from the invoice/collection/
  delivery row stops the nightly 24 h orphan sweep deleting them (the sweep's delete fails on them every night). Verify;
  if confirmed, file a DEF. Recommended fix inside S1/S2: `resolveUploadedFile` links to the new record's id.
- **F2** Customer payments store proof as `receipt_photo`, not `ar_collection_proof` (dormant). Note only.
- **F3** POS avatar stores a permanent public `getDownloadURL` for a person's photo, against row 353's short-lived-link
  rule. For the POS follow-up.

## 9. Questions for Ian (plain words; recommended option marked)

- **Q1 How real is the progress?** (a, rec) The photo starts uploading the moment it is picked, through a small new
  upload address, so the bar shows true percent; Save then attaches it. A picked-but-never-saved photo is deleted
  overnight. (b) Keep today's path; the fill moves but says "Uploading..." with no percent, because the browser cannot
  measure it. Rec (a): it is what you asked for and the checks stay in one place.
- **Q2 Also use the new look where photos are only VIEWED** (invoice, payment, delivery, staff list)? (a, rec) Yes,
  same shape and full-size view everywhere; (b) uploads only. Rec (a): one family.
- **Q3 POS** (profile photo, QR payment proof)? (a, rec) A separate follow-up task, because POS stores files a
  different way and has its own screen kit; (b) include now. Rec (a).
- **Q4 Signature** (a, rec) keep drawing it, show "Signature on file" with a View button (each view still recorded),
  never a small picture; (b) show a small picture. Rec (a): row 353 bars signatures from cards.
- **Q5 When the picked photo is a PDF**, show a document tile with name and size, and "Open PDF" in the full-size view.
  (a, rec) yes; (b) refuse PDFs everywhere. Rec (a): suppliers send PDFs.

## Orchestrator rulings 2026-10-17

- **Q1 = a** (real percent via upload-on-pick to `POST /files/upload` + `claimUpload()` on Save; Ian asked for a progress animation that responds to the user, so it must be real). **Q2 = a**, **Q3 = a** (POS v2 follow-up task), **Q4 = a**, **Q5 = a**.
- **F1** logged as DEF-672, **F3** as DEF-673 (DEFECTS-REGISTER section E). F2 noted only.
- **Status:** spec written; Opus audit next.

## Audit 2026-10-17 (Opus spec auditor, against main `fead2ea`)

Verdict: **sound after the changes below; S1 may start.** Rulings Q1-Q5 untouched.

- **A1 Claim links, atomically (§3 step 3, M24-M26).** The spec had `claimUpload` NOT link. That left two holes: two
  concurrent Saves (double-submit) could both pass "`linked_to` is null" and share one file, and every claimed receipt
  stayed an orphan candidate the sweep fails on nightly (DEF-672). Now: `claimUpload(tx, actor, { fileId, purpose,
  storeId, linkTo })` = repo `claimFile`: `UPDATE stored_files SET linked_to = $linkTo WHERE id = $id AND org_id = $org
  AND uploaded_by = $actor AND purpose = $p AND store_id IS NOT DISTINCT FROM $store AND linked_to IS NULL AND
  uploaded_at > now() - interval '24 hours' RETURNING id`; zero rows -> ONE refusal ("That photo is no longer available -
  pick it again"), same sentence for missing / foreign / expired / taken, so a probe learns nothing. Uses the DB clock
  (same clock as `listOrphans`). Race with the sweep: `deleteFile` is `WHERE linked_to IS NULL` and the row lock
  serialises them, so whichever commits first wins and the loser matches zero rows (no file deleted under a saved record,
  no record pointing at deleted bytes). Do NOT reuse `filesRepo.linkFile`: it has no `linked_to IS NULL` guard.
- **A2 One link step for both paths.** `resolveUploadedFile` returns a `fileId` for the JS path (posted `FileId`) AND the
  no-JS path (fresh `uploadFile` by the same actor); after inserting the record the action calls `claimUpload(...,
  linkTo: recordId)` for either. So the no-JS path links too (M31) and DEF-672 closes per migrated screen.
- **A3 Route auth must not redirect.** `requireActor()` -> `redirect('/sign-in')`; XHR follows it and sees a 200 HTML page.
  Use `currentSession()`, 401 JSON when absent; `upload-xhr.ts` treats non-JSON, `xhr.responseURL` not ending in
  `/files/upload`, or 401 as "Your session ended - sign in again, then Retry" (M27). Also `export const runtime =
  'nodejs'` and `dynamic = 'force-dynamic'`. Origin: present AND host equals `x-forwarded-host ?? host` (the droplet
  sits behind a proxy; comparing to `request.url` would refuse every real request). Session cookie is `SameSite=Lax`, which
  already blocks a cross-site POST carrying it; the Origin check is the second layer.
- **A4 `CONTROL_PURPOSES` narrowed** to purposes with a screen that claims them (`receipt_photo`, `staff_photo`,
  `leave_document`). The dormant ones (up to 25 MB PDFs) would otherwise be an unclaimable-upload surface with no use
  (M28). Add each when its screen ships.
- **A5 Size before buffering.** `request.formData()` buffers the whole body with no route-level limit (the 26 MB
  `bodySizeLimit` covers server actions only). Route contract: `POST /files/upload?purpose=..&storeId=..` (ids only, no
  personal data), body = the raw file, `Content-Type` = the file's type. Refuse 400 on unknown purpose / non-uuid store,
  415 on a type not in `PURPOSE_LIMITS`, 411 without `Content-Length`, 413 when it exceeds the purpose cap (and
  `MAX_IMAGE_BYTES` for images) - all BEFORE reading the body; then re-check the real byte length and call
  `uploadFile` (which re-checks everything). `AuthorizationError` -> 403 generic sentence; any other throw -> 500 generic,
  kind-only log (`uploadFile`'s plain `Error` texts are not user messages and must not be echoed) (M29).
- **A6 Lightbox = one audited view per open (M30).** `/files/{id}` is `no-store`, but a browser can reuse a decoded image
  for an identical `<img src>` in the same document without re-requesting it, so a second open of a leave certificate or
  signature would show the picture with NO audit row. Lightbox `src` = `/files/{id}?open={counter}` (fresh per open; the
  route ignores the query); `<img>` mounted only while open. Storage objects are already `private, max-age=0, no-store`
  (`packages/storage-firebase/src/index.ts:197`).
- **A7 Leaf boundary.** `tests/unit/client-bundle-boundary.test.ts` walks type-only imports too, so `files/limits.ts`
  must NOT import `FilePurpose` from `@shareat/db`. It declares its own purpose key list; `files/index.ts` holds a
  compile-time check that its keys equal `FILE_PURPOSES` (a drift fails `typecheck`). Export via `package.json`
  `"./files/limits"` (pattern: `./item-code`).
- **A8 `required`** fixed in §4 (hidden inputs cannot satisfy it).
- **A9 Accessibility.** Compressing ripple is `motion-safe:` like the wave. The `aria-live` line announces phase changes
  and upload progress at 25 % steps only (a live region per percent floods a screen reader); `role="progressbar"`
  carries every value.
- **A10 Slices.** S3 and S5 edit the same three files: sequential (S3 then S5), never parallel. S5 deliberately reverses
  `staff-media.ts:12` ("Nothing here returns a signature file id"): update that comment and `t434-staff-signature-surfaces`
  in S5, and keep the id out of every list/card loader (row 353). Path check: every builder/test path named exists on main
  or is a new file in an existing folder.

### Open items for the orchestrator (not folded in: new rules, not clear-cut)

1. **DEF-672 backfill.** A2 links new saves only. Rows already saved stay unlinked and fail the sweep nightly until a
   one-off backfill sets `linked_to` from `supplier_invoices` / collections / deliveries / trade-order proof columns
   ("Migration: none" here, so it needs its own data-migration task) plus the census the DEF names.
2. **Unclaimed-upload flood.** Any capability holder can now park up to 24 h of unclaimed files. Suggest a cap (e.g. 429
   when the actor has 30+ unclaimed uploads under 24 h). Needs Ian/orchestrator.
3. **Content sniffing (pre-existing, both paths).** `uploadFile` trusts the declared type: a non-JPEG labelled
   `image/jpeg` is stored unstripped, and PNG/WebP metadata is never stripped (`core/exif.ts:119`). Recommend a DEF:
   magic-byte check in `uploadFile` (JPEG FFD8FF, PNG 89504E47, WebP RIFF..WEBP, PDF %PDF-).
4. Row 364 calls staff photos "guarded"; this spec keeps them non-guarded (thumbnail allowed, gated by `canViewPhoto` and
   `/files` `enrol_staff`). Consistent with today's staff-list avatars; confirm.

## Orchestrator rulings on the audit's open items (2026-10-17)

- **Unclaimed-upload cap:** the route refuses a new upload when the person already holds **30** unclaimed uploads (< 24 h); a test kills 'cap removed'.
- **Content check in S1:** the new route verifies the file's magic bytes match the declared image type (JPEG/PNG/WebP; PDF where allowed) before storage; mismatch = 415. A test kills 'declared type trusted'.
- **PNG/WebP metadata not stripped (pre-existing):** logged as DEF-674; not in T-441.
- **DEF-672 backfill** (link receipt photos already saved): its own task **T-442** (reserved).
- **Staff photos:** thumbnails allowed, gated by `canViewPhoto` (T-434's rule); row 364's "guarded" means its read rule is kept, not that it gets no thumbnail. Signatures and leave certificates: no thumbnail.
- **Status:** AUDITED 2026-10-17; S1 buildable.

## Note for S2 from the T-442 audit (2026-10-17)

- Trade pay-now proof photos must be claimed with `linkTo` = the **ar_collections** id, not the trade order id; otherwise T-442's `--check` reports every one as mismatched forever.

## Smoke fix L1 — Lightbox lets a large image run past the modal (2026-10-17, from T-440 S9)
**Found:** an 1800×1300 image at a 1280×900 window runs past the bottom of the dialog. **Cause** (`Lightbox.tsx:68,84`): the
dialog caps itself at `max-h-[95vh]`, but inside it the Close row (~40 px), the 12 px gap and `p-3` padding sit ON TOP of an
image allowed `max-h-[90vh]`: 810 + ~76 > 855 px, and the dialog has no overflow rule, so the picture spills out.
**Fix (Builder: `apps/erp/src/components/upload/Lightbox.tsx` only):**
- Dialog: `open:flex flex-col max-h-[95dvh] max-w-[95vw] overflow-hidden` (keep the rest). ⛔ Use `open:flex`, never bare
  `flex`: a class `display` overrides the browser's `dialog:not([open]) { display: none }`, so a closed lightbox would show.
- Body wrapper: `flex min-h-0 flex-1 flex-col gap-3`; Close row `shrink-0`. Image box: `min-h-0 flex-1 overflow-auto` (the scroll fallback: on a tiny or zoomed viewport the picture scrolls INSIDE
  the dialog instead of escaping it). Image: `block mx-auto h-auto w-auto max-w-full max-h-[calc(95dvh-5.5rem)] object-contain`
  (whole picture, aspect kept, never cropped, never upscaled).
- PDF branch unchanged.
**Test** (node, added to `apps/erp/tests/t441-s1-wiring.test.ts`): reads the classes from the source and kills M-L1 bare
`flex` on the dialog (closed dialog visible); M-L2 image back to a viewport-only cap (`90vh`, no `max-h-[calc(`); M-L3
`overflow-hidden` dropped from the dialog; M-L4 `overflow-auto` dropped from the image box; M-L5 `object-contain` dropped.
**Smoke** (port 9008, `/ap` invoice receipt photo, 1800×1300 fixture; also a 600×3000 tall one): at 1280×900 and 375×812,
`javascript_tool` reads `getBoundingClientRect()`: image bottom <= dialog bottom <= `innerHeight`, image right <= dialog right,
Close visible without scrolling; the whole picture shows (natural aspect ratio == rendered ratio ± 1%); screenshots attached.

## S8 - Ian's 22 Oct additions (relayed by the T-448 UI session; owned here because components/upload/* is T-441's)

Ian, 2026-10-22: every photo upload is the rounded square box with an upload icon and no separate upload button (S1
already); **drag-and-drop** onto every box; a **finish animation** when the upload completes, then the preview shows in
the box at once; images open **in-app, never in a new tab**, in one shared viewer modal with **drag to pan and click to
zoom in/out**; app-wide. Spec in plan mode (Opus) after S3-S6 merge; the viewer adopts T-448's shared `Dialog` if it
has landed. Guarded purposes keep A6 (one audited GET per open; panning/zooming never refetches).
Also DEF-739: with JS on the picked file stays in the input and is re-posted on Save next to `<name>FileId` (ignored by
the server, extra payload); S7/S8 clears the input once a FileId is held, as §3 step 2 already says.
