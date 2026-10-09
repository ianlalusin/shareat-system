# T-389: a refused save keeps what the user typed, on every saved-record form (DEF-617)

**Status:** S3 DONE 2026-10-10 (`a4d533f`, merged to main `c590727`; 9 forms; field-name pattern now allows a hyphen; baseline minus 8 pages; browser smoke on 9008 pending). Scope notes from the S3 audit: the ADD forms that share an action (budgets add-cap, recurring create, the channel payout panel) are outside the census and still lose typing on a refusal (S5 decides); the fixed-assets in-service confirm branch reopens with the user's own earlier values (cosmetic). S2 in a lane; S4 after T-390 S1 lands (shares cutover/actions.ts). | Earlier: S1 DONE 2026-10-10 (`e2b3a1e`, on main; browser smoke on 9008 passed: supplier, tender, invoice lines, store link, two-tab stale, one-minute expiry, dropped, second person sees nothing, 375 px). S2-S4 (29 forms in 21 pages, guard baseline `apps/erp/tests/typed-baseline.json`) and S5 next. Ian answered Q1 (a).
**Model:** Sonnet lanes, tester first, then builder (bible row 184). An amendment is written in plan mode (Opus).
**Migration:** none. This is app-layer only (flash cookie, one client component, the actions). The next free number
stays **0190**.
**Defect:** DEF-617 (🔸). Today it is fixed for POS-link tenders only (T-384 S1b). This task fixes it for every other
`EditableRecord` form, and moves tenders onto the same shared mechanism.
**Ruling behind it:** bible row 289 (a saved record opens locked behind Edit; one record open at a time; Cancel restores
the stored values; a stale-version save is refused). T-384 Amendment A6: after a **stale** refusal the record reopens
LOCKED with the stored values; after any **other** refusal it reopens in edit mode with what was typed. T-380 (bible:
no typed values in URLs): typed values ride only in the signed, httpOnly, one-minute flash cookie, never in the
address and never in a log. Ian, 2026-10-10 (via the orchestrator): fix it for every other form, without needing him.

## The defect in one paragraph
Every server action reports a refusal by `redirectWithFlash(...)`, so the page remounts. A saved record is drawn from
the database again, locked behind Edit, and what the user typed is lost. They must press Edit and type it all again,
often without seeing what was wrong with it. Tenders are fixed with five per-form keep keys
(`tenderId/Name/Kind/Account/Alias` in `apps/erp/src/lib/flash.ts` `KEEP_KEYS`), `initialMode="editing"` and
`storedValues` on `EditableRecord`, and per-field `defaultValue={typed?.x ?? stored.x}` in the page. Copying that to
33 forms would mean about 200 new keep keys and 33 hand-made pages. This task replaces it with one mechanism.

## Census (run 2026-10-10 at `6e744d4`; re-run at S1 start and record the diff)
`grep -rn "<EditableRecord" apps/erp/src/app` gives **33 instances in 24 page files**. Plus `items/ItemCodeField.tsx`,
a client field used inside one of them.

| Class | Count | What happens |
|---|---|---|
| **In scope: data entry behind Edit** | **33** | Wired to the mechanism. 4 in S1, 29 in the sweep |
| of which: has a record version (stale path) | 1 | Tender (`updateTenderAction`). No other record has a version (T-384 S3b, N6) |
| of which: two-step confirm forms | 2 | Store opening date (`setStoreOpeningDateAction`) and asset in-service (`setAssetInServiceAction`). Only the plain-error branch is wired. The confirm-checkpoint branch keeps its existing T-380 keep keys, unchanged |
| of which: multi-row or multi-value | 6 | Invoice lines (`line1..5_*`), sales-day platform sales (`channel_<id>`, `nosales_<id>`), staff positions (checkbox group `positionIds` + radio `primaryPositionId`), item org flags (checkboxes), store sellability (tri-selects), attendance (37 fields) |
| **Commands** | **0 inside `EditableRecord`** | By construction (row 289): a command keeps its verb and is never a locked record. The commands in `extra` (Retire, Clear) and beside it (Issue PIN, Void, Post, …) are **out of scope**. A refused command loses at most a reason box, and that is not DEF-617 |
| **Secret-bearing (credentials)** | **0 inside `EditableRecord`** | The four credential inputs in the app (`setup` PIN, the `sign-in` password and PIN, `staff/[employmentId]` Issue PIN, `name="pin"`) are not saved-record forms. They are out of scope. The helper's deny list (R4) makes sure they can never be echoed, even if someone wires them later |
| **Sensitive, excluded (conservative)** | 1 field | The supplier's `bankAccountNumber` (`ap/suppliers/[id]`). It is not echoed. See Q1 |
| **Exempt** | 0 expected | A lane that finds a real reason adds a `TYPED_EXEMPT` entry with the reason. The orchestrator approves it |

