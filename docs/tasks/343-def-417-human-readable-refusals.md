# T-343: DEF-417 (part 2) — user-visible refusals name things in human terms, never raw ids or keys

**Status:** S1–S4 DONE 2026-09-25 (independent Opus review + Amendments R1–R3; audit; isolated /code-review). S5–S9 open. ⛔ §9.4 UNMET for S2 — no refusal banner screen-tested yet.
**Orchestrator defaults (Ian may override any time):** fallback wording as proposed in S1.3; the 96 capability labels
are Sonnet-drafted from CAPABILITY-MATRIX.md notes and fixed later if Ian wants; staging S1 = fail closed on
IDENTIFIERS, strict flip at S9; S3 names the record's KIND, not its number; cross-org refusals never name the other
org or its store.
**Closes:** DEF-417 part 2, over slices. **Model:** Sonnet (tester, builder, per slice). **Migration:** none.
**Ian's rule (2026-09-25):** every warning, refusal or message a user can see names people, stores, orgs, entities and
capabilities in human terms (name, code, label) — never a raw UUID or internal key.

Slices, lowest risk first, each committable alone. TESTER = tests only, BUILDER = source only, disjoint. Tester writes
first and records raw red. Gates: RULES §2 incl. the **full** integration suite before push. ⚠️ **S1 and S2 reach
`main` in the same push** (S1 "Interim effect").

## Evidence
### Mechanism (auditor, verified)
- `apps/erp/src/lib/constraint-messages.ts:275-284`: `errorMessage()`'s DEFAULT branch returns raw `Error.message`,
  stripping only a leading `word:` prefix; only errors with a string `code` (DB) get the fallback. So every non-DB
  Error from domain/auth reaches the screen near-verbatim via `?error=`.
- The choke point fails OPEN.

### Census (auditor 2026-09-25; rows 1–5, 17 verified; tail delegated, spot-checked)
≈95 reachable id-shaped sites; 8 internal. Ranked:
1. `packages/auth/src/authorize.ts:97` "person ${personId} has no active role in org ${orgId}".
2. `:124` "person … (role '…') has no store scope for ${storeId}".
3. `:119` "store ${storeId} does not belong to org ${orgId}".
4. `:83` "actor's org (…) does not match the resource's org (…) for '${capability}'".
5. `:107` "role '${role}' may not '${capability}'" (raw key; most common refusal).
6. `packages/db/src/repo/*.ts` ≈41 sites "<entity> ${id} does not exist in org ${orgId}".
7. `packages/domain/src/sales-days/create.ts:117,237,309`.
8. `packages/domain/src/expenses/{create,edit,approve,void,delete}.ts` (≈12).
9. `packages/domain/src/ap/index.ts:168,218,292,498,540,702,1011`.
10. `packages/domain/src/commissary/transfer.ts:164,170,174` (raw item-kind key).
11. `packages/domain/src/commissary/discrepancy.ts:74,87,159` (raw disposition key).
12. `packages/domain/src/sales-days/verify.ts:42,67,172`.
13. `packages/domain/src/deliveries/documents.ts:126,129,140`.
14. `packages/domain/src/commissary/catalogue.ts:172,289`, `customers/index.ts:111,175`.
15. `packages/auth/src/roles.ts:368,587`, `credentials-admin.ts:46`.
16. `packages/domain/src/cutover/opening.ts:164`.
17. `packages/domain/src/scheduler/index.ts:367,650,864` — subject names rendered raw at
    `apps/erp/src/components/scheduler-status.tsx:84`; siblings `:260/:287/:465` already resolve names.

### Verified additionally (planner, HEAD `6350032`)
- `throw new Error(`: 666× domain, 63× db/repo, 7× auth, 6× core. ≈500 domain messages carry no id and are
  hand-written sentences people rely on — a true fail-closed default today would blank them. Hence staged: S1
  identifiers, S9 strict. 96 custom-class throws (12 classes) extend plain `Error`.
- No presentable pattern exists; closest precedent `apps/erp/src/lib/pre-session-message.ts:138-166`
  (`WRITTEN_FOR_A_PERSON`, `isUnfitForAStranger` treats `AuthorizationError` as fit at `:153` — S1 changes that).
- No capability/role label source: `CAPABILITY_AREA_LABEL` only (11 areas). UI prints raw keys
  (`admin/access-defaults/grid.tsx:211,319`; `admin/users/page.tsx:75`, `[personId]/page.tsx:78,118` use
  `role.replace(/_/g,' ')`).
- Raw message text is load-bearing: ≈40 app regexes (`/may not '<cap>'/` ×19 files, `/no store scope/` ×5,
  `/has no active role/` `admin/access-defaults/actions.ts:43`); `production/index.ts:866`
  `/already reversed|does not exist/`; `admin/users/actions.ts:80,104`; ≈45 test files ⇒ **human text is an ADDITIONAL
  field, never a rewrite of `message`.**
- `authorize()` is used as a probe inside one tx (`ar/index.ts:82-85`, `sales-days/create.ts:266-270`,
  `trade/index.ts:70-74`, `admin/stores/lib.ts:60-64`) ⇒ refusal-time lookups must not fail on accepted input.
- RLS on lookup tables is org isolation only (`0011_row_level_security.sql:83`, `:117`).
- Shared `errorMessage` imported by 55 files; ≈22 local wrappers (DEF-257 guard
  `apps/erp/tests/local-errormessage-convergence.test.ts`). Four bypasses: `commissary/discrepancies/actions.ts:83-84`,
  `sales-days/actions.ts:37`, `remittance/actions.ts:101`, `clock/page.tsx:172`.
- `scheduler-status.tsx:84-86` renders stored JSON verbatim; historical rows keep "store <uuid>".

## Goal
No text reachable through the ERP's error channel contains a UUID. Every `authorize()` refusal is a sentence naming
role, capability, store and org in human terms. Repo "not found" refusals name the kind of record. Scheduler failure
lines name the store/category/order. Raw diagnostics survive unchanged in `Error.message`, logs and refusal records.

## Design: the presentable contract
**Presentable** = an `Error` with an own, non-empty, single-line string `userMessage`. `message` stays the raw
diagnostic. Structural on purpose (`@shareat/db` does not depend on `@shareat/core`; `packages/auth/src/errors.ts` must
stay a value-import-free leaf — `packages/auth/tests/errors-leaf.test.ts`). Producers: `AuthorizationError` (S2),
`RecordGoneError` in db (S3), `RefusalError` in domain (S5). One consumer predicate `isPresentable(err)` in
`apps/erp/src/lib/error-shape.ts`. S1 fails closed on identifiers; S9 flips strict once the ratchet reaches zero.

---

## S1: the choke point never returns a UUID; presentable errors win
**Change** (`error-shape.ts`, `constraint-messages.ts`, `pre-session-message.ts`):
1. `error-shape.ts` (still a leaf): `export const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i`;
   `containsIdentifier(s)`; `isPresentable(err)` — an `Error`, `typeof userMessage === 'string'`, trimmed non-empty,
   `!looksLikeADump(userMessage)`.
2. `errorMessage(err)`: Step 0 (new) `isPresentable(err)` → candidate `err.userMessage`; otherwise steps 1–4 as today.
   Final gate on EVERY branch: if `containsIdentifier(candidate)` → `logger.error({ err, raw }, 'user-facing error
   carried an identifier, sanitised for the screen')` and return `UNPRESENTABLE_FALLBACK` (covers P0001 text and a buggy
   `userMessage`). `recordIfUnmappedConstraint` and `LOCALLY_MAPPED_CONSTRAINT_NAMES` untouched.