Per file (instances): admin/stores/[id] 3 · ap/invoices/[id] 1 · ap/suppliers/[id] 1 · budgets 1 · channel-settlements 1 ·
commissary/orders/[id] 2 · cutover/count 1 · expenses/recurring 1 · expenses/[id] 1 · fixed-assets/[id] 2 ·
inventory/counts/[id] 1 · inventory/locations 1 · inventory/low-stock 1 · items/[id] 4 · money-accounts 1 · remittance 1 ·
sales-days/[id] 1 · settings/attendance 1 · settings/expense-categories 2 · settings/organization 1 · settings/pos-link 2 ·
settings/sales-channels 1 · settings/wastage-monitor 1 · staff/[employmentId] 1.

**Non-goal N1: open add forms** (an add form is open and ends in Save) also lose their typing on a refusal. That is the
same mechanism with no record id, but it is a different defect and many more files. It is **not** in this task. The
mechanism is built so it can take add forms later (`record: ''`). The orchestrator may propose a DEF for it.

## Design

### Alternatives weighed (research-evaluate-propose, row 283)
- **Per-form keep keys (the tender way).** About 200 closed-set keys in one shared file, and every page hand-draws each
  field. Every sweep lane would collide on `flash.ts`. **Rejected.**
- **Client `sessionStorage`, stashed on submit and replayed when the page shows an error.** No size limit and no server
  change. But the typing sits in readable browser storage past the one minute on a shared till PC, any script on the
  page can read it, and the client has to guess whether this error belongs to that form. That breaks T-380's model.
  **Rejected.**
- **Chosen: one `typed` slot in the existing signed flash, plus a shared helper and an `EditableRecord` prop.** Same
  trust model as T-380 (signed, httpOnly, 60 s, bound to the one redirect by the token `f`). There is **one** server
  helper and **one** client behaviour. Per form you write three lines: a form definition, one call in the action's
  `catch`, and one prop on the page.

### R1. The `typed` slot in the flash (`apps/erp/src/lib/flash.ts`)
- `Flash` gains `typed?: TypedFlash`, where `TypedFlash = { form: string; record: string; fields: Record<string, string | string[]> }`.
  A single value is a string and a repeated name (a checkbox group) is an array. That keeps the cookie small.
- `FlashPayload` gains optional `t?: TypedFlash` and `td?: { form: string; record: string }` ("typed dropped"). `v`
  stays `1`. An old cookie without `t` decodes as before, and it lives at most 60 s anyway. `decodeFlash` validates the
  shape strictly: `form` must match `/^[a-z][a-zA-Z0-9.]{0,63}$/`, `record` must be `''` or a UUID or a short slug,
  every field name must match `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, and every value must be a string or an array of
  strings. Anything else drops `t` whole.
- **Budget.** Keep `MAX_COOKIE_BYTES = 3000` (a browser cookie is about 4 KB with its attributes). If the payload is
  over budget, drop `t` **whole** first (never shorten a value: a shortened amount would post a different figure), set
  `td`, and log `{ form, keys: <field NAMES> }` only. Only then drop `keep`, as today. A value is never logged (T-380 I5).
- `withFlash` returns the slot as `sp.typed` and `sp.typedDropped`, from the cookie only. `stripFlashKeys` also strips a
  URL `typed` or `typedDropped` (R9 of T-380), so a crafted link cannot fill a form.
- The five tender keys come out of `KEEP_KEYS` once tenders move onto `typed` (S1). The other keep keys (`reason`,
  `openingDate`, `inServiceOn`, `mode`, …) stay. Confirm checkpoints and add forms use them.

### R2. The shared helper (`apps/erp/src/lib/keep-typing.ts`, new, not `'use server'`)
```ts
export function defineTypedForm(def: { form: string; fields: ReadonlyArray<string | RegExp> }): TypedFormDef;
export function keepTyping(fd: FormData, def: TypedFormDef, record: string,
                           opts?: { stale?: boolean }): TypedFlash | undefined;