3. `UNPRESENTABLE_FALLBACK = 'That could not be done, and the reason is not one this screen can show yet. It has been logged for your admin.'`
4. `pre-session-message.ts`: default `message` = `isPresentable(err) ? err.userMessage : err.message`;
   `isUnfitForAStranger` returns `true` whenever `containsIdentifier` holds — checked BEFORE the `AuthorizationError`
   early `return false` at `:153`.
**Interim effect:** after S1 alone, rows 1–4 render as the fallback where no local regex map exists — so S1+S2 push together.
**BUILDER:** `apps/erp/src/lib/error-shape.ts`, `apps/erp/src/lib/constraint-messages.ts`, `apps/erp/src/lib/pre-session-message.ts`.
**TESTER:** `apps/erp/tests/t343-s1-presentable.test.ts`, `apps/erp/tests/t343-s1-action-guard.test.ts`,
`tests/unit/t343-throw-ratchet.test.ts` (all new).
**Red** (`U='0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b'`, `V='0190ffff-0000-7000-8000-000000000001'`):
- R1 `errorMessage(new Error(\`authorize: store ${U} does not belong to org ${V}\`))` === fallback, no UUID. Red: raw text.
- R2 `Object.assign(new Error(\`raw ${U}\`), { userMessage: "Your role (Manager) can't close an accounting period." })` → exactly the userMessage. Red: `raw 0190a3b4-…`.
- R3 P0001 `Object.assign(new Error(\`cash request ${U} is not approved\`), { code: 'P0001' })` → fallback. Red: verbatim.
- R4 presentable whose `userMessage` contains `U` → fallback. Red: record verbatim.
- R5 `vi.spyOn(logger, 'error')` called exactly once with `{ err, raw }` for R1. Red: 0 calls.
- R6 `preSessionMessage(new AuthorizationError(\`… ${U}\`, 'manage_users'), policyWithOpaque)` under production → `policy.opaque`. Red: raw.
- R7 page guard (mock `next/navigation` redirect as `t337-access-defaults-actions.test.ts:15-50`; do NOT mock
  `@/lib/constraint-messages`): `createSupplierAction` (`apps/erp/src/app/ap/actions.ts:92`) with a mocked
  `createSupplier` throwing `new Error(\`createSupplier: org ${U} …\`)` → decoded `error` param has no UUID. Red: contains `U`.
- R8 ratchet: count `throw new Error(` in `packages/domain/src`, `packages/auth/src`, `packages/db/src/repo` (excl.
  tests) `<= CEILING` measured at HEAD (≈736) and written in; later slices lower it. Green on arrival; record the number.
**Negative halves (unedited):** `constraint-messages.test.ts:73`, `:80`, the 26 mapped sentences (`:45`), P0001 hand
sentences (`:244`); `constraint-messages-error-classification.test.ts`, `pre-session-message.test.ts`,
`local-errormessage-convergence.test.ts`. N1 the `validateInvoiceLines … does not add up …` sentence still returns
stripped and unchanged. N2 dates, peso amounts, store codes (`SM-MOA`), a 12-digit number are not identifiers. N3
`{ userMessage: '' }` and `'a\nb'` are not presentable. Any listed file red → STOP and report.

---

## S2: `authorize()` refusals carry a human sentence (rows 1–5)
**Labels** (`packages/auth/src/capabilities.ts`, imports nothing): `ROLE_LABEL: Readonly<Record<Role, string>>`
(`super_admin: 'Super admin', admin: 'Admin', manager: 'Manager', staff: 'Staff'`); `CAPABILITY_LABEL:
Readonly<Record<Capability, string>>` — all 96, lower-case bare-infinitive phrases completing "you can't …"
(e.g. `record_sale: 'record a sale'`, `close_period: 'close an accounting period'`, `run_cutover: 'run the
opening-balance cutover'`), drafted from CAPABILITY-MATRIX.md notes; exhaustive `Record` like `CAPABILITY_AREA` (`:597`).
Presentation only.
**Sentences** (`packages/auth/src/refusal-text.ts`, new, pure):
| Row | Function | Sentence |
|---|---|---|
| 1 | `noActiveRole(orgName)` | `Your account has no active role in ${orgName ?? 'this organization'}, so nothing here can be changed yet. Ask an admin to give you one.` |
| 5 | `roleMayNot(role, cap)` | `Your role (${ROLE_LABEL[role]}) can't ${CAPABILITY_LABEL[cap]}. Ask an admin if you need to.` |
| 2 | `notAssignedToStore(cap, store)` | `You aren't assigned to ${store ? \`${store.name} (${store.code})\` : 'that store'}, so you can't ${label} there.` |
| 3 | `storeNotInOrg(orgName)` | `That store isn't part of ${orgName ?? 'your organization'}.` (never names the foreign store) |
| 4 | `otherOrg(cap)` | `That record belongs to another organization, so you can't ${label} on it from here.` (never names the foreign org) |
| — | `storeRequired(cap)` | `Pick a store first. To ${label} you have to choose which store it is for.` |
| — | `closePeriodNeedsWholeOrg(orgName)` | `Closing a period changes every store's books, so a manager needs to be assigned to every active store in ${orgName ?? 'the organization'}.` |
The person is always the actor ("you"); no person lookup.
**Error class** (`packages/auth/src/errors.ts`): `constructor(message, capability, userMessage?)`; `readonly
userMessage?: string` set only when non-empty; leaf rule unchanged. Other construction sites (`roles.ts` ×9,
`credentials-admin.ts` ×2, `trade/index.ts:77`, one test) compile unchanged (non-presentable until S5a).
**authorize.ts:** all 7 throws pass a third arg from `refusal-text.ts`; `message` byte-identical. Refusal-branch
lookups only: `organizationsRepo.identityOf(tx, actor.orgId)` (rows 1, 3, close_period), `storesRepo.getById(tx,
actor.orgId, ctx.storeId)` (row 2); each `…catch(() => undefined)` with the table's fallback phrase; reuse values the
same call already sent to Postgres. ⛔ No lookup on the success path. ⛔ No savepoint.
**BUILDER:** `packages/auth/src/{capabilities.ts,refusal-text.ts (new),errors.ts,authorize.ts,index.ts}` (export the two labels only).
**TESTER:** `packages/auth/tests/t343-refusal-text.test.ts`, `t343-authorize-lookups.test.ts` (`vi.mock('@shareat/db')`),
`t343-authorize-census.test.ts` (new); `packages/auth/tests/integration/authorize.test.ts` (new `describe` only).
**Red:**
- T1 every `Capability` × function, every `Role` for `roleMayNot`: one line, upper-case start, ends `.`, no `_`, no
  quoted key, no UUID; labels non-empty, no duplicates. Red: missing.
- T2 success-path budget (negative half, green before/after): allow-all mocks; `organizationsRepo.identityOf` and
  `storesRepo.getById` spies that throw if called; `authorize(…, 'void_expense', { storeId })` resolves, neither called.
- T3 `personHasStoreScope → false`: `getById` called once; `userMessage` contains `Store Name (CODE)`. Red: undefined.
- T4 lookup rejects: still `AuthorizationError`, `userMessage` contains `that store`. Red: undefined.
- T5 source census `authorize.ts`: zero `throw new Error(`; every `new AuthorizationError(` passes a refusal-text call. Red: 7.
- T6 integration `describe('T-343 S2 — each refusal carries a human sentence')` rows 1–5 + close_period: exact
  sentence from fixture names; no UUID; NEGATIVE: `err.message` still matches today's regexes (`/has no active role in
  org/`, `/has no store scope for/`, `/does not belong to org/`, `/does not match the resource's org/`, `/role 'staff'
  may not 'close_period'/`); rows 3–4 never contain org B's names. Red: undefined.
**Negative halves:** existing `authorize.test.ts`, `roles.test.ts`, `errors-leaf.test.ts`,
`super-admin-capability-set.test.ts`, the app regex maps, every domain integration file matching authorize wording —
unedited; the full suite proves it.
**Smoketest (9008):** a staff user attempts a manager-only action with no local regex map (e.g. void a sales day) →
`Your role (Staff) can't void a sales day. …`; an unassigned store → names it with code. Both themes.