export function typedFor(sp: { typed?: TypedFlash; typedDropped?: {form: string; record: string} },
                         def: TypedFormDef, record: string): TypedView | null;
// TypedView = { kind: 'typed'; fields: Record<string, string | string[]> } | { kind: 'dropped' }
```
- `keepTyping` returns `undefined` when `opts.stale` is true, when `record` is blank on a record form, or when nothing
  allow-listed was submitted. Otherwise it keeps **only** allow-listed names (`fd.getAll(name)` for each). If the form
  sent the `__changed` list (R5), it keeps only the names that are allow-listed **and** in that list. It never trims
  and never logs.
- **Stale.** The action decides and passes `{ stale: true }`. For tenders that is today's test
  (`errorMessage(err) === STALE_SENTENCE`). A future versioned record does the same. The guard (G10e) requires the
  `stale` option on every action whose `EditableRecord` carries a `version` hidden input.
- `typedFor` returns a view only when `sp.typed.form === def.form && sp.typed.record === record`, or the `dropped`
  view when `typedDropped` matches. Otherwise it returns `null`. **This is how a flash meant for another record or
  form is ignored.** There are 20 tenders and 5 commissary lines on one page, and only the one whose Save was refused
  reopens. Another tab is already handled by T-380: each redirect writes a new cookie with a new `n`, so a different
  tab's `?f=` no longer matches and that tab shows nothing.
- **Form definitions live in the route's own non-`'use server'` module**, `<route>/typed-forms.ts` (new per route).
  A `'use server'` file can export only async functions. The page and the action both import the same definition, so
  the form key cannot drift. Key convention: `<area>.<form>`, for example `supplier.edit`, `tender.edit`,
  `invoice.lines`, `commissary.lineUpdate`.
- Call shape in every action's refusal branch (only there; the success redirect is unchanged):
  ```ts
  } catch (err) {
    return await redirectWithFlash(path, nav, { error: errorMessage(err), typed: keepTyping(fd, SUPPLIER_EDIT, supplierId) });
  }
  ```
  A guard clause that refuses before the `try` (for example `renameItemAction`'s super-admin refusal) wires the same
  call.

### R3. `EditableRecord` gains `typed` (`apps/erp/src/components/forms/EditableRecord.tsx`)
- New prop `typed?: TypedView | null` (optional in S1 and the sweep, **required** at S5). The page passes
  `typed={typedFor(sp, DEF, record.id)}`.
- **The page keeps drawing the STORED values as each field's `defaultValue`.** It never draws a typed value. So Cancel
  is still `form.reset()`, and `formIsDirty` still compares with the defaults. That retires `storedValues` and
  `restoreStored`. `initialMode` is kept for one release as an internal of `typed` and then removed (S5).
- With `typed.kind === 'typed'`: the reducer starts in `editing`. Before paint (`useLayoutEffect`) it applies the
  fields to the form's controls by name. A pure `planApply(controls, fields)` returns the assignments, so it is
  node-testable like the reducer. For each control:
  - text, textarea, date or number input: set the value through the native value setter, then dispatch bubbling
    `input` and `change` events, so a client field that listens (`ItemCodeField`, a select that shows or hides a row)
    sees it;
  - checkbox or radio: `checked = values.includes(el.value)`, for every control with that name (groups included);
  - select: select the option(s) whose value is in the values. **If no option matches** (the account was retired in
    the meantime), leave the stored selection and count it as not applied;
  - names not in `fields` keep the stored value. That is right: the user did not change them (R5).
  The record is then dirty, so the one-open-record registry (row 289) protects it from another Edit.
- With `typed.kind === 'dropped'`: the record stays **locked** and shows, in its existing `role="alert"` slot:
  *"What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again."*
- The page's error banner is unchanged. It still says why the save was refused.
- Numbers stay text as typed (`inputMode="decimal"` fields): `"1,0OO"` comes back exactly as `"1,0OO"`, next to the
  banner that quotes it. A `type="number"` or `type="date"` input cannot submit text a browser rejects, so nothing is
  lost there.

### R4. Never echoed: the deny list
- `keep-typing.ts` holds `NEVER_ECHO = /(^|_)(pin|newpin|password|passcode|secret|token|otp|apikey|api_key)$/i` and a
  closed `SENSITIVE` set, `{ 'bankAccountNumber' }` (Q1).
- `defineTypedForm` **throws** at module load if an allow-list entry (string) matches either. `keepTyping` also skips
  any name that matches, so a RegExp entry such as `/^line\d_.*/` cannot let one through.
- G10d (static): no field rendered `type="password"` may be named by any `defineTypedForm`.
- A refused form with an excluded field reopens with that field showing the **stored** value. The record's alert slot
  adds: *"The account number is not kept after a refused save. Check it before saving."* The text is per field label,
  from `def.notKeptHint`, which is optional and set by the lane for the supplier form.

### R5. Only what changed rides the cookie (`__changed`)
`runEditableAction` already receives the `FormData`. Before calling the action it appends `__changed`: a
comma-separated list of the names whose control differs from its default (the same test as `formIsDirty`; a checkbox
group counts as changed if any member changed). Most refusals then carry 1-3 fields, not 37, so the largest form
(attendance) stays far inside the budget. A no-JavaScript submit has no `__changed`, and the helper then keeps every
allow-listed name. Actions read fields by name, so the extra key is ignored. `__changed` is never stored or logged
as data.

### R6. What does not change
- The success path, every banner, every nav key, the URL (still only nav keys plus `f`), and the one-minute life:
  a reload or Back within 60 s reopens the record with the typing again (T-380 R3, by design).
- Tender stale behaviour (A6): a stale refusal reopens locked with the stored values (the other user's change).
- The two confirm-step forms: their checkpoint branch and its keep keys are untouched.

## Guard G10 (`apps/erp/tests/t389-keep-typing-guard.test.ts`, same AST approach as G7-G9)
- **G10a.** Every `<EditableRecord` JSX element in `apps/erp/src/**` has a `typed=` attribute whose expression is a
  `typedFor(...)` call, or a prop passed down from one. A literal `typed={null}` or `typed={undefined}` fails, as does
  a missing attribute. **Exception:** the element is in `TYPED_EXEMPT` (`file + label snippet → reason`), and a stale
  or reasonless entry fails. Ratchet `apps/erp/tests/typed-baseline.json` (`{ file: count }`) is seeded at S1 by the
  orchestrator and lowered only by the orchestrator. It ends **empty** at S5, when the prop becomes required and
  TypeScript joins the guard.
- **G10b.** Every `defineTypedForm({ form: 'x' })` key is unique app-wide. It is used by at least one `keepTyping(`
  call in an actions file and at least one `typedFor(` call in a page.
- **G10c.** For each `<EditableRecord action={X}>` whose `X` resolves through an import to `export async function X`,
  the body of `X` contains `keepTyping(`. An action it cannot resolve (`action={action}` passed down) is checked at the
  caller, or listed in `TYPED_EXEMPT` with "resolved by hand: <file:line>".
- **G10d.** Deny list: R4's static check.
- **G10e.** An `EditableRecord` with a `version` in `hidden` has an action whose `keepTyping(` call passes `stale:`.
- **G10f.** Positive controls on literal fixtures: a bare `<EditableRecord action={a} …>` with no `typed` is flagged; a
  `defineTypedForm` naming `pin` throws; an action with no `keepTyping(` is flagged; a versioned form without `stale:`
  is flagged; a stale exempt entry is flagged.

## Tests (TESTER writes first; every red leg is shown red on HEAD or against its named mutant)
- **K1** `apps/erp/tests/t389-keep-typing.test.ts` (unit). Allow-list; a RegExp entry; `__changed` intersection;
  no `__changed` → all allow-listed; `stale: true` → `undefined`; blank record → `undefined`; a checkbox group →
  array; a 500-char note kept whole; `pin`, `newPin` and `bankAccountNumber` never kept, even through a RegExp;
  `defineTypedForm` throws on `password`. Mutants: delete the deny filter → red; delete the stale branch → red.
- **K2** extend `apps/erp/tests/flash.test.ts` and `t380-s2-cookie-size.test.ts`. `typed` round-trips signed; a
  tampered `t` drops; an over-budget `typed` is dropped whole and `td` is set, while `keep` survives; the logger spy
  sees field names and never a value (assert that no typed value substring appears in any log call); `?typed=` in
  the URL is stripped; the redirect URL never contains a typed value (also covered by
  `no-typed-values-in-urls.test.ts`, which stays green).
- **K3** `typedFor`: wrong form → null; wrong record → null; the matching pair → view; `typedDropped` matching →
  `dropped`; expired cookie or a token mismatch → null (through `withFlash` with the flash jar).
- **K4** `apps/erp/tests/t389-editable-record-typed.test.ts` (node, no jsdom, like `t384-s3-editable-record.test.ts`).
  `planApply` over text, textarea, single select, multi select, select with no matching option (skipped), lone
  checkbox, checkbox group, radio group; a pure `changedNames(controls)`; the initial state is `editing` with `typed`
  and `locked` with `dropped`; `renderToStaticMarkup` with `typed` has no `fieldset disabled` and shows Save; with
  `dropped` it has the sentence and Edit. Mutant: init ignores `typed` → red.
- **K5** web tests (integration, one per S1 form). Tender: re-point the existing DEF-617 legs in
  `apps/erp/tests/integration/t384-s1-pos-link-web.test.ts` (around line 645) to `typed`. A non-stale refusal reopens
  editing with the typed name; a stale refusal reopens locked with the stored name; a different tender stays locked.
  Supplier (`apps/erp/tests/integration/t389-s1-supplier-web.test.ts`): a refused save (the lane picks a server-side
  refusal that the browser's `required` cannot pre-empt, for example a duplicate name or a malformed TIN) reopens
  editing with name, select, checkbox and terms days as typed; `bankAccountNumber` is absent from the decoded cookie
  and shows its stored value with the hint. Invoice lines (`…/t389-s1-invoice-lines-web.test.ts`): lines that do not
  add up reopen with `line1..5_*` as typed.
- **G10** as above.

**Expected fallout:** tests that assert the tender keep keys or `storedValues` (`t384-s1-pos-link-web`,
`t384-s1b-min-version-wired`, `flash.test.ts`'s `KEEP_KEYS` list). The tester re-points them with a dated note and
never loosens them.

## Slices

| Slice | BUILDER files | TESTER files | Order / size |
|---|---|---|---|
| **S1** mechanism + 4 forms + guard | `lib/flash.ts`, `lib/keep-typing.ts` (new), `components/forms/EditableRecord.tsx`, `components/forms/index.ts`; `settings/pos-link/{page.tsx,actions.ts,typed-forms.ts}` (tender + store link; remove the 5 tender keep keys and the hand-drawn `typed?.x ??` defaults); `ap/suppliers/[id]/page.tsx`, `ap/invoices/[id]/page.tsx`, `ap/actions.ts`, `ap/typed-forms.ts` | K1-K5, `t389-keep-typing-guard.test.ts` (G10), the fallout tests above. `typed-baseline.json` is seeded by the **orchestrator** | first; M-L (about 1 day) |
| **S2** sweep L1: admin, settings, staff (10) | `admin/stores/{[id]/page.tsx,actions.ts,typed-forms.ts}`; `settings/{organization,attendance,expense-categories,sales-channels,wastage-monitor}/{page.tsx,actions.ts,typed-forms.ts}`; `staff/{[employmentId]/page.tsx,actions.ts,typed-forms.ts}` | one web test per form, `t389-s2-<area>-web.test.ts` | after S1 merges; parallel; S-M |
| **S3** sweep L2: money, sales days (9) | `money-accounts`, `remittance`, `channel-settlements`, `budgets`, `expenses/{[id],recurring}` + `expenses/actions.ts` + `expenses/recurring/actions.ts`, `fixed-assets/{[id]/page.tsx,actions.ts}`, `sales-days/{[id]/page.tsx,actions.ts}`, each with its `typed-forms.ts` | `t389-s3-<area>-web.test.ts` | parallel with S2/S4; S-M |
| **S4** sweep L3: stock and items (10) | `items/{[id]/page.tsx,ItemCodeField.tsx,actions.ts}`, `inventory/{locations,low-stock,counts/[id]}` + their actions, `cutover/{count/page.tsx,actions.ts}`, `commissary/orders/[id]/{page.tsx,actions.ts}`, each with its `typed-forms.ts` | `t389-s4-<area>-web.test.ts` | parallel; M (ItemCodeField's events; multi-line commissary) |
| **S5** close | `EditableRecord.tsx`: `typed` required; drop `initialMode`/`storedValues`; delete leftover keep plumbing | G10's baseline to `{}` (orchestrator); K4's prop-type leg (`@ts-expect-error` on a missing `typed`) | last; S (an hour) |

- **Disjoint paths.** BUILDER paths are only under `apps/erp/src`. TESTER paths are only under `apps/erp/tests`.
  Lanes S2-S4 share no file. `lib/*` and `components/forms/*` belong to S1 and S5 only. If a sweep lane needs a
  mechanism change, it stops and reports. It does not patch `keep-typing.ts`.
- **Workflow?** Most of the per-form work is mechanical (a form definition, one call, one prop). But each form needs
  two judgements: the allow-list, and which refusal to test or smoke. Each form also gets its own web test. **Three
  Sonnet lanes are recommended.** A Workflow-style sweep is acceptable for S2-S4 only if each step still writes its
  web test, and the orchestrator reviews every allow-list against R4 before merge.
- **Per form in the sweep:** (1) `typed-forms.ts` lists the user-editable fields: every non-hidden named control of
  that form, and no hidden ids; (2) the action's refusal branch(es) call `keepTyping`; (3) the page passes
  `typed={typedFor(sp, DEF, id)}`, with the record id the form's own hidden id (the singletons: organization uses `''`,
  attendance, remittance cash policy and wastage monitor use the `storeId`); (4) the web test; (5) report any form
  where no server refusal is reachable, so it is tested by K-style unit tests only.

## §9.4 browser smoke (each slice, port 9008, `docs/SMOKETEST.md`; screenshots in the hand-back)
For each form the lane touched (S1: tender, store link, supplier, invoice lines):
1. Open the record. It is locked. Press Edit, change two fields (one text, one select or checkbox), and enter a value
   the server refuses.
2. Save. The error banner shows, and **the record is open in edit mode with both changes**. Other records on the page
   are locked.
3. The address bar holds only nav keys and `f`, with no typed value. In DevTools > Application, the flash cookie is
   httpOnly.
4. Cancel: the stored values come back and the record locks. Edit, fix the value, Save: it is saved and locked.
5. Reload within a minute of a refusal: it reopens with the typing (by design). After a minute it reopens locked.
6. Tender only: open the same tender in two tabs, save in tab A, then save in tab B. B reopens **locked** with A's
   values and the stale sentence.
7. Supplier only: change the bank account number and the name, then get a refusal. The name comes back as typed;
   the account number shows its stored value with the hint.
8. At 375 and 1366 px, light and dark, check the `dropped` and hint sentences (S1 forces `dropped` once, by a
   test-only override or a very long note).

## Done when
- S1-S5 merged. G10 is green with `typed-baseline.json` = `{}` and `TYPED_EXEMPT` empty, or holding only entries that
  have a reason. `typed` is a required prop.
- K1-K5 and every sweep web test are green. Every mutant named above was shown red. The affected tests and the guard
  and census files pass locally after each commit (row 296), and the full suite passes in CI at wrap-up.
- `no-typed-values-in-urls.test.ts`, G7-G9 and the T-380 cookie-size tests are unchanged and green.
- The five tender keep keys are gone from `KEEP_KEYS`, and no page hand-draws typed values into `defaultValue`.
- The smokes above are screenshotted for each slice.
- The DEF-617 register row reads fixed for every `EditableRecord` form. The orchestrator edits the register and the
  roadmap, not a lane.

## Questions (none block: the conservative option is built)
- **ANSWERED (Ian, 2026-10-10): a — not kept, as built.** **Q1, supplier bank account number (`t389-q1-bank-number-kept`).** May a supplier's typed bank or e-wallet account
  number ride in the one-minute signed cookie after a refused save? The page already shows the stored number, but
  T-380 says nothing secret goes in the flash, and a till PC is shared.
  **(a) Recommended and built: no.** It is excluded through `SENSITIVE`, and the user retypes that one field, with a
  hint. **(b) Yes:** remove it from `SENSITIVE` (one line; G10d still blocks real credentials). Credentials (PIN,
  password) are never echoed under either answer.