---

## S3: repo "record gone" refusals name the kind of record (row 6)
`packages/db/src/repo/record-gone.ts` (new): `class RecordGoneError extends Error { readonly userMessage: string }`;
`recordGone(rawMessage, what, notLonger?)` → `userMessage = That ${what} could not be found${notLonger ? \`, or it is no
longer ${notLonger}\` : ''}. Someone may have changed it — reload the page and try again.` Raw message byte-identical.
Population: every `throw new Error(` in `packages/db/src/repo/*.ts` interpolating `${id}`, `${…Id}`, `${input.id}` or
`${orgId}` (≤3 continuation lines). Classified internal (one-line reason each in the census allowlist):
`stock-layers.ts:164,166`, `etl.ts:115,147,230`, `journal.ts:44,202`, `attendance-punches.ts:78`, `remittance.ts:194`.
**BUILDER:** `record-gone.ts` + each census-named repo file (≈20) + `packages/db/src/index.ts` (type export).
**TESTER:** `packages/db/tests/t343-repo-refusal-census.test.ts`, `packages/db/tests/t343-record-gone.test.ts` (new);
`packages/domain/tests/integration/expenses.test.ts` (new `describe` only; else name the nearest file).
**Red:** C1 census — every in-population throw is `recordGone(` or classified; stale allowlist entries fail. Red: ≈41,
record list. C2 unit — message byte-identical, `userMessage` exact. Red: missing. C3 integration — voiding an
already-voided expense → `/^That expense could not be found, or it is no longer posted\./`, no UUID. Red: undefined.
**Negative halves:** `production/index.ts:866` branch; `admin/users/actions.ts:80,104`; ≈40 tests matching `does not exist` — unedited.

---

## S4: scheduler subject names (row 17)
- `:367` extend the store select (`:345-347`) with `s.name, s.code` → `${store.name} (${store.code})`; no extra query.
- `:650` add `label: string` to `BackstopResult.failures` (`packages/domain/src/wastage/orders.ts:11,34`) from `row`:
  `${channel} order ${row.orderRef ?? 'without an order number'} · ₱${row.amount}`; store prefix `Name (CODE)` via one
  `storesRepo.listForOrg` read only if failures is non-empty. ⚠️ Builder checks whether `order_wastage.channel` is a
  display name or a key; if a key, resolve via `channelId` in the same failure-only read; report which.
- `:864` inside the `catch` only: one `asSystem` read of `storesRepo.getById` + `expensesRepo.getCategoryById` →
  `${store.name} (${store.code}) · ${category.name} · ${periodLabel(b.periodKey)}` (`'202609'` → `September 2026`);
  on lookup failure `a budget for ${periodLabel}`, never an id.
- `subjectId` unchanged.
- S4b `apps/erp/src/components/scheduler-status.tsx:77,84-86`: `last.error`, `f.subjectName`, `f.reason` through
  `containsIdentifier`; id-bearing → `(detail in the server log)` / `an item from an earlier run`. Needs S1.
**BUILDER:** `packages/domain/src/scheduler/index.ts`, `packages/domain/src/wastage/orders.ts`, `apps/erp/src/components/scheduler-status.tsx`.
**TESTER:** `packages/domain/tests/t343-scheduler-subject-census.test.ts`, `apps/erp/tests/t343-scheduler-status.test.tsx` (new).
**Red:** S-C1 no `subjectName:` template interpolating an id in `scheduler/index.ts` (red: 3). S-R1 fixture failure
with `U` in subject and reason → rendered text has no UUID (red: contains `U`). Negative: `no fiscal period covers
2026-06-30` renders verbatim; `scheduler.test.ts:182` and the file green unedited.

---

## Later slices (listed, not specced)
- **S5** domain tail (rows 7–16) per module group: `packages/domain/src/shared/refusal.ts` `RefusalError` +
  `refuse(raw, sentence)`; name records by human key; id-free sentences convert too (lowers the ratchet). **S5a**
  `roles.ts`, `credentials-admin.ts` (row 15).
- **S6** labels for dispositions and item kinds (rows 10, 11) beside the enums in `packages/db/schema/*`; also the raw
  keys already on screen (`admin/access-defaults/grid.tsx:211,319` → `CAPABILITY_LABEL`; `admin/users/*` →
  `ROLE_LABEL`; `items/page.tsx` kind; `inventory/usage` reason codes).
- **S7** collapse ≈40 app regexes into `err instanceof AuthorizationError && err.capability === …`, or delete.
- **S8** the four choke-point bypasses.
- **S9** strict flip — codeless fall-through returns the fallback for any non-presentable Error; precondition: ratchet at zero.

## Invariants
1. `Error.message` byte-identical at every converted site; human text is an added field.
2. Refusal recording unchanged (`withOrgPrincipal`, `recordingRefusalsFor` at `apps/erp/src/app/expenses/lib.ts:150-171`,
   `recordIfUnmappedConstraint` get the same `err`; T-261, bible §13 row 189).
3. Sanitising is not discarding: every scrubbed message logged at `error` with the whole `err` (T-326 Invariant 3).
4. `errorMessage` never returns a UUID from any branch.
5. No query on the `authorize()` success path; refusal lookups reuse accepted inputs.
6. No cross-tenant disclosure (bible §7; §15.11; RULES §6.3).
7. `errors.ts` stays a value-import-free leaf.
8. DEF-257: no new local `errorMessage` copy.
9. Apps never import apps; packages never import apps (RULES §1 rule 13).
10. Labels are presentation only (T-337 U3 precedent).
11. Mapped constraint sentences and id-free P0001 sentences render exactly as today.

## Out of scope
Rewording domain messages (S5+) and the strict flip (S9); POS/CUSTOMER/Website; hand-crafted `?error=` URLs; register
edits (orchestrator logs the four bypasses and `grid.tsx` raw keys as DEFs); translating `CAPABILITY-MATRIX.md` notes.

## Done when (per slice)
Named reds red→green with raw red recorded; negative halves and named regressions green unedited; typecheck + unit
clean; **full** integration 0 failed; build green with 9008 stopped; slice smoketest with screenshots; one commit per
slice; S1+S2 one push. After S4, DEF-417 part 2 stamped **PARTIAL** (rows 1–6 and 17 fixed; 7–16 open under S5).

## Amendment R1 — independent Opus review (2026-09-25), binding
1. **S1 redacts in place; it does not blank the sentence.** The UUID gate replaced whole sentences that users rely on
   (P0001/DEF-279: `apps/erp/tests/constraint-messages.test.ts:219-252` ×5, `constraint-messages-error-classification.test.ts:102-116`
   and `:265-274` — e.g. "stock would go negative: item <uuid> at location <uuid> would be -1.000"; the quantity and
   amounts matter). New rule: every UUID in the candidate is replaced by `[hidden]`, and the rest of the sentence
   survives; the raw text is still logged at `error` once. `UNPRESENTABLE_FALLBACK` is used only when the candidate is
   a dump (`looksLikeADump`) or empty after redaction. Those 7 assertions are AMENDED by the tester to expect the
   redacted sentence (and the logger-call expectation at `:265-274` flips to "called once") — ruled here, not a
   silent test weakening. R1/R3/R4 are rewritten to expect the redacted form; R3 becomes the ✗ for "P0001 with an id
   is redacted, the rest survives". Invariant 4 reads: never returns a UUID; Invariant 11: mapped and P0001 sentences
   keep all non-id text.
2. **Pre-session wording.** `/setup` has no admin yet: `pre-session-message.ts`'s opaque/fallback text must not say
   "logged for your admin". The only production caller passes `errorMessage(err)` explicitly
   (`apps/erp/src/app/setup/actions.ts:115`); R6 tests THAT path (explicit argument), not only the default.
3. **S8 gains** the local wrappers that return raw text before the gate: `admin/access-defaults/actions.ts:57`,
   `staff/actions.ts:43-58`, `inventory/production/actions.ts:37`.
4. **Hardening:** `isPresentable` also requires `!hasStringCode(err)` so a DB error never jumps its mapped sentence.
5. **S2 T6 gains a probe-commit case:** `canBypassBlock` (`sales-days/create.ts:266`) refuses a manager who does not
   cover the whole org (a refusal that triggers a lookup), then the same transaction keeps writing and COMMITS — no 25P02.
6. Nit: use a name-only org read if one exists; else `identityOf` is acceptable.

## Amendment R2 — auditor, S2 build (2026-09-25), binding
1. `.catch(() => undefined)` does not un-abort a Postgres transaction: a lookup that ERRORS aborts the whole tx, and
   the probe callers then fail later with 25P02. **Each refusal-branch lookup runs inside a SAVEPOINT** (a nested
   `tx.transaction(t => …)`, which drizzle emits as a savepoint) with the catch around it, so a failed lookup rolls
   back only itself. Cost is on the refusal path only; the success path stays query-free (T2).
2. Probe callers are four, not one: `sales-days/create.ts:266` (`canBypassBlock`), `ar/index.ts:82-84`,
   `people/index.ts:208-216` (loop over stores), `trade/index.ts:70-77` (`authorizeEither`, loop over capabilities).
   T6 covers `canBypassBlock` AND `authorizeEither`, each with a FORCED lookup error (the tester chooses the mechanism —
   e.g. a role without SELECT on `organizations`/`stores`, or a relation made unavailable inside the test tx) and
   asserts the same tx then writes and commits. Lookup cost on `authorizeEither`'s fall-through is accepted: row 5
   (`roleMayNot`, the usual fall-through) does no lookup; only scope/org refusals do.

## Amendment R3 — isolated /code-review of S1+S2 (2026-09-25), binding
Accepted:
1. `trade/index.ts:77` `authorizeEither` rethrows the LAST refusal, now shown to users first → rethrow the FIRST
   (primary capability's) refusal. Builder may edit `trade/index.ts` for this.
2. Refusal-lookup failures are swallowed silently → the catch logs once at `warn` (never throws).
3. `sanitiseForScreen` logs routine P0001 redactions at `error`, flooding alerts → `warn`. Invariant 3 now reads
   "logged at warn with the whole err".
4. The stale `errorMessage` docblock ("never sanitised, never logged") moves back onto `errorMessage` and is corrected.
5. `noActiveRole` says "nothing here can be changed yet" even for view capabilities → neutral wording:
   "…so you can't use this yet. Ask an admin to give you one."
6. Nits: one helper for the four savepoint lookups; hoist the UUID regex.
Tester: authorize.test.ts:1178/1213 titles contradict their bodies (rename to what is asserted); T6b organizations case
gains a negative half (prove the revoke actually blocks SELECT outside a savepoint); drop unused `statSync` import in
the ratchet test; add a case for item 1 (first refusal is the one surfaced).
Dismissed with reason: refusal-path cost of one savepoint + SELECT for probe callers (≈1 ms, refusal path only; the
success path stays query-free).

**S3 census note (2026-09-25):** the id-shaped-throw regex never matched 4 of the 9 classified-internal entries
(concatenated-string throws in `etl.ts` and `attendance-punches.ts`, a nested-backtick throw in `remittance.ts`, a
non-id `docPath` throw) — so the census cannot see id-bearing throws built by concatenation or nested templates.
Follow-up for S5: widen the scanner (or move to an AST scan) before trusting "0 unclassified" as complete.
CLASSIFIED_INTERNAL is now pinned by file + message substring, not line.
