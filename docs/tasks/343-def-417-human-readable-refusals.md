# T-343: DEF-417 (part 2) — user-visible refusals name things in human terms, never raw ids or keys

**Status:** S1–S4 DONE 2026-09-25. S5.0–S5.1 DONE 2026-09-26. **S5.1b, S2b, S5a, S5.2 (+follow-up), S5.3, S5.1c, S5.1d, S5.3b DONE 2026-09-27** (each: tester red, builder, Opus audit, full gates; committed locally, push pending Ian). Refusal banners screen-tested on 9008 for S5.1b/S5.1c. **S6a/S6b/S6c specced and APPROVED 2026-09-27 (§S6), serial S6a → S6b → S6c.** **S5.5m (DEF-454) and S7 (DEF-452 + trade line numbers) specced and APPROVED 2026-09-27 (§S5.5m, §S7); S7 strictly after S6c and S5.5m.** Open: S6a–S6c, S5.4 (after S6c), S5.5m, S5.5+, S7, S8, S9.
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
- `authorize()` is used as a probe inside one tx (`ar/index.ts:82-85`, `sales-days/create.ts:284-291` (R4.10),
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
- **S6 / S6b — now specced in full at §S6 below (APPROVED 2026-09-27), split into S6a (label sources, S5.4's
  precondition), S6b (DEF-431 + every `admin/users` raw key) and S6c (the other screens).** The one-liners are
  superseded; `admin/users/*` → `ROLE_LABEL` moved from S6 to S6b so no two slices edit the same file.
- **S2b (DEF-430, folded in by Ian 2026-09-25; lands after T-341) — now specced in full at §S2b (APPROVED 2026-09-26).** A store-scoped refusal from axis 3b where the person
  holds the capability via a position at OTHER stores must not blame the role. Name the store and where the job is, e.g.
  "…can't submit a sales day at SmokeStore Two — their Cashier job is at SmokeStore." Needs a refusal-only lookup,
  savepointed like S2's. Evidence: `t341-smk2-refusal.png`.
- **S7** collapse ≈40 app regexes into `err instanceof AuthorizationError && err.capability === …`, or delete. **Now
  specced at §S7 (APPROVED 2026-09-27): 31 remain at HEAD, all in DEF-452's 13 files; every one is deleted, none re-keyed.**
- **S8** the four choke-point bypasses. **Scope shift (2026-09-27, §S5.5m/§S7):** S8 keeps only NON-presentable raw
  returns and re-wraps. S7 puts `isPresentable` first in the R1.3 wrappers (`production`, `staff`, `access-defaults`),
  and S5.5m owns `remittance/actions.ts` `handedOverOn`'s presentable re-wrap.
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
5. **S2 T6 gains a probe-commit case:** `canBypassBlock` (`sales-days/create.ts:284`, R4.10) refuses a manager who does not
   cover the whole org (a refusal that triggers a lookup), then the same transaction keeps writing and COMMITS — no 25P02.
6. Nit: use a name-only org read if one exists; else `identityOf` is acceptable.

## Amendment R2 — auditor, S2 build (2026-09-25), binding
1. `.catch(() => undefined)` does not un-abort a Postgres transaction: a lookup that ERRORS aborts the whole tx, and
   the probe callers then fail later with 25P02. **Each refusal-branch lookup runs inside a SAVEPOINT** (a nested
   `tx.transaction(t => …)`, which drizzle emits as a savepoint) with the catch around it, so a failed lookup rolls
   back only itself. Cost is on the refusal path only; the success path stays query-free (T2).
2. Probe callers are four, not one: `sales-days/create.ts:284` (`canBypassBlock`, R4.10), `ar/index.ts:82-84`,
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

---

## S5: domain tail refusals name things in human terms (rows 7–16)

**Status:** APPROVED 2026-09-25 (orchestrator, after independent Opus spec review; S5 Amendment R1 binding). Replaces the S5/S5a one-liners under
"Later slices" once approved. **Model:** Sonnet, tester then builder, per group. **Migration:** none.

### S5 evidence (planner, HEAD `1e7862c` + the in-flight T-344 tree, 2026-09-25)
- **Ratchet:** `tests/unit/t343-throw-ratchet.test.ts:28` `CEILING = 736`, never lowered after S3. Measured: HEAD **693**,
  working tree **702** (T-344 in flight added 9). S3's 43 conversions are unclaimed slack.
- **Scanner gap (S3 census note, confirmed):** `packages/db/tests/t343-repo-refusal-census.test.ts` `findIdShapedThrows`
  regex misses concatenated and nested-template throws. A TypeScript-AST scan (planner, scratch) finds **3 live,
  user-reachable, unclassified id-bearing repo throws S3 never saw**: `packages/db/src/repo/ap.ts:431` (invoice voided),
  `:437` (invoice not verified), `:443` (invoice over capacity) — template + `+` concatenation.
- **Rows 7–16 are the head, not the whole tail.** AST count of id-shaped `throw new Error(` / `reason:` sites:
  domain **260** (+15 raw-key), id-free **568**. Rows 7–16 cover ≈81: expenses 22, ap 22, commissary 16 (Outcome
  `reason:`), sales-days 12, deliveries 5, customers 3, cutover 1. Unowned by any row: stock 39, production 24,
  ledger 12, ar 10, trade 10, wastage 10, items 9, stock-locations 9, owners 8, pos 7, … (≈180) — S5.5+, not specced here.
- **Rows 10–11 are not throws:** `commissary/transfer.ts:164,170,174` and `commissary/discrepancy.ts:74,87,159` return
  `Outcome` `{ ok:false, reason }` (`commissary/outcome.ts:10-12`); apps put `reason` straight into `?error=` with no
  `errorMessage` (`apps/erp/src/app/commissary/discrepancies/actions.ts:59,87`; **`commissary/orders/[id]/actions.ts:106`
  — a bypass S8 does not list**). The S1 UUID gate never sees them. (R1.1: `:106` was mis-traced — it shows
  `postOrderMessage`'s reasons, not transfer/discrepancy; S5.1b owns it. R4.1: only `commissary/messages.ts:40` is in
  `postOrderMessage` and reaches `:106`; `:61` is in `listOrderMessages` (`:56`) — S5.1b still converts it.)
- **Auth cannot import domain** (`packages/domain/package.json:15-17`: domain depends on auth and db; auth depends on db).
  A class defined only in `packages/domain/src/shared/` is unreachable from `roles.ts`/`credentials-admin.ts`;
  `recordGone` is repo-internal (`packages/db/src/index.ts:15-17`, type export only).
- Row files, raw `throw new Error(` counts: sales-days/{create 6, verify 10}; expenses/{approve 6, categories 10,
  create 7, delete 2, edit 7, reimbursement 4, void 4}; ap/index.ts 39; customers/index.ts 11; deliveries/documents.ts
  10; commissary/catalogue.ts 16; cutover/opening.ts 9; auth roles.ts 1 (+9 two-arg `AuthorizationError`),
  credentials-admin.ts 6 (+2).
- In-flight T-344/T-345/T-346 own `domain/src/{fiscal-periods,scheduler,findings,ledger/post-entry.ts,missed-months,
  people/position-defaults.ts,stores,fixed-assets}/**` and `auth/src/capabilities.ts`. **No S5 group below edits
  them**; ledger, fixed-assets, stores and scheduler conversions are S5.5+ and run **after T-346**.

### Design
**One class, at the lowest shared layer.** `packages/db/src/refusal.ts` (new, value-import-free):
`class RefusalError extends Error { readonly userMessage: string }`, `name = 'RefusalError'`. `RecordGoneError` becomes
`extends RefusalError` (name, `message`, `userMessage` unchanged). `refuse(raw, sentence)`, the pure
`goneSentence(what, notLonger?)` and `RefusalError` are all defined in `packages/db/src/refusal.ts`; `goneSentence` is
re-parented there from `record-gone.ts`, and `recordGone` imports and uses it (one wording) (R1.5). The UUID regex
`refuse` uses also lives in `refusal.ts` (R1.4). `@shareat/db` exports all three values. **Constructing `RefusalError`
directly is test-only:** production code calls `refuse`/`gone`/`recordGone` (R1.5). This departs
from the one-liner ("RefusalError in domain") because auth could not reach a domain class; the domain file still
exists as the producer API:

`packages/domain/src/shared/refusal.ts` (new) re-exports `RefusalError` and `refuse` (R1.5), and adds:
| Helper | Returns | Use |
|---|---|---|
| `refuse(raw, sentence)` (defined in `@shareat/db`, re-exported, R1.5) | `RefusalError` | every refusal a person can act on |
| `gone(raw, what, notLonger?)` | `RefusalError`, `userMessage = goneSentence(…)` | "X does not exist" in domain |
| `internalFault(raw)` | `InternalFaultError extends Error`, **no** `userMessage` | unreachable invariants ("carries no journalEntryId — data inconsistency", "no ordering key"); shows S1's fallback and leaves the ratchet honestly |
| `humanDate(d)` | `formatBusinessDateTime(businessDayRange(d).start, { dateStyle: 'medium' })` | no second date formatter |

`refuse` **sanitises**; it does not throw on free text (sentences interpolate particulars, invoice numbers and names).
It collapses every whitespace run (newlines included) to one space, trims, and replaces each UUID with `[hidden]` (the
S1 token). It throws only when the result is empty (possible only with an empty literal; test-caught).
`apps/erp/src/lib/error-shape.ts` keeps its leaf copy of the UUID regex, and a parity test (F7) pins the two `.source`
strings equal (R1.4). `message` is always `raw`, byte-identical (Invariant 1).

**Sentence rules (every group):**
1. One line, ends `.`, second person, no function prefix (`createExpense:`), no `_`, no quoted raw key, no column name
   (`journalEntryId`, `totalAmount`), no bible/DEF citation, no UUID.
2. The record on screen is named **deictically** ("this expense", "this sales day"), with no lookup. A record the
   person did not pick, or one among several, is named by its **human key**: store `Name (CODE)`; sales day = store +
   `humanDate`; expense = `"particulars" (humanDate)`; supplier / customer / item / category / price list / money
   account = name; supplier invoice = `invoice ${invoiceNo} from ${supplierName}` (no number → `the ${humanDate}
   invoice from …`); AP payment = `the ₱amount payment of ${humanDate}`; delivery line = `line ${lineNo}` or the item
   name; account = `${code} ${name}` (a code is a human key).
3. Not found → `gone(raw, what, notLonger?)`, S3's exact wording.
4. An id-free sentence already written for a person converts as `refuse(raw, <same text minus the prefix and any
   bible/DEF citation>)`. Wording kept, not rewritten.
5. A wrapping rethrow keeps the inner `userMessage` (the `expenses/categories.ts:138` shape).
6. Naming lookups run on the refusal path only, reuse rows already loaded, and fall back to the deictic phrase on any
   failure. The builder greps each converted function's callers; if one is used as a probe inside a continuing tx, the
   lookup is savepointed as in S2/R2. Report which, if any.
7. Cross-org: never name another org's record (Invariant 6).

**Census scanner (S5.0, first):** `tests/unit/lib/throw-census.ts` (tester-owned; helper precedent
`tests/unit/lib/document-facts.ts`, AST precedent `apps/erp/tests/touch-target-geometry.ts`). A `ts.createSourceFile`
walk of `throw new <X>(arg)` and, opt-in, `reason:` property initialisers. It classifies `arg` by every interpolated or
`+`-concatenated operand, recursing into nested templates and conditionals: **id** (final name
`/^(id|[a-z]\w*Id|uid)$/`), **key** (`itemKind|kind|disposition|role|capability`), **derived** (an operand that is a
`.join(…)` call, a `.message` access, or `String(<non-literal>)` — ids collected into a list and joined later) (R1.3),
else **plain**. Derived counts as needing classification: it fails the census unless the site is in an allowlist with a
one-line reason (e.g. the rule-5 rewrap, which reads `userMessage`, not `.message`) (R1.3). It returns
`{ file, line, kind, callee, text }`, counts `refuse(`/`gone(`/`internalFault(` sites, and classifies `refuse`'s 2nd
argument with the same classifier.

### Groups: order and why
| # | Group | Rows | Sites | Why this position |
|---|---|---|---|---|
| S5.0 | foundation + widened scanner | — | 0 converted | everything below depends on it; the scanner must be trusted before any "0 left" |
| S5.1 | sales days + expenses | 7, 8, 12 | 56 | highest traffic: every store, every day (submit/verify/void a day; record/approve an expense) |
| S5.1b | commissary order messages (R1.1) | — (the fifth bypass) | `messages.ts:34,36,40,47,61,64` | after S5.1; any time after S5.0, **no S6 dependency**; **sole owner of `commissary/orders/[id]/actions.ts:106`** (S8 does not list it, S5.4 does not touch it); adds `Outcome.userReason` and `outcomeMessage` that S5.4 reuses |
| S2b | DEF-430 — specced in full at **§S2b** below (APPROVED) | row 5 (store-scoped) | `authorize.ts:152-158` | T-341 landed (`4e986a3`); disjoint from S5.1 and may run beside it; **must precede S5a** (both edit `auth/src/refusal-text.ts`) |
| S5a | auth roles + credentials | 15 | 7 raw + 11 two-arg | admin-only traffic; serial after S2b |
| S5.2 | AP + customers + repo `ap.ts` | 9, 14b, new | 39 + 11 + 3 | weekly supplier and customer work |
| S5.3 | deliveries + catalogue + opening | 13, 14a, 16 | 10 + 16 + 9 | low traffic; `run_cutover` is once per org |
| S6a / S6b / S6c | labels; DEF-431 — specced at **§S6** (APPROVED) | 10, 11 | — | strictly serial S6a → S6b → S6c (one tester, one builder); S6a is S5.4's precondition |
| S5.4 | commissary `Outcome` reasons | 10, 11 | ≈16 reasons | needs S6 labels and an app edit that overlaps S8 |
| S5.5m | money-amount labels (DEF-454) — specced at **§S5.5m** (APPROVED) | — | 40 `parseMoneyInput` callers (36 domain, 4 app) | before S7 (shares `trade/index.ts`); shares no file with S6a–S6c or S5.4, so may run beside S6 |
| S7 | app wrappers stop pre-empting refusals (DEF-452) + trade line numbers — specced at **§S7** (APPROVED) | — | 31 branches in 13 `actions.ts`; `roles.ts`, `sessions.ts`, `NewOrderForm.tsx`, `trade/index.ts` | **strictly after S6c and S5.5m commit** (`admin/users/actions.ts` is S6b's; `trade/index.ts` is S5.5m's) |
| S5.5+ | the ≈180 unowned sites (stock, production, …) | — | — | specced later; ledger, fixed-assets, stores and scheduler after T-346 |

**Ratchet rule (every group) (R1.2):** at S5.0, `tests/unit/t343-throw-ratchet.test.ts` replaces the single `CEILING`
with `CEILINGS: Record<dir, number>`, one per top-level directory under `packages/domain/src`, plus `packages/auth/src`
and `packages/db/src/repo`, each set to the count measured at the S5.0 commit (total today: 702). **Stated allowance:**
`+10` each on `missed-months`, `fixed-assets`, `stores`, `ledger` (the T-345/T-346 dirs), named `ALLOWANCE_UNTIL_T346`
in the file; the first commit after T-346 lands removes it, re-measuring those four. No other slack anywhere. A new
directory with no entry fails. Each group lowers **its own directories' `CEILINGS` entries** to the measured count
(before and after numbers in the commit message). Never raised.
> **T-346 status note (R2, 2026-09-26):** T-346 S1 landed as commit `1ac1bca` (2026-09-26); S2/S3 are landing today.
> The S5.0 builder runs `git log --oneline --grep "T-346"` before setting `ALLOWANCE_UNTIL_T346`.

---

### S5.0: foundation and the widened scanner
**BUILDER:** `packages/db/src/refusal.ts` (new), `packages/db/src/repo/record-gone.ts`, `packages/db/src/index.ts`,
`packages/domain/src/shared/refusal.ts` (new), `packages/domain/src/index.ts` (one export line).
**TESTER:** `tests/unit/lib/throw-census.ts` (new), `tests/unit/t343-s5-throw-census.test.ts` (new),
`packages/domain/tests/t343-s5-refusal.test.ts` (new), `packages/db/tests/t343-repo-refusal-census.test.ts` (new `describe` only),
`tests/unit/t343-throw-ratchet.test.ts` (`CEILING` → `CEILINGS` + `ALLOWANCE_UNTIL_T346`, R1.2),
`apps/erp/tests/t343-s5-uuid-shape-parity.test.ts` (new, F7, R1.4).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| W1 | + | fixture of 7 shapes: (1) single template; (2) multi-line template with trailing comma; (3) `'…' + \`${x.supplierId}\``; (4) `'store ' + storeId + '…'`; (5) nested `${a ? \`${b.id}\` : ''}`; (6) `short.push(\`${line.itemId} …\`)` then `reason: \`…${short.join(', ')}\`` (the `commissary/transfer.ts:170,174,178` shape); (7) `\`x: ${err.message}\`` (the `expenses/categories.ts:138` shape) — yields exactly **5 id + 2 derived** hits at the right lines (R1.3) | green on arrival (tester code); record the S3 regex's count on shapes 1–5 (expected 2) as the gap evidence |
| W2 | ⛔ | an id-free fixture (plain string; template interpolating only `amount`, `name`, `status`) yields 0 hits; AND the shared `assertFinds(scanner, fixture, 5)` helper **fails** when given `() => []` (a scanner that matches nothing must fail, DEF-179) | green on arrival |
| W3 | + | real tree: scanning `packages/db/src/repo` finds the 3 `ap.ts` id hits, and **visits** the `remittance.ts` nested-template throw and the `attendance-punches.ts` concatenated throw (present in the all-throws list) | green on arrival |
| W4 | + | db census `describe('T-343 S5.0 — widened scanner')`: every id hit is `recordGone(`, in `CLASSIFIED_INTERNAL`, or in `PENDING_S5_2` = exactly the 3 `ap.ts` sites (pinned by message substring); a stale `PENDING_S5_2` entry fails | green on arrival; S5.2 empties the list |
| F1 | + | `refuse(raw, s)`: `instanceof RefusalError` and `Error`, `message === raw`, `userMessage === s`, `name === 'RefusalError'` | import fails (module missing) |
| F2 | + | `gone(raw, 'expense', 'posted').userMessage === recordGone(raw, 'expense', 'posted').userMessage`; `recordGone(…) instanceof RefusalError` | missing |
| F3 | ⛔ | `internalFault(raw)` has no own `userMessage`; `message === raw` | missing |
| F4 | ⛔ | (R1.4) `refuse(raw, 'a\n  b').userMessage === 'a b'`; `refuse(raw, \`x ${U}\`).userMessage === 'x [hidden]'`; `refuse(raw, '  ')` throws | missing |
| F5 | + | `humanDate('2026-09-25')` equals the `formatBusinessDateTime` expression above and contains `2026` and `25` | missing |
| F7 | ⛔ | (R1.4) `apps/erp/tests/t343-s5-uuid-shape-parity.test.ts`: `error-shape.ts`'s `UUID_SHAPE.source` equals the `packages/db/src/refusal.ts` copy | missing |

**Negative halves (unedited):** `packages/db/tests/t343-record-gone.test.ts` (byte-identical after the re-parent), the
S3 `C1` describe, `packages/auth/tests/errors-leaf.test.ts`. (`t343-throw-ratchet.test.ts` is no longer unedited: S5.0's
tester converts it to `CEILINGS`, R1.2.)

---

### S5.1: sales days and expenses (rows 7, 8, 12)
Scope: every raw `throw new Error(` in `packages/domain/src/sales-days/{create,verify}.ts` and
`packages/domain/src/expenses/*.ts` (56). `SalesDayBlockedError`, `TransitShortfallBlockedError` and the `routing.ts`
`reason` strings are untouched (S8/S9 own them).

| Site | Becomes |
|---|---|
| `sales-days/create.ts:116` | `This store already has a sales day for ${humanDate} (${status}). Edit that one instead of starting a second.` |
| `create.ts:236` | `One of the sales channels on this day isn't set up for this store. Reload the page and try again.` |
| `create.ts:307` | `One of the wallets on this day isn't an active wallet of this store. Reload the page and try again.` |
| `verify.ts:42,67,172` · `expenses/{approve:51,void:35,edit:58,delete:43}` | `gone(raw, 'sales day')` · `gone(raw, 'expense')` |
| `expenses/{create:105,edit:79,categories:121}` · `create:117`, `edit:96` · `create:136` | `gone(raw, 'expense category')` · `'supplier invoice'` · `'supplier'` |
| `verify.ts:47` | `Only an open sales day can be submitted — this one is ${status}.` |
| `verify.ts:82` · `approve.ts:63` | `This sales day has been voided, so it can't be posted.` · the same for "expense" |
| `verify.ts:116` · `approve.ts:187` | `This sales day can't be posted yet: ${routed.reason}.` · the same for "expense" (the reason is id-free; S1 redacts if not) |
| `verify.ts:179` | `Only a verified sales day can be voided — this one is ${status}. An unverified day is edited instead.` |
| `approve.ts:92` | `The category on this expense no longer exists. Pick another category, then approve it.` |
| `approve.ts:105` | `A money account on this expense no longer exists. Edit the payment, then approve it.` |
| `create.ts:146` · `edit.ts:101` | `That invoice is from ${invoiceSupplierName}, not ${pickedSupplierName}. An expense takes its supplier from its invoice.` (picked name by refusal-path lookup; fallback `the supplier you picked`) |
| `categories.ts:58` | `There is no account with code ${code}.` |
| `categories.ts:138` | rewrap keeps the inner `userMessage` (rule 5) |
| `delete.ts:51` · `edit.ts:62` · `void.ts:41` | `Only a draft can be deleted — this expense is ${status}. Void a posted expense instead.` · `Only a draft can be edited — this expense is ${status}. Void it instead.` · `This expense is still a draft, so there is nothing posted to void. Edit or discard it instead.` |
| `reimbursement.ts:54` | `This employee has no unpaid reimbursement.` |
| `verify.ts:75,185` · `approve.ts:58` · `void.ts:46` | `internalFault(raw)` |
| every other site | rule 4 (same sentence, prefix and citations dropped) |

**BUILDER:** the 9 source files above — source only (R4.4).
**TESTER:** `tests/unit/t343-throw-ratchet.test.ts` `CEILINGS` entries for `sales-days` and `expenses` only, after the
builder's READY (lower each to the count measured at HEAD + the builder's change; `internalFault` sites leave the count
too) (R1.2, R4.4); `packages/domain/tests/t343-s5-domain-census.test.ts` (new; a `CONVERTED_DIRS` list each later group
appends to); `packages/domain/tests/integration/sales-days.test.ts` and `expenses.test.ts` (new
`describe('T-343 S5.1 …')` only); `apps/erp/tests/t343-s5-action-guard.test.ts` (new).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| D1 | + | census: `sales-days/`, `expenses/` have 0 raw `throw new Error(`; every `refuse(` 2nd arg classifies **plain**; no `throw new <X>(` of any class whose first argument classifies id, key or derived (R1.2; derived allowlist per R1.3); no `new RefusalError(` (R1.5) | red: 56 raw sites (record the list) |
| D2 | ⛔ | census floor: across `CONVERTED_DIRS`, `refuse(` + `gone(` + `internalFault(` ≥ 50 (a converted tree that scans empty fails) | red: 0 |
| E1 | + | `voidSalesDay` on an open day → `userMessage` exactly the `verify.ts:179` sentence with `open`; no UUID | undefined |
| E2 | + | duplicate `createSalesDay` → `userMessage` contains `humanDate(date)`, no UUID | undefined |
| E3 | + | `approveExpense` on a voided expense → exact sentence; `voidExpense` on a stale id → `/^That expense could not be found\./` | undefined |
| E4 | + | `createExpense` with supplier A's invoice and `supplierId` B → names both suppliers | undefined |
| E5 | ⛔ | each E1–E4 `err.message` still matches its current regex (`/only a verified day has a posting/`, `/already exists for store/`, `/is voided — cannot post/`, `/does not own supplier invoice/`) | green before and after |
| E6 | ⛔ | a planted verified day with no journal entry → `InternalFaultError` with no `userMessage`; through `errorMessage` → the S1 fallback | class missing |
| A1 | + | `voidSalesDayAction` (redirect mocked as in R7; real `constraint-messages`) with a mocked `voidSalesDay` throwing `refuse(\`… ${U}\`, s)` → decoded `error` === `s` | green if S1 holds; if red, report it (a bypass) |
| F6 | + | (R1.4) an expense whose particulars are `"Rice\n sack"` and an invoice number containing `U` renders as one line with `[hidden]` through the `create.ts:146` sentence | undefined |

**Negative halves (unedited):** `sales-days.test.ts`, `expenses.test.ts`, `expense-categories-admin.test.ts`,
`expenses-staff-float.test.ts`, `ap.test.ts`, every app test matching these messages; the full integration suite.
**Smoketest (9008):** void an open sales day; approve a voided expense. Sentences as tabled, both themes.

---

### S5.1b: commissary order messages (the fifth bypass), after S5.1 (R1.1)
Specified in full by R1.1 below (sites, `Outcome.userReason`, `outcomeMessage(result)`, BUILDER/TESTER paths, legs
M1–M4). Summary: `apps/erp/src/app/commissary/orders/[id]/actions.ts:106` shows `result.reason` from
`postOrderMessage` (`packages/domain/src/commissary/messages.ts:40`, `order ${input.orderId} does not exist`), not
transfer/discrepancy. (R4.1) The same id-bearing reason at `messages.ts:61` is in `listOrderMessages` (`:56`), which does
not reach `:106`; it converts all the same (`userReason` = `goneSentence('order')`). This group **alone owns `:106`**;
it does not wait on S6.

---

### S5.1c: the commissary order page's own refusal paths (DEF-445, DEF-446)
**Status:** APPROVED 2026-09-27 (orchestrator). **Model:** Sonnet, tester then builder. **Migration:** none. Runs after
S5.1b (same `[id]/actions.ts`); independent of S2b/S5a (touches no `packages/auth` file). Folds DEF-444 (same function).

**Goal.** Every refusal on the branch-order screens reaches the person as the S2/S2b sentence (`userMessage`), a refused
post shows a banner instead of the error boundary, and a post about a vanished order lands on the list, not a 404.

**Evidence** (HEAD `48efa8a`, verified):
- `apps/erp/src/app/commissary/orders/lib.ts:45-51` `errorMessageOf`: `:47-48` regex `/may not '([a-z_]+)'/` on
  `err.message` → `Your role may not <key>.`; `:49` `/no store scope/` → a local sentence. Both return BEFORE `:50`
  `sharedErrorMessage(err)` (`apps/erp/src/lib/constraint-messages.ts:296`, the only reader of `userMessage`, `:302`).
  Both raw texts come from `AuthorizationError`s that already carry a `userMessage`: row 5 (`roleMayNot`, S2/S2b) and
  row 2 (`packages/auth/src/authorize.ts:200-204`, `notAssignedToStore`). So both branches are pure bypasses.
- Callers (grep, whole `apps`/`packages`): `[id]/actions.ts:59` (`perform()`, every order action) and
  `orders/actions.ts:55` (save draft, list page). **Both screens change text**: refusals now read the S2/S2b sentence.
  `apps/erp/src/app/wastage/actions.ts:57-60` is a separate private copy of the same regex (a sixth bypass). **Not in
  this slice**: it needs its own DEF number.
- `[id]/actions.ts:68-114` `postMessageAction`: no try/catch. `:99` `authorize(tx, actor, 'post_order_message', …)`
  throws out of the action. `post_order_message` is `staff: false` (`packages/auth/src/capabilities.ts:797`).
  `[id]/page.tsx:407` renders the composer with no capability check, and the page has no capability helper (`:62` reads
  only `orderView` + `actorStoreIds`). Ruling: **catch; do not gate the composer** (gating needs a new helper, not
  the smallest change).
- DEF-444: `:75` returns the gone-order outcome, and `:110-111` redirects every failure to `/commissary/orders/<id>`,
  which calls `notFound()` (`page.tsx:63`).

**Change (BUILDER).**
1. `lib.ts:45-51`: delete `:46-49`. `errorMessageOf(err)` = `sharedErrorMessage(err)`. Keep the export and its name
   (two callers, and `t343-s5-outcome-message.test.ts:59-62` mocks it by name). Update the doc comment.
2. `[id]/actions.ts` `postMessageAction`: wrap the `withOrgPrincipal(…)` call in try/catch. On catch →
   `back(orderId, { error: errorMessageOf(err) })`. `redirect()` stays OUTSIDE the try, same as `perform()`.
3. DEF-444: the `:75` arm is marked gone (e.g. `gone: true` on the local result). When a failure is gone, redirect to
   `/commissary/orders?error=…` (the list). Every other failure keeps `/commissary/orders/<id>?error=…`. The text is
   unchanged: `outcomeMessage(result)`. `perform()`'s gone-shape is **not** censused here (DEF-444's second half stays open).
- **BUILDER paths:** `apps/erp/src/app/commissary/orders/lib.ts`, `apps/erp/src/app/commissary/orders/[id]/actions.ts`.
- **TESTER paths (disjoint):** `apps/erp/tests/t343-s5-1c-commissary-refusals.test.ts` (new). Same harness as
  `t343-s5-outcome-message.test.ts` (`RedirectSignal`, mocked `@shareat/db`/`@shareat/domain`). Use the REAL
  `errorMessageOf` for C1–C3 and C8, and the real `AuthorizationError` built with a third-argument `userMessage`.

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| C1 | `errorMessageOf(new AuthorizationError("… may not 'fulfil_branch_order'", cap, S))` | `=== S` | returns `Your role may not fulfil branch order.` |
| C2 | same, raw `… has no store scope for <uuid>`, `userMessage` S | `=== S` | returns the local `You are not assigned…` sentence |
| C3 ⛔ | plain `Error` with a UUID and a `fn: ` prefix, no `userMessage` | equals `errorMessage(err)`, no UUID | green now (must stay) |
| C4 | `postMessageAction`, `authorize` throws `AuthorizationError(…, S)` | redirects to `/commissary/orders/order-1`, `error === S` | throws `AuthorizationError` (no redirect) |
| C5 ⛔ | `postMessageAction` succeeds | no `error` param; `postOrderMessage` called once; revalidates `/commissary/orders/order-1` | green now |
| C6 | `orderParties` → `null` | pathname `=== '/commissary/orders'`, `error === goneSentence('order')` | pathname is `/commissary/orders/order-1` |
| C7 ⛔ | not-a-party (`:93`) | pathname stays `/commissary/orders/order-1` | green now |
| C8 | `orders/actions.ts` save draft, domain throws `AuthorizationError(…, S)` | `error === S` | `Your role may not …` |
| C9 ⛔ | source text of `lib.ts` | contains no `may not '` and no `no store scope` | contains both |

**Negative halves (unedited, must stay green):** `apps/erp/tests/t343-s5-outcome-message.test.ts` M3–M6 (M5 asserts the
param only, not the path), `apps/erp/tests/local-errormessage-convergence.test.ts`,
`apps/erp/tests/t343-s5-action-guard.test.ts`, `packages/domain/tests/integration/t343-s5-commissary-messages.test.ts`.
No existing test asserts `Your role may not` (grep: only `lib.ts:48` and `wastage/actions.ts:60`, both source).

**Smoketest (9008, screenshots).** As staff scoped to the branch on an open order: (a) post a message → a banner with
the S2 sentence for `post_order_message`, no error boundary; (b) a refused order action → the S2/S2b sentence, not
`Your role may not …`; (c) open an order, delete it elsewhere, post from the stale tab → the list page with "That order
could not be found."

---

### S5.1d: the remaining app wrappers that pre-empt refusals (DEF-448, DEF-450, rest of DEF-444)
**Status:** APPROVED 2026-09-27 (orchestrator). **Model:** Sonnet, tester then builder. **Migration:** none. Independent
of S5.3 (touches no `packages/domain` file; S5.3's in-flight test files are not in this slice's paths).

**Goal.** On the wastage, stores, deliveries and rooms screens, every `AuthorizationError` reaches the person as its
S2/S2b `userMessage`, and any presentable error beats a screen-local regex. Local sentences for non-authorization
errors (constraint names, plain domain throws) stay.

**Evidence** (HEAD `6b8f7cc`, verified):
- **Rule for every wrapper below:** `authorize()`'s seven throw sites (`packages/auth/src/authorize.ts:116-221`) all pass
  a `userMessage` (S2/S2b), and the shared `errorMessage` (`apps/erp/src/lib/constraint-messages.ts:296`, step 0 `:301`)
  is its only reader. A local branch keyed on `may not '…'`, `no store scope` or `authorize:` is a **pure bypass**.
- `apps/erp/src/app/wastage/actions.ts:57-63` `errorMessageOf`: `:59-60` `may not '…'` → `Your role may not <key>.`;
  `:61` `no store scope` → local sentence; `:62` shared. **Both branches are bypasses** (DEF-448, the DEF-445 twin).
  Five callers in the file (`:120/136/167/194/214`).
- `apps/erp/src/app/admin/stores/actions.ts:52-75` local `errorMessage`: `:63-65` `no store scope` and `:66-68`
  `authorize:` (returns "Only an admin or super-admin can open or close a branch." for ANY refusal, including
  `manage_store_settings`, `stores/service.ts:455`) are **bypasses**. `:54-62` (three constraint names) are **kept**:
  real class-23 errors, never presentable. `:72-73` `^(setStoreOpeningDate|createStore): (.+)$` is a **duplicate**:
  shared step 4 (`:323`) strips the same prefix from a codeless Error and also sanitises. It pre-empts a presentable
  error whose raw starts with that prefix (what S5 conversion of `stores/service.ts` will produce). Delete it.
- `apps/erp/src/app/inventory/deliveries/actions.ts:48-107`: `:51-53` `receive_delivery`, `:54-57` `allow_over_receipt`,
  `:58-60` `no store scope` are **bypasses**. `:61-102` (11 branches: DB constraints, plain domain throws) are **kept**.
  But they run before shared, so after S5.3 converts `deliveries/documents.ts` (e.g. `:115` proof file → `gone(…)`), the
  local regex would still beat the domain's presentable sentence. Hence the presentable guard below.
- `apps/erp/src/app/inventory/locations/actions.ts:35-69`: `:38-40` `manage_locations`, `:41-43` `no store scope for` are
  **bypasses**. `:44-64` (constraints, the `single_room` plain throw) are **kept**.
- DEF-444 remainder (**out of this slice**): `commissary/orders/[id]/actions.ts:53-64` `perform()` only ever sees a
  thrown error. A vanished order throws a plain `Error` (`packages/domain/src/commissary/orders.ts:116` `branch order
  <id> does not exist.`, `packages/domain/src/trade/index.ts:682`). The only tell is `/does not exist/`, which also
  matches "that item does not exist." (`orders.ts:270`), so that is guessing. Even `gone(…)` returns a plain
  `RefusalError`, not a gone-typed one. **Precondition:** when `commissary/orders.ts` is converted (S5.5+), `:116`
  throws `recordGone(raw, 'order')` (`RecordGoneError`, `packages/db/src/repo/record-gone.ts:25`). Then `perform()`
  can redirect `instanceof RecordGoneError` to the list. DEF-444 stays half open and names that slice.
- **Not in this slice** (S7's "≈40 app regexes"): the same `may not '…'` shape in `inventory/{pos-map,pos-usage,
  production,usage,counts}`, `items`, `staff`, `staff/[employmentId]/credentials`, `trade/orders`,
  `commissary/catalogue`, `attendance/terminals`, `admin/users`, `admin/access-defaults` `actions.ts` (grep at HEAD).

**Change (BUILDER).**
1. `wastage/actions.ts`: delete `:58-61`. `errorMessageOf(err)` = `sharedErrorMessage(err)`. Keep the name and all five
   call sites. Update the doc comment.
2. `admin/stores/actions.ts`, `inventory/deliveries/actions.ts`, `inventory/locations/actions.ts`: in each local
   `errorMessage`, (a) make the first statement `if (isPresentable(err)) return sharedErrorMessage(err);` (import
   `isPresentable` from `@/lib/error-shape`; presentable wins, which is step 0 of the shared function, run first here);
   (b) delete the bypass branches listed above; (c) stores only: delete the `named` branch `:72-73`. Every other branch
   keeps its text and order. Fix the doc comments that name authorize denials.
- **BUILDER paths:** `apps/erp/src/app/wastage/actions.ts`, `apps/erp/src/app/admin/stores/actions.ts`,
  `apps/erp/src/app/inventory/deliveries/actions.ts`, `apps/erp/src/app/inventory/locations/actions.ts`.
- **TESTER paths (disjoint):** `apps/erp/tests/t343-s5-1d-wrapper-refusals.test.ts` (new). Same harness as
  `t343-s5-1c-commissary-refusals.test.ts` (`RedirectSignal`, mocked `next/navigation`/`next/cache`/session/
  `withOrgPrincipal`, domain functions mocked to throw). The REAL `@/lib/constraint-messages` and `@/lib/error-shape`.
  The real `AuthorizationError` (third-argument `userMessage` S) and the real `RefusalError`/`refuse` from
  `packages/db/src/refusal`. The wrappers are private, so each leg drives an exported action and reads the `error`
  param. W-legs need `salesDaysRepo.findByBusinessDate` → a row (`wastage/actions.ts:99` checks it before the domain).

| Id | Leg (action → domain mock throws) | Asserts | Expected red |
|---|---|---|---|
| W1 | `recordOrderWastageAction` → `AuthorizationError("authorize: role 'manager' may not 'record_order_wastage'", cap, S)` | `error === S` | `Your role may not record order wastage.` |
| W2 | `disputeOrderWastageAction` → raw `… has no store scope for <uuid>`, `userMessage` S | `error === S` | `You are not assigned to the store this action belongs to.` |
| W3 ⛔ | `recordOrderWastageAction` → plain `Error('recordOrderWastage: <uuid> text')` | equals `errorMessage(err)`, no UUID | green now |
| S1 | `createStoreAction` → `AuthorizationError("authorize: role 'manager' may not 'manage_stores'", cap, S)` | `error === S` | `Only an admin or super-admin can open or close a branch.` |
| S2 | `setStoreOpeningDateAction` → raw `no store scope`, `userMessage` S | `error === S` | `You do not have access to that store.` |
| S3 | `createStoreAction` → `refuse('createStore: raw tail', S)` | `error === S` | `raw tail` (the `named` branch) |
| S4 ⛔ | `createStoreAction` → `{ code: '23514', constraint: 'stores_pooling_requires_ceiling_check' }` Error | the local pooling sentence | green now |
| S5 ⛔ | `createStoreAction` → plain `Error('createStore: a store needs a code.')` | `a store needs a code.` | green now (must stay after S3's deletion) |
| D1 | `receiveDeliveryAction` → `may not 'receive_delivery'`, S | `error === S` | `Recording or receiving a delivery needs at least staff access…` |
| D2 | same → `may not 'allow_over_receipt'`, S | `error === S` | `Only a manager or admin can approve receiving more…` |
| D3 | `createDeliveryAction` → `no store scope`, S | `error === S` | `You are not assigned to the store this delivery belongs to.` |
| D4 | `createDeliveryAction` → `refuse('createDeliveryDocument: proof file <uuid> does not exist in this org', S)` | `error === S` | `That photo could not be found — try attaching it again.` |
| D5 ⛔ | receive → plain `Error('receiveDeliveryDocument: line 2 must carry a shortage reason')` | the local shortage sentence | green now |
| D6 ⛔ | create → `{ code: '23505', constraint: 'deliveries_supplier_reference_key' }` Error | the local duplicate sentence | green now |
| L1 | `createLocationAction` → `may not 'manage_locations'`, S | `error === S` | `Only a manager or admin scoped to this store may manage its rooms.` |
| L2 | same → `no store scope for <uuid>`, S | `error === S` | `You do not have access to manage rooms for this store.` |
| L3 ⛔ | same → `{ code: '23505', constraint: 'stock_locations_one_receiving_per_store' }` Error | the local Receiving sentence | green now |
| L4 ⛔ | `createLocationAction` → plain Error containing `is single_room and already has an active non-Receiving room` | the local ONE-room sentence | green now |
| X1 ⛔ | source text of the four BUILDER files | none contains `may not '`, `no store scope` or `/authorize:/` | all four contain one |

Build each constraint-shaped error the way `local-errormessage-convergence.test.ts` does. Read the export names from
the files at HEAD. The action names above are the ones the tester verifies, not guesses to copy.

**Negative halves (unedited, must stay green):** `apps/erp/tests/local-errormessage-convergence.test.ts` (each of the
three still declares a local `errorMessage` and imports the shared one aliased), `t343-s1-presentable.test.ts`,
`t343-s5-action-guard.test.ts`, `t343-s5-1c-commissary-refusals.test.ts`, `t343-s5-outcome-message.test.ts`.
**No existing test asserts any sentence this slice deletes.** Greps over `apps/erp/tests` and `packages` for every
deleted sentence and for `Your role may not` find only source files and S5.1c's own leg labels (`:153`, `:285`).
So the TESTER updates no existing test.

**Smoketest (9008, screenshots).** (a) As a manager whose job is at store A: on `/wastage?store=<B>`, with a sales day
already recorded at B for that date (`:99` refuses first otherwise), record a wastage. The banner shows the S2b
"…the Manager job that lets you is at A" sentence, not `Your role may not …`. (b) As staff on `/admin/stores`,
change a store's opening date. The banner shows the S2 sentence for `manage_stores`, not "Only an admin or
super-admin…". (c) On deliveries, tick "allow over-receipt" as staff and receive. The banner shows the S2 sentence for
`allow_over_receipt`.

---

### S2b: a store refusal names where the job is, not the role (DEF-430), before S5a
**Status:** APPROVED 2026-09-26 (orchestrator, after independent review). **Model:** Sonnet, tester then builder. **Migration:** none (reads three existing
tables; no column, index or policy added). Must land before S5a (both edit `packages/auth/src/refusal-text.ts`).

**Goal.** When `authorize()` refuses a store-scoped capability at row 5 (axis 3a/3b) and the person does hold it
through a position at another store in the same org, the sentence names this store and the store where the job
is. It does not blame the role. Where no such job exists, or the lookup fails, the S2 sentence is shown unchanged.

**Evidence** (HEAD `bf6741c`, verified):
- `~/.claude/skills/orchestrator/tools/t341-smk2-refusal.png`: New sales day at SmokeStore Two (SMK2) →
  `Refused: Your role (Staff) can't submit a sales day. Ask an admin if you need to.` The same person can submit at
  SmokeStore (SMK), where their Cashier position's default grants it. The sentence sends the admin to change the role.
  The real fix is a position default or an employment at SMK2.
- `packages/auth/src/authorize.ts:152-158`: `allowed = matrixAllows || personHasActiveGrant(…, scope === 'store' ?
  ctx.storeId : undefined)`. On `!allowed` it throws `roleMayNot(role, capability)`, with no lookup (`:156`).
- `packages/db/src/repo/access.ts:730-749` `personHasActiveGrant`: when given `atStoreId`, it matches `store_id IS NULL
  OR store_id = atStoreId`. So a `'position'` row at another store fails the check by design (T-341/DEF-414). That is
  the refusal this slice rewords, and **the check itself does not change**.
- `packages/db/schema/access.ts:188-202,257-258`: `person_grants.source_ref` → `position_capability_defaults.id`.
  `store_id` is NOT NULL exactly when `grant_source = 'position'` (CHECK). It is filled by the trigger
  `0159_t341_person_grants_store.sql:222-239`. `packages/db/schema/position-capability-defaults.ts:39-65` has
  `org_id, position_id, store_id`. `packages/db/schema/employment.ts:99-125` has `positions.name, org_id, is_active`.
  `packages/db/schema/stores.ts:61` has `is_active`. RLS on `position_capability_defaults` is FORCED and org-scoped
  (`0146_…:71-73`).
- `packages/auth/src/refusal-text.ts:17`: the only import is `./capabilities` (labels). The function for row 5 is at
  `:29-31`. `packages/auth/src/authorize.ts:67-72` `savepointLookup` is the one helper for refusal lookups (R2.1, R3.2,
  R3.6).
- Scenario fixture already exists: `packages/domain/tests/integration/t341-position-grants-per-store.test.ts:131-155`
  (P1: Cashier at B, Cook at A; `record_sale@A` rejects `/may not 'record_sale'/`).
- Probe callers whose row-5 refusals now do the lookup. Every capability named here is `'store'`-scoped, with its
  `CAPABILITY_SCOPE` line in `capabilities.ts`:
  - `ar/index.ts:82` (`override_credit_limit`, `:479`).
  - `people/index.ts:206-212` (`enrol_staff`, `:518`), with one call per refused store in the loop.
  - `trade/index.ts:690-692` (`authorizeEither`): `place_branch_order` (`:449`).
  - The same call also tries `fulfil_branch_order` (`:450`).
  - `trade/index.ts:803-805` (`authorizeEither`, `confirm_receipt`, `:435`).
  - `sync/health.ts:343` (`mayProvision`, `provision_clock_terminal`, `:527`). It runs on every manager quarantine view,
    and its `catch {}` is bare.
  `submit_sales_day` (the DEF-430 capability) is at `:394`. `canBypassBlock` (`sales-days/create.ts:284-291`) probes
  `close_period`, which is `'org'`, so it is unaffected.

**Design.**
1. **Sentence** (`refusal-text.ts`, new pure function `jobIsElsewhere(capability, here, jobs)`). `here: { name; code }
   | undefined`. `jobs: readonly JobElsewhere[]`, where `JobElsewhere = { positionName; storeName; storeCode }` is
   declared **in `refusal-text.ts`**. It is structurally equal to the repo row. ⛔ No new import (R1.5 stays true: one
   import, `./capabilities`). Let `H` = `${here.name} (${here.code})`, or `that store`. Let `S(j)` = `${storeName}
   (${storeCode})`. Every interpolated name has its whitespace collapsed (`/\s+/g` → `' '`, then trimmed), so a
   position name with a newline cannot break the single-line rule. Jobs are grouped by store, keeping the input order.
   Positions within a store are de-duplicated and joined `A`, `A and B`, or `A, B and C`.
   | Case | Sentence |
   |---|---|
   | 1 store, 1 position | `You can't ${label} at ${H} — the ${pos} job that lets you is at ${S}. Ask an admin if you need to do it here too.` |
   | 1 store, 2+ positions | `… — the ${join(positions)} jobs that let you are at ${S}. Ask an admin …` |
   | 2–3 stores | `You can't ${label} at ${H} — the jobs that let you are at other stores: ${join(positions)} at ${S1}; ${…} at ${S2}. Ask an admin if you need to do it here too.` |
   | 4+ stores | the first 3 groups, then `; and ${n} more store(s)` (`1 more store`, `2 more stores`) |
   DEF-430's example becomes `You can't submit a sales day at SmokeStore Two (SMK2) — the Cashier job that lets you is
   at SmokeStore (SMK). Ask an admin if you need to do it here too.` ⚠️ **Voice:** DEF-430 wrote "their Cashier job",
   but the banner is read by the refused person. S2's rule holds: the actor is "you", and no person is looked up.
   "The job that lets you" stays true even when the person holds the same position here with the default switched off.
2. **Lookup** (`packages/db/src/repo/access.ts`, new `positionGrantsElsewhere(tx, { personId, orgId, capability,
   excludingStoreId })` → `PositionGrantElsewhereRow[]`). `access.ts` declares its own `export interface
   PositionGrantElsewhereRow { positionName; storeName; storeCode }` and imports nothing from `@shareat/auth`, which
   would create a package cycle. It is only structurally equal to `refusal-text.ts`'s `JobElsewhere`. It sits beside
   `personHasActiveGrant`, whose semantics it mirrors. It is
   one SELECT DISTINCT `positions.name, stores.name, stores.code`, from `person_grants g` joined to
   `position_capability_defaults d` (`d.id = g.source_ref AND d.store_id = g.store_id`), then `positions p`
   (`p.id = d.position_id`), then `stores s` (`s.id = g.store_id`). WHERE: `g.person_id`; `g.grant_name = capability`;
   `g.revoked_at IS NULL`; `g.grant_source = 'position'`; `g.store_id <> excludingStoreId`; `s.is_active`; and
   **`s.org_id = d.org_id = p.org_id = orgId`**. ORDER BY `s.name, s.code, p.name`. No LIMIT: the row count is
   bounded by one person's positions × stores, and the sentence needs the true store count for "and N more".
   ⛔ There is no `throw` in it, so the ratchet is unchanged. Inactive stores are excluded because a job at a closed
   store "lets you" do nothing. If only inactive stores hold the job, the S2 sentence is shown. There is **no
   `p.is_active` filter.** That mirrors `personHasActiveGrant` (`access.ts:730-749`), which still honours a grant whose
   position has been retired, so naming that position is truthful.
3. **authorize.ts, row 5 only.** Inside `if (!allowed)`, and only when `scope === 'store' && ctx.storeId`, make ONE
   `savepointLookup(tx, async (t) => { const jobs = await accessRepo.positionGrantsElsewhere(t, …); return jobs.length
   ? { jobs, here: await storesRepo.getById(t, actor.orgId, storeId) } : undefined; })`. When no job is found, that is
   one SELECT, and `getById` is never called. Then `throw new AuthorizationError(<message byte-identical>,
   capability, found ? jobIsElsewhere(capability, found.here, found.jobs) : roleMayNot(role, capability))`. The third argument is written inline, with both calls in it, so S2's T5 census (`t343-authorize-census.test.ts:84-92`)
   stays green unedited. `ctx.storeId` has already been sent to Postgres by the same call (`:154`), which satisfies
   S2's "reuse values the same call already sent". Update the `:156` comment.
   ⛔ There is no lookup on the success path, for org- or platform-scoped capabilities, or when `ctx.storeId` is absent.
   **This supersedes S2's "Row 5 — no lookup" and R2.2's "row 5 … does no lookup"** for store-scoped capabilities. The
   cost is accepted on R3's dismissal reasoning: one savepoint and two SELECTs, on the refusal path only. The worst
   case is the `enrol_staff` loop, with one lookup per refused store.
4. **Cross-org rule.** The sentence never names another org's store, position or org. This is enforced in two layers
   (§15.11): the explicit `org_id = orgId` filters on all three joined tables, plus RLS on the defaults and stores.
   `here` comes from `getById(orgId, …)`. For a foreign `storeId`, `here` is `undefined` and the sentence reads
   "that store".
5. **Failure.** If either query errors, the savepoint rolls back only itself and one `warn` is logged (the existing
   helper). The sentence is then `roleMayNot`, the unchanged S2 text. An empty result also gives `roleMayNot`.
   `message`, `capability` and the refusal records are unchanged (Invariants 1, 2).

**BUILDER:** `packages/auth/src/refusal-text.ts`, `packages/auth/src/authorize.ts`, `packages/db/src/repo/access.ts`.
**TESTER:** `packages/auth/tests/t343-s2b-refusal-text.test.ts` (new), `packages/auth/tests/t343-s2b-authorize-lookup.test.ts`
(new, `vi.mock('@shareat/db')` as `t343-authorize-lookups.test.ts:34-70`), `packages/domain/tests/integration/t341-position-grants-per-store.test.ts`
(new `describe('T-343 S2b …')` only, reusing `fixture`/`hireStaff`/`setDefault`), `packages/auth/tests/integration/authorize.test.ts`
(new `describe` only, beside T6b).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| J1 | + | `jobIsElsewhere('submit_sales_day', {name:'SmokeStore Two',code:'SMK2'}, [{positionName:'Cashier',storeName:'SmokeStore',storeCode:'SMK'}])` === the DEF-430 sentence in Design 1 exactly | import fails (function missing) |
| J2 | + | two positions at one store → `the Cashier and Cook jobs that let you are at SmokeStore (SMK)`; duplicate position rows collapse | missing |
| J3 | + | 2 stores → the `other stores:` form, groups in input order, `; ` separator; 5 stores → 3 groups + `; and 2 more stores`; 4 → `1 more store` | missing |
| J4 | ⛔ | `here` undefined → `at that store`; `positionName: 'Head\n  Cook'` → `Head Cook`, single line; for every `Capability`, the S2 T1 rules hold (a copy of `assertHumanSentence`, since `t343-refusal-text.test.ts` stays unedited) | missing |
| J5 | ⛔ | `refusal-text.ts` has exactly one `import`, from `./capabilities` (R1.5) | green before and after |
| L1 | + | mocked: staff, matrix false, grant false, `submit_sales_day` + storeId, `positionGrantsElsewhere` → 1 row, `getById` → SMK2 ⇒ `userMessage` === J1's sentence; `message` === `authorize: role 'staff' may not 'submit_sales_day'` | `userMessage` is the `roleMayNot` text |
| L2 | + | `positionGrantsElsewhere` called once with `{ personId, orgId: actor.orgId, capability, excludingStoreId: storeId }` | 0 calls |
| L3 | ⛔ | lookup → `[]` ⇒ `userMessage` === `roleMayNot('staff','submit_sales_day')`; `getById` not called | green before and after |
| L4 | ⛔ | lookup rejects ⇒ still `AuthorizationError`, `roleMayNot` text, `logger.warn` called once | warn 0 calls |
| L5 | ⛔ | success path (allow-all) with `positionGrantsElsewhere`/`getById` spies that THROW → resolves, neither called; the org-scoped row-5 refusal (`close_period` by staff) and the missing-storeId refusal → neither called | green before and after |
| L6 | + | census: `authorize.ts`'s row-5 `new AuthorizationError(` third argument contains `jobIsElsewhere(` AND `roleMayNot(`; `positionGrantsElsewhere(` occurs only inside a `savepointLookup(` call | no `jobIsElsewhere(` |
| I1 | + | real DB, P1 shape: `record_sale@A` → `userMessage` === `You can't record a sale at ${A.name} (${A.code}) — the Cashier job that lets you is at ${B.name} (${B.code}). Ask an admin if you need to do it here too.`; `err.message` still `/may not 'record_sale'/` | `roleMayNot` text |
| I2 | + | Cashier at A AND B, default on at B only → names B only; A appears only as `here` | `roleMayNot` text |
| I3 | + | add store C with Cashier + default on → the 2-store form; groups ordered by store name | `roleMayNot` text |
| I4 | ⛔ | the only job-store deactivated (`stores.is_active = false`) → `roleMayNot` text | green before and after |
| I5 | ⛔ | staff with no position grant anywhere → S2's exact `roleMayNot` sentence | green before and after |
| I6 | ⛔ | cross-org: org Y with store, position, and default for the same capability; superuser plants a `'position'` `person_grants` row for the org-X person with `source_ref` → Y's default; refusal at an X store → `userMessage` === `roleMayNot`, contains no Y store name/code or org name. If the DB refuses the plant, record the error verbatim and report it (a guard already exists) | green before and after; red only if a layer leaks |
| I6b | ⛔ | Call `accessRepo.positionGrantsElsewhere` directly on the superuser/BYPASSRLS fixture connection, with `orgId` = X and I6's planted row → returns `[]`. The explicit `org_id` filters are the only thing that can make it pass here. In I6, FORCED RLS on `position_capability_defaults` (`0146`) masks a missing filter, so I6 alone cannot catch that. The plant satisfies the composite FK (`0159` step 8) because its `store_id` is the store of Y's default | green after S2b; red if any explicit `org_id` filter is removed (record that mutation run) |
| I7 | ⛔ | savepoint (`authorize.test.ts`, T6b mechanism `:1092-1180`): `revoke select on positions from shareat_app`; in ONE tx, a planted DEF-430-shape refusal is caught with the `roleMayNot` text, then the same tx inserts a marker and COMMITS, and the marker is visible afterwards; negative half: a positions SELECT as `shareat_app` outside a savepoint fails (the revoke bites); grant restored in `finally` | green before (no lookup); after S2b red only as 25P02 on the marker (lookup escaped its savepoint) |

**Negative halves (unedited):** `packages/auth/tests/t343-refusal-text.test.ts` (T1), `t343-authorize-lookups.test.ts`
(T2–T4), `t343-authorize-census.test.ts` (T5), `errors-leaf.test.ts`; every existing describe in
`authorize.test.ts` (incl. T6, T6b) and `t341-position-grants-per-store.test.ts` P1–P8 (P1 keeps its `/may not
'record_sale'/`); `position-defaults.test.ts`; `tests/unit/t343-throw-ratchet.test.ts` (no throw added, `CEILINGS`
untouched); the app `/may not '<cap>'/` regex maps (`message` byte-identical). Then the **full** integration suite.
⚠️ `t343-authorize-lookups.test.ts:34-46` mocks `accessRepo` without `positionGrantsElsewhere`. A future row-5 refusal
added to that file would therefore take the warn → `roleMayNot` fallback path, and nothing would flag it. It is not
red today, because no row-5 store case exists there. It stays unedited, and L1–L6 live in their own file with the
function mocked.
Any of these red → STOP and report.
**Smoketest (9008, `docs/SMOKETEST.md`):** sign in as the T-341 smoketest staff member (Staff role, Cashier at
SmokeStore). Sales days → New → switch to SmokeStore Two (SMK2) → Save draft. The banner should read exactly
`Refused: You can't submit a sales day at SmokeStore Two (SMK2) — the Cashier job that lets you is at SmokeStore (SMK).
Ask an admin if you need to do it here too.` Then check the control at SmokeStore (SMK): it is not refused on this
ground. Then a staff member with no position shows the S2 sentence unchanged. Screenshot both themes beside
`t341-smk2-refusal.png`.

---

### S5a: auth roles and credentials (row 15), after S2b
`AuthorizationError` already takes `userMessage` (S2). `roles.ts` and `credentials-admin.ts` import `refuse` and
`goneSentence` from `@shareat/db` themselves; `refusal-text.ts` gains no import and stays pure (R1.5).
- `roles.ts:367,586` · `credentials-admin.ts:45` → third arg `goneSentence('person')`.
- `roles.ts:393` → `Only a super admin can make someone ${ROLE_LABEL[input.role]}. Your role is ${actorRole ? ROLE_LABEL[actorRole.role] : 'none'}.`
  (R4.3: `actorRole` and `targetRole` are rows from `activeRoleForPerson` (`roles.ts:388-389`), not `Role` strings — the
  label reads `.role`, i.e. `ROLE_LABEL[actorRole?.role]` with the `'none'` fallback when there is no row.)
- `roles.ts:447` → `This person is ${ROLE_LABEL[targetRole.role]}, which outranks you, so you can't change their role.` (R4.3; `targetRole` is non-null inside the `if (targetRole)` at `:435`)
- `roles.ts:577` → `refuse(raw, "That isn't a permission this system knows.")` (R1.5).
- id-free `AuthorizationError`s (`roles.ts:346,376,494,570,592`, `credentials-admin.ts:261`) → third arg, rule 4.
- `credentials-admin.ts:67,69,75,78,189,211` → `refuse(raw, <same sentence>)` (already written for a person) (R1.5).
Sentences live in `packages/auth/src/refusal-text.ts`. ⛔ `errors.ts` untouched (Invariant 7); `capabilities.ts` read only.
**BUILDER:** `packages/auth/src/{roles.ts,credentials-admin.ts,refusal-text.ts}` — source only (R4.4).
**TESTER:** `packages/auth/tests/t343-s5a-census.test.ts` (new); `packages/auth/tests/integration/roles.test.ts` (new `describe` only);
the ratchet's `packages/auth/src` `CEILINGS` entry (R1.2), lowered after the builder's READY to the count measured at
HEAD + the builder's change (R4.4 — the builder never edits a test file).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| K1 | + | census: `auth/src` has 0 raw `throw new Error(`; every `new AuthorizationError(` has 3 args; no id/key/derived first argument on any `throw new <X>(` (R1.2), EXCEPT an allowlist of raw messages K4/Invariant 1 pin byte-identical. (R4.2) The allowlist is sized by MEASUREMENT: before writing K1 the tester runs the S5.0 scanner over `packages/auth/src` and lists every id/key/derived first argument; each hit is either converted or allowlisted. Known today: `roles.ts:367,393,447,586` and `credentials-admin.ts:45` (`person ${personId} does not exist in org ${actor.orgId}`) — five, not four; the measurement, not this list, decides. Each entry is keyed by its raw message TEXT (never file:line; S5a edits lines around them), carries a one-line reason citing K4/Invariant 1, and is exempt from the first-argument rule only; the 3-arg rule still applies to every entry, which is what keeps the exemption safe, and the test says so (R2 ruling 1); no `new RefusalError(` (R1.5) | red: 7 raw, 11 two-arg |
| K2 | + | an admin assigning `super_admin` → `userMessage` contains `Super admin`, not `'super_admin'` | undefined |
| K3 | + | assigning a role to a missing person → `/^That person could not be found\./`, no UUID | undefined |
| K4 | ⛔ | K2/K3 `err.message` byte-identical to today; `roles.test.ts` case 6 (the DEF-177 absence) green unedited | green before and after |

> (R2 ruling 1 is folded into K1 above: the raw messages K4/Invariant 1 pin are allowlisted by text; R4.2 sizes the
> list by measurement. R4.5: this note moved out of the table so K2–K4 render inside it.)

---

### S5.2: AP, customers, and the repo sites S3 missed (rows 9, 14b)
Scope: `packages/domain/src/ap/index.ts` (39), `packages/domain/src/customers/index.ts` (11), and
`packages/db/src/repo/ap.ts:431,437,443` → `refuse(raw, …)` (R1.5), the invoice named `${inv}` below:
`${Inv} has been voided, so nothing more can be recorded against it.` · `${Inv} hasn't been verified yet, so this can't
post against it.` · `${Inv} has only ₱${remaining} left of ₱${total}; ₱${amount} doesn't fit.` (R4.6)
`supplier_invoices.invoice_no` is **nullable** (`packages/db/schema/suppliers.ts:208`), so `${inv}` follows rule 2:
`invoice ${invoiceNo} from ${supplierName}` when a number exists, else the no-number fallback
`the ${humanDate(invoiceDate)} invoice from ${supplierName}` (`${Inv}` = the same, capitalised). Names come from the
`capacity` row: `capacityOf` (`packages/db/src/repo/ap.ts:371-398`) is extended **in the same query** with
`si.invoice_no`, `si.invoice_date` and the supplier's name (a join to `suppliers` on `si.supplier_id`, same org; added to
the `group by`) — no new query. `InvoiceCapacity` gains the three fields additively; the other caller
`apps/erp/src/app/ap/lib.ts:85` is unaffected. Not-found → `gone`;
`ap/index.ts:747,754,756` name the expense by its human key (one refusal-path read). (R4.7) That read is **org-scoped**
(`actor.orgId`, rule 7 / Invariant 6): an `expenseId` that is not an expense of the caller's org yields no row, and the
sentence falls back to the deictic `this expense` — never a name from another org. `:918`, `:1010`, `:1022` →
`internalFault` (states the caller cannot produce).
**BUILDER:** those three source files — source only (R4.4). **TESTER:** the ratchet's `ap`, `customers` and
`packages/db/src/repo` `CEILINGS` entries (R1.2), lowered after the builder's READY to the count measured at HEAD + the
builder's change (R4.4); census `CONVERTED_DIRS += ap, customers`; the db
census empties `PENDING_S5_2`; `packages/domain/tests/integration/ap.test.ts` (new `describe` only).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| P1 | + | census: 0 raw in `ap/`, `customers/`; `PENDING_S5_2` empty; no id/key/derived first argument on any `throw new <X>(` (R1.2); no `new RefusalError(` (R1.5) | red: 50 + 3 |
| P2 | + | an expense against a voided invoice → names `invoiceNo` and the supplier, no UUID; the same against a voided invoice with **no** `invoice_no` → `the ${humanDate} invoice from ${supplierName}`, never `invoice null` (R4.6) | undefined |
| P3 | + | `recordPayment` over-allocating one expense → names it as `"particulars" (date)` | undefined |
| P4 | ⛔ | P2/P3 messages match today's regexes; `ap-aging`, `ap-auto-allocate`, `supplier-master`, `supplier-returns` green unedited | green |

### S5.3: deliveries, catalogue, opening balances (rows 13, 14a, 16)
Scope: `deliveries/documents.ts` (10; `:126`, `:129` → `Line ${n}: …` by position; `:115` → `gone(raw, 'proof photo')`),
`commissary/catalogue.ts` (16; stores as `Name (CODE)`, items by name), `cutover/opening.ts` (9; `:164` →
`gone(raw, 'opening figure')`).

**`commissary/catalogue.ts` sites (R4.9)** — each read at HEAD `bf6741c`; rule 4 keeps the wording minus the
`fnName:` prefix and any T-/bible citation:
| Site | Becomes |
|---|---|
| `:50` `parseFourDecimalCost` | rule 4: `${label} — "${raw}" is not a valid amount. Use a non-negative number with up to four decimal places.` (also reached from `deliveries/documents.ts`; one sentence for both) |
| `:100` | rule 4: `A store cannot supply itself — the commissary and the branch must be two different stores.` |
| `:113` · `:116` | `gone(raw, 'commissary store')` · `gone(raw, 'branch store')` |
| `:172` · `:239` · `:245` | `gone(raw, 'item')` · `gone(raw, 'commissary item')` · `gone(raw, 'branch item')` |
| `:174` · `:177` | rule 4, item by name: `${item.name} is ${item.status}, not active — only an active item can be offered.` · `${item.name} is not marked purchasable, so this commissary cannot supply it.` |
| `:184` | rule 4: `"${input.manualCost}" is not a manual cost — a non-negative amount, up to four decimals.` (`refuse` sanitises the typed value) |
| `:232` | rule 2, stores as `Name (CODE)`: `${branch} has no active link to ${commissary} — link the two stores before mapping an item between them.` (the `(T-171)` citation dropped). One refusal-path, org-scoped read of both stores (rule 6/7); on any failure `This branch` / `that commissary`. Builder reports whether `upsertMap` is a probe caller (rule 6) |
| `:241` · `:247` | rule 4: `${commissaryItem.name} is ${commissaryItem.status}, not active.` · the same for `branchItem` |
| `:253` | rule 4, items by name (already): `${commissaryItem.name} is measured in … Nothing here guesses a conversion.` |
| `:263` · `:289` | `gone(raw, 'expense category')` · `gone(raw, 'item mapping')` |

**BUILDER:** those three files — source only (R4.4). **TESTER:** (R4.8) `CONVERTED_DIRS` holds whole directories and D1
requires 0 raw per directory, but `deliveries/`, `commissary/` and `cutover/` keep unconverted siblings
(`deliveries/receive.ts` 1, `commissary/fulfilment.ts` 16, `commissary/orders.ts` 32, `cutover/index.ts` 4 — S5.5+). So
S5.3 does **not** append to `CONVERTED_DIRS`; it adds a per-file list `CONVERTED_FILES = ['deliveries/documents.ts',
'commissary/catalogue.ts', 'cutover/opening.ts']` that the census checks for 0 raw `throw new Error(` and the same
first-argument / `refuse`-argument / `new RefusalError(` rules as D1, and counts toward D2's floor. The ratchet's
`deliveries`, `commissary` and `cutover` `CEILINGS` entries (R1.2) are lowered, after the builder's READY, by the
measured count of the three files' conversions only (R4.4, R4.8) — the siblings' raw throws stay in those entries. One
integration leg per file (new `describe` in the nearest existing file) + a ⛔ message-regex leg. The census also fails
on an id/key/derived first argument to any `throw new <X>(` (R1.2) and on `new RefusalError(` (R1.5). Red: 35 raw.

### S5.4: commissary Outcome reasons (rows 10, 11), after S6
`Outcome`'s failure arm already has optional `userReason?: string` from S5.1b; S5.4 reuses it (R1.1). Every `reason:` in
`transfer.ts`/`discrepancy.ts` sets it: item kinds and dispositions through S6's labels, the `short` list by item
**name** (one refusal-path read of the listed ids), discrepancies deictically. Apps render through S5.1b's
`outcomeMessage(result)` (R1.1) at S5.4's own `commissary/**/actions.ts` sites (`discrepancies/actions.ts:59,87`).
S5.4 does **not** touch `orders/[id]/actions.ts:106` — S5.1b alone owns it, and S8 does not list it (R1.1). **TESTER:** census
in the scanner's `reason:` mode over the two files (red: ≈16 id/key/derived reasons, R1.3); it also fails on
`new RefusalError(` (R1.5); one integration leg each for transfer and discrepancy; ⛔ `reason` byte-identical.

### Invariants (S5, in addition to 1–11)
12. One `RefusalError` class; `recordGone` and `gone` share `goneSentence`, defined beside it in
    `packages/db/src/refusal.ts`; production code never writes `new RefusalError(` (R1.5).
13. `internalFault` never carries a `userMessage`; it is only for states no user input can produce.
14. No S5 group edits a file owned by T-344/T-345/T-346 until that task lands.
15. The ratchet only falls; every drop is the group's own measured count, per directory (R1.2).

### Done when (per group)
As "Done when (per slice)" above, plus: the census lists the group's dirs and goes red→green with the raw list
recorded; the group's own directories' `CEILINGS` entries lowered to the measured count, and `ALLOWANCE_UNTIL_T346`
removed by the first commit after T-346 lands (R1.2); the group's highest-traffic refusal smoketested on 9008. After S5.4,
DEF-417 part 2 rows 7–16 are stamped FIXED; the ≈180-site remainder stays open under S5.5+.

### S5 Amendment R1 — spec review (2026-09-25), binding
Independent Opus review returned CHANGES. Where this amendment and the S5 body differ, this wins.

1. **(HIGH) The fifth bypass was mis-traced.** `apps/erp/src/app/commissary/orders/[id]/actions.ts:106` shows
   `result.reason` from `postMessageAction` (`:67`) → `postOrderMessage`, whose id-bearing reason is
   `packages/domain/src/commissary/messages.ts:40` (`order ${input.orderId} does not exist`), not
   transfer/discrepancy. (R4.1: `:61` carries the same reason but is in `listOrderMessages` (`:56`) and does not reach
   `:106`; it still converts below.) New group **S5.1b: commissary order messages**. It does not wait on S6 and runs any time after S5.0.
   It **alone owns `:106`**: S8 does not list it, and S5.4 does not touch it.
   - `Outcome`'s failure arm gains optional `userReason?: string` here (`commissary/outcome.ts`); S5.4 reuses it.
   - `messages.ts:40,61` → `userReason` = `goneSentence('order')`. Id-free reasons (`:34,36,47,64`) → `userReason` =
     the same sentence, capitalised, ending `.`.
   - `apps/erp/src/lib/constraint-messages.ts` gains `outcomeMessage(result)` =
     `errorMessage(Object.assign(new Error(result.reason), result.userReason ? { userMessage: result.userReason } : {}))`,
     so both arms pass the S1 gate. `:106` uses it; S5.4's three sites use it later.
   - **BUILDER:** `packages/domain/src/commissary/{outcome.ts,messages.ts}`, `apps/erp/src/lib/constraint-messages.ts`,
     `apps/erp/src/app/commissary/orders/[id]/actions.ts`.
   - **TESTER:** `packages/domain/tests/integration/t343-s5-commissary-messages.test.ts` (new),
     `apps/erp/tests/t343-s5-outcome-message.test.ts` (new).
   - Legs: M1 (+) post to a missing order → `userReason` `/^That order could not be found\./`, no UUID (red: undefined).
     M2 (⛔) `reason` byte-identical to today; `low-stock.test.ts` green unedited. M3 (+) `outcomeMessage({ ok:false,
     reason: \`order ${U} does not exist\` })` has no UUID (red: function missing). M4 (+) the `postMessageAction`
     guard, as in R7, decodes to M1's sentence (red: contains `U`).
   - Order: S5.0 → S5.1 → **S5.1b** → S2b/S5a … as before.
2. **(HIGH) The ratchet becomes per-directory and measured.** At S5.0, `t343-throw-ratchet.test.ts` replaces the single
   `CEILING` with `CEILINGS: Record<dir, number>`, one per top-level directory under `packages/domain/src`, plus
   `packages/auth/src` and `packages/db/src/repo`. Each is set to the count measured at the S5.0 commit (total today:
   702). **Stated allowance:** `+10` each on `missed-months`, `fixed-assets`, `stores`, `ledger` (the T-345/T-346
   dirs), named as `ALLOWANCE_UNTIL_T346` in the file. The first commit after T-346 lands removes it, re-measuring those
   four. No other slack anywhere. A new directory with no entry fails. Each group lowers its own directories to the
   measured count. **D1 (and K1, P1, and the S5.3/S5.4 census) additionally fail on any `throw new <X>(` of any class in
   a converted directory whose message argument (first argument) classifies as id, key or derived** (item 3).
   `SalesDayBlockedError`/`TransitShortfallBlockedError` (`sales-days/create.ts:135,157`) classify plain today: the id
   travels as the second argument, which is correct. The ratchet rule and "Done when" in the body are superseded by this item.
3. **(MEDIUM) Ids collected into a list and joined later.** The scanner gains a third outcome, **derived**: an operand
   that is a `.join(…)` call, a `.message` access, or `String(<non-literal>)`. Derived counts as needing
   classification: it fails the census unless the site is in an allowlist with a one-line reason (e.g. the rule-5
   rewrap, which reads `userMessage`, not `.message`). W1 gains two fixtures: **(6)** `short.push(\`${line.itemId} …\`)`
   then `reason: \`…${short.join(', ')}\`` (the `commissary/transfer.ts:170,174,178` shape) → flagged derived;
   **(7)** `\`x: ${err.message}\`` (the `expenses/categories.ts:138` shape) → flagged derived. W1 expects 5 id + 2 derived.
4. **(MEDIUM) `refuse` sanitises; it does not throw on free text.** Sentences interpolate particulars, invoice numbers
   and names. `refuse(raw, sentence)` collapses every whitespace run (newlines included) to one space, trims, and
   replaces each UUID with `[hidden]` (the S1 token). It throws only when the result is empty (possible only with an
   empty literal; test-caught). The UUID regex lives in `packages/db/src/refusal.ts`. `apps/erp/src/lib/error-shape.ts`
   keeps its leaf copy, and a parity test pins the two `.source` strings equal. **F4 is replaced:** `refuse(raw, 'a\n  b')`
   → `userMessage === 'a b'`; `refuse(raw, \`x ${U}\`)` → `'x [hidden]'`; `refuse(raw, '  ')` throws. **New F6:** an
   expense whose particulars are `"Rice\n sack"` and an invoice number containing `U` render as one line with
   `[hidden]` through the S5.1 `create.ts:146` sentence. **New F7** (`apps/erp/tests/t343-s5-uuid-shape-parity.test.ts`,
   TESTER): `UUID_SHAPE.source` equals the db copy.
5. **(LOW) `refuse` lives with the class, and `refusal-text.ts` stays pure.** `refuse`, `goneSentence` and
   `RefusalError` are all defined in `packages/db/src/refusal.ts`, re-parenting `record-gone.ts`'s
   `goneSentence` there. `packages/domain/src/shared/refusal.ts` re-exports `refuse` and adds `gone`,
   `internalFault`, `humanDate`. In S5a, `roles.ts` and `credentials-admin.ts` import `refuse`/`goneSentence` from
   `@shareat/db` themselves. `packages/auth/src/refusal-text.ts` gains no import (it stays pure, like S2's). **Constructing
   `RefusalError` directly is test-only:** production code calls `refuse`/`gone`/`recordGone`. Every census (D1, K1, P1,
   S5.3, S5.4) fails on `new RefusalError(` outside `packages/db/src/refusal.ts` and `record-gone.ts`. S5a's two
   `new RefusalError(raw, …)` bullets read `refuse(raw, …)`.

## Amendment R2 — S5 fold (2026-09-26)
S5 Amendment R1 was binding but never folded into the S5 body. Each R1 item is now folded in place, tagged `(R1.n)`;
R1 stays above as the record. Lines are as of this amendment.

| R1 item | Folded at |
|---|---|
| R1.1 S5.1b | evidence `:319` (`:106` mis-traced); groups table row `:391`; new stub section `:490`; S5.4 body `:555-561` (reuses `userReason`/`outcomeMessage`, does not touch `:106`) |
| R1.2 per-directory `CEILINGS` | ratchet rule `:400-406`; S5.0 TESTER path `:417`; S5.1 BUILDER `:466`; S5a BUILDER `:508-509`; S5.2 BUILDER `:534-535`; S5.3 BUILDER `:548-549`; first-argument rule in D1 `:473`, K1 `:514`, P1 `:540`, S5.3 `:551`; Invariant 15 `:568`; Done when `:572-573`; S5.0 negative halves no longer list the ratchet test |
| R1.2 `ALLOWANCE_UNTIL_T346` note | `:407-408` (T-346 S1 = `1ac1bca`; builder checks `git log --oneline --grep "T-346"` first) |
| R1.3 derived | scanner paragraph `:380-382`; W1 7 shapes, 5 id + 2 derived `:422`; S5.4 census `:560` |
| R1.4 `refuse` sanitises | Design `:351-355`; UUID regex home `:338`; F4 replaced `:429`; F7 `:431` + TESTER path `:418`; F6 `:482` |
| R1.5 `refuse(raw, …)` / re-parent | Design `:335-343`; S5a import line `:499-500`, `:504`, `:506`; S5.2 `ap.ts` `:528`; `new RefusalError(` census in D1, K1, P1, S5.3 `:551`, S5.4 `:561`; Invariant 12 `:564-565` |

**Open, not settled by R1 (planner ruling needed):**
1. R1.2's first-argument rule on K1 contradicts K4/Invariant 1 at `roles.ts:367,393,447,586` (see the note at `:516`).
2. R1.1 says "S5.4's three sites"; with `:106` moved to S5.1b, the evidence names only two (`discrepancies/actions.ts:59,87`).
3. R1.4 names F6 but not its group; it is placed in S5.1 (`:482`) because the `create.ts:146` sentence lands there.

### R2 rulings (orchestrator, 2026-09-26)
- **roles.ts:367,393,447,586 vs K1:** K4 and Invariant 1 win. Those four raw messages stay byte-identical; K1's census carries them as an explicit allowlist, each entry citing K4/Invariant 1 as the reason. ~~No other allowlist entry is added.~~ (Superseded by R4.2: the allowlist is sized by measurement; `credentials-admin.ts:45` is a fifth known entry.)
- **S5.4's sites:** two, `discrepancies/actions.ts:59,87`; `:106` belongs to S5.1b. R1.1's "three" is superseded.
- **F6:** S5.1, where `create.ts:146`'s sentence lands. Accepted.
- **Ruling 1 refined (auditor):** the allowlist is keyed by the raw message text, never file:line, and exempts only the first-argument rule.
- **CEILINGS measurement (auditor, 2026-09-26):** measured from the `HEAD` the group commits on top of — re-measured immediately before committing — never the working tree, and S5.0 commits only after T-346 S3 has committed. The barrel export lines for S5.0 (`packages/db/src/index.ts`, `packages/domain/src/index.ts`) are added by the orchestrator after T-346 S3 commits, so no commit carries another lane's hunks.
- **S5.0 baseline entries (orchestrator, 2026-09-26):** `humanDate` and `internalFault` ship in S5.0 with no production caller; `docs/production-caller-baseline.txt` was regenerated to carry them. **S5.1 gives both their first caller and regenerates the baseline without them** — S5.1 is not done while either name is still in it.
- **Forward note for S5a (auditor, S5.0 review):** ruling 1 allowlists FOUR `roles.ts` raw messages, but that is a prediction; the evidence counts 11 two-arg `AuthorizationError` sites in `packages/auth/src`. S5a MEASURES how many classify id/key/derived with the S5.0 scanner BEFORE writing K1, and sizes the allowlist from that measurement (each entry still keyed by text and justified by K4/Invariant 1, or converted). **Folded into K1 by R4.2.**
- **CEILINGS edits belong to the TESTER (orchestrator, 2026-09-26):** where a group lists the ratchet's `CEILINGS` lines under BUILDER, the tester makes that edit instead, after the builder's READY, lowering each named entry to the count measured at HEAD + the builder's change. The builder never edits a test file. **Folded into the S5.1, S5a, S5.2 and S5.3 BUILDER/TESTER lines by R4.4.**
- **Ratchet keys and other lanes (orchestrator, 2026-09-26, S5.1 review):** `packages/db/src/*` counts LOOSE files at that root only (today `refusal.ts`, 1). Each subdirectory of `packages/db/src` other than `repo/` is its own key; `packages/db/src/cutover` is added by T-347's tester at T-347's commit, at the measured count. A key never absorbs another lane's new directory, so no ceiling is ever raised.

## Amendment R4 — body-vs-amendment audit (2026-09-26)
Orchestrator rulings, each verified by an independent auditor at HEAD `bf6741c` and re-read by the planner; folded in
place, tagged `(R4.n)`. Renumbered from "R3" by the orchestrator (2026-09-26), because "Amendment R3" is already the
S1+S2 code review above. That review is cited as "R3 item n", and by S2b as `R3.2`/`R3.6`. Every `(R4.n)` tag in the
S5 sections and at `:57,259,268` belongs to THIS amendment. `### S2b` was not touched. Line numbers are as of this
amendment, before S2b's review fold shifted them.

| Item | Folded at |
|---|---|
| R4.1 `messages.ts:61` is in `listOrderMessages` (`:56`); only `:40` reaches `:106` | evidence `:319-321`; S5.1b stub `:494-498`; R1.1 item 1 `:738-742` |
| R4.2 K1 allowlist sized by measurement; `credentials-admin.ts:45` a fifth entry | K1 `:644`; blockquote `:649-650`; R2 ruling 1 struck through `:812`; forward note marked folded `:818` |
| R4.3 `ROLE_LABEL[actorRole?.role]` / `ROLE_LABEL[targetRole.role]` | S5a bullets `:629-632` |
| R4.4 `CEILINGS` edits move from BUILDER to TESTER | S5.1 `:466-470`; S5a `:637-640`; S5.2 `:670-672`; S5.3 `:702-709`; R2 ruling marked folded `:819` |
| R4.5 blockquote moved out of the K table | `:648-650` (after K4) |
| R4.6 `invoice_no` nullable → rule-2 no-number fallback; `capacityOf` extended in the same query | S5.2 scope `:655-665`; P2 `:678` |
| R4.7 `ap/index.ts:747` lookup org-scoped, deictic fallback | S5.2 `:666-668` |
| R4.8 `CONVERTED_FILES` for the three S5.3 files; siblings stay S5.5+; ratchet lowered by measured count only | S5.3 TESTER `:702-709` |
| R4.9 `commissary/catalogue.ts` site table (16 throws) | S5.3 `:687-700` |
| R4.10 `canBypassBlock` is `sales-days/create.ts:284` | `:57`, `:259`, `:268` (S2b's `:284-291` citation was already correct) |

### R4 rulings (orchestrator, 2026-09-27, S5.1b audit)
- **S5.1b app guards (auditor HIGH):** `commissary/orders/[id]/actions.ts:75` (order missing/voided) and `:93` (not a party) refuse BEFORE `postOrderMessage`, so the domain's `goneSentence('order')` never reached `:106`. Ruling (option a): the action sets `userReason` on both arms — `:75` → `goneSentence('order')`, `:93` → `Only the two stores on this order can talk about it.` The guards stay (they avoid a domain call). New legs M5/M6 (through the real arms), M7 (the id-free `userReason`s); M4 carries an explicit timeout.
- **/code-review in a shared tree:** the auditor does not plant into uncommitted shared work; it runs `/code-review` on each slice's commit afterwards, and its manual diff read is the pre-commit audit. A post-commit finding becomes a follow-up, not a revert.
- **S5.2 typing (auditor, 2026-09-27):** `InvoiceCapacity` gains `invoiceNo: string | null`, `invoiceDate: BusinessDate` (parsed with `parseBusinessDate` inside `capacityOf`, never a bare `as BusinessDate` cast) and `supplierName: string`. Only the supplier name needs adding to the `group by`.
- **S5a K1 scope (tester, 2026-09-27, accepted):** K1's first-argument rule applies to `roles.ts` and `credentials-admin.ts` only. `authorize.ts`'s raw diagnostics are id/key-shaped by design (`may not 'record_sale'`), every one already carries a `userMessage` third argument, and T5's census covers them. The 3-arg and 0-raw-`Error` rules still span all of `packages/auth/src`. Measured allowlist: 5 (`roles.ts:367,393,447,586`, `credentials-admin.ts:45`), keyed by text.
- **S5.3 parseFourDecimalCost (builder QUESTION, 2026-09-27):** its only caller (`deliveries/documents.ts:140`) passes an id-bearing label. It gains a separate `humanLabel` argument (`Line ${n}: the unit cost`); the raw `label` and message stay byte-identical (Invariant 1).

### S5.3b rulings (orchestrator, 2026-09-27, post-commit review of 1c00abd + S5.1d audit)
- **Receipt reasons (regression):** S5.3's `documents.ts:362` fallback replaced three already-readable `receive.ts` reasons with "…Reload the page and try again.", which is wrong advice for a draft. Ruling (ii): `packages/domain/src/deliveries/receive.ts`'s four `Outcome` reasons gain `userReason` now (id-free sentence; the COA-ALIGNMENT citation and quoted kind key dropped from the sentence, raw byte-identical); `documents.ts` already prefers `userReason`.
- **`parseMoneyInput`** (`shared/money-input.ts`) gains the same raw/human label split as `parseFourDecimalCost`; `cutover/opening.ts:72` passes `This amount`/`The amount` as the human label.
- **Line numbering:** "Line n" names the operator's VISIBLE form row. `apps/erp/src/app/inventory/deliveries/actions.ts` numbers rows before it drops empty ones and passes `lineNo` on each line; the domain uses `line.lineNo ?? i + 1`.
- **Proof photo:** the better local sentence moves into the domain (`refuse(raw, "That photo could not be found — try attaching it again.")` at `documents.ts:115`), and the now-dead local branch in `inventory/deliveries/actions.ts` is deleted.
- **S5.1d X1** (raw-text source scan) is dropped: it pinned spelling, not behaviour, and shaped comments. The behavioural W/S/D/L legs are the guard.

---

## S6: every enum key a person can see is shown as a label (rows 10, 11 precondition; DEF-431)

**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; S6 amendments folded). Replaces the S6/S6b one-liners under "Later slices". **Model:** Sonnet, tester
then builder, per slice. **Migration:** none (constants and pure functions beside existing enums; no column, check,
index or policy changes, so the ADR-012 checklist is not triggered).

**Goal.** No screen shows an internal key (`record_sale`, `meat_slab`, `late_receipt`, `damage_storage`,
`super_admin`) or its underscore-stripped form as visible text. Each is shown as a human label from one static map
beside its enum. S5.4 can then name item kinds and dispositions in refusals from the same maps.

### S6 evidence (planner, HEAD `567a564`, every line re-read)
- **Labels that already exist:** `ROLE_LABEL` (`packages/auth/src/capabilities.ts:1039`) and `CAPABILITY_LABEL`
  (`:1054`, all 96, lower-case "you can't …" phrases), both exported from `@shareat/auth` (`packages/auth/src/index.ts:19-20`).
  Their only readers are `refusal-text.ts` and `roles.ts`. **No app file imports either.** `capabilities.ts` has no imports.
- **Enums with no label:** `ITEM_KINDS` (`packages/db/schema/items.ts:47`), `DISCREPANCY_DISPOSITIONS`
  (`packages/db/schema/trade-discrepancies.ts:37`), `ORDER_WASTAGE_DISPOSITIONS` (`packages/db/schema/order-wastage.ts:60`),
  `WASTAGE_REASONS` (`packages/domain/src/stock/wastage-reasons.ts:18`, a leaf with no imports).
  `@shareat/db` exports `ITEM_KINDS` (`packages/db/src/index.ts:246`) and `ORDER_WASTAGE_DISPOSITIONS` (`:271`), but not
  `DISCREPANCY_DISPOSITIONS`. `packages/domain/src/index.ts:58` re-exports `wastage-reasons` whole.
- **S5.4's inputs:** `commissary/transfer.ts:118` types `itemKind` as `string`, and `:160-166` refuses exactly when the
  kind has no account. `INVENTORY_ACCOUNT_BY_ITEM_KIND` (`stock/receipt-posting.ts:63-71`) also maps `prepped`, which is
  **not** in `ITEM_KINDS`. So an item-kind label lookup must take a `string` and must not fail on a value outside the
  enum. `commissary/discrepancy.ts:36` declares its own `Disposition` union, equal to `DISCREPANCY_DISPOSITIONS`.
- **Raw keys on screen today** (the one-liner named the first four; the planner found the rest):

  | Site | Shows |
  |---|---|
  | `apps/erp/src/app/admin/access-defaults/grid.tsx:211`, `:319` | `{cell.capability}` in `font-mono` (desktop, mobile) |
  | `admin/users/page.tsx:75`; `admin/users/[personId]/page.tsx:78`, `:118` | `role.replace(/_/g, ' ')` |
  | `admin/users/[personId]/page.tsx:190` (held), `:266` (revoked), `:448` (picker) | `g.grantName` / `c` in `font-mono` (DEF-431) |
  | `admin/users/actions.ts:241-243` | ok banner `Granted ${capabilities[0]}.` / `…: ${capabilities.join(', ')}.` (raw keys) |
  | `admin/users/[personId]/page.tsx:242-245` | "Already held … — now held in their own right." before anyone clicks (DEF-431) |
  | `items/page.tsx:130`, `:181`, `:217` (+ local `KINDS` copy at `:19`); `items/[id]/page.tsx:62` | `kind.replace(/_/g, ' ')` |
  | `inventory/usage/page.tsx:139`; `inventory/usage/[id]/page.tsx:54`; `inventory/usage/NewUsageForm.tsx:119` | `reasonCode.replace(/_/g, ' ')` |
  | `commissary/discrepancies/page.tsx:137`, `:151` | `{row.disposition}` raw (e.g. `late_receipt`) |
  | `wastage/page.tsx:289`; `:196` | `{w.disposition}` raw (`platform_paid`); prose `<code>charged</code>` |
- **The client boundary.** Of these files only `inventory/usage/NewUsageForm.tsx` is `'use client'`. It gets `reasons` as a
  prop from `inventory/usage/page.tsx:105`. `tests/unit/client-bundle-boundary.test.ts` (T-266) forbids `@shareat/db` and
  the bare `@shareat/domain` barrel in a client file. **It does not cover the `@shareat/auth` barrel**, which reaches
  `@shareat/db` through `authorize.ts`'s repo imports. A client file importing `ROLE_LABEL` from `@shareat/auth` would pass
  every fast gate and fail only at `next build`. This is a gap in the guard; S6a closes it.
- **DEF-431's success signal.** `setCapabilityGrantAction` (`admin/users/actions.ts:180-248`) runs every grant in one
  tx and redirects with `ok`/`error` (`backToUser`, `:110`). The "Hold in their own right" form (`[personId]/page.tsx:235-246`)
  posts the same action with one hidden `capability`. Today the action cannot tell that submission apart from a picker grant.
  The row's provenance (`positionProvenanceLine`, `:192`) is already shown beside the capability name, so the pre-click
  sentence adds no information.
- **Existing guards these slices must keep green:** `apps/erp/tests/t337-access-defaults-grid-render.test.ts` (form
  multiset oracle: hidden `capability` values), `access-defaults-lib.test.ts`, `admin-users-lib.test.ts`,
  `local-errormessage-convergence.test.ts`, `action-link-sweep.test.ts` (holds the touch-target check against the
  multiset `touch-target-baseline.json`; no control enters or leaves), `packages/auth/tests/t343-refusal-text.test.ts` (T1: labels lower-case,
  no `_`), `tests/unit/production-caller-ratchet.test.ts`.

### S6 design (decided here)
1. **Where labels live: beside their enum, as an exhaustive `Readonly<Record<Enum, string>>` plus a total lookup
   function.** A new enum value with no label then fails typecheck. The files: `ITEM_KIND_LABEL` in `schema/items.ts`,
   `DISCREPANCY_DISPOSITION_LABEL` in `schema/trade-discrepancies.ts`, `ORDER_WASTAGE_DISPOSITION_LABEL` in
   `schema/order-wastage.ts` (all exported from `@shareat/db`), and `WASTAGE_REASON_LABEL` in `domain/src/stock/wastage-reasons.ts`.
   Capability and role labels stay where S2 put them. Precedent: `BRANCH_ORDER_STAGE_LABEL` (`commissary/orders.ts:65`).
2. **Lookup functions take `string`, never throw, and never echo an underscore.** `itemKindLabel`,
   `discrepancyDispositionLabel`, `orderWastageDispositionLabel` and `wastageReasonLabel` are each
   `Object.hasOwn(MAP, v) ? MAP[v] : humanise(v)`, where `humanise` replaces `_` with a space and upper-cases the first
   character. A value outside the enum (`prepped`, a v1 code the ETL carried) renders as today's screens render it,
   capitalised. `Object.hasOwn` is used so `'constructor'` never returns a prototype member. **`humanise` is never
   exported**: each file that needs it (the three schema files, `wastage-reasons.ts`, `capabilities.ts`) keeps its own
   private two-line copy. No shared helper file is added.
   `capabilityTitle(name: string)` has its own rule: when `name` is a known capability (`Object.hasOwn(CAPABILITY_LABEL,
   name)`), it is `CAPABILITY_LABEL[name]` with its first character upper-cased (`record a sale` → `Record a sale`);
   otherwise it is `humanise(name)` (`retired_power` → `Retired power`).
3. **Label form.** A sentence-case noun phrase for a cell, badge or option. In a sentence the caller lower-cases it,
   as `commissary/orders.ts:422` does with `BRANCH_ORDER_STAGE_LABEL[stage].toLowerCase()`. That is how S5.4 will use
   `itemKindLabel` and `discrepancyDispositionLabel`. `CAPABILITY_LABEL` stays lower-case, because S2's `roleMayNot`
   completes "you can't …" with it. `capabilityTitle` (rule 2) is the capitalised form, for lists and banners.
4. **Client components never import a label module.** The server page resolves the label strings and passes them as
   props. `NewUsageForm` gets `readonly { value: string; label: string }[]`. S6a adds the missing `@shareat/auth` barrel
   rule to the T-266 guard, so a future client import fails the fast gate, not the build.
5. **The key stays the contract; only the visible text changes.** Hidden inputs, `<option value>`, URL params (`cap=`)
   and every write keep the raw key. **Capability screens only** (`/admin/access-defaults`, `/admin/users/[personId]`
   held rows, revoked rows and the grant picker): the label is primary text, and the raw key is shown under it as small
   muted grey text (`block font-mono text-[11px] text-neutral-500 dark:text-neutral-400`), so an admin can match it to
   `CAPABILITY-MATRIX.md` (Ian, 2026-09-27; DEF-431 "key as secondary text at most"). Nowhere else is a key visible:
   roles, item kinds, dispositions and wastage reasons show the label only.
6. **Scanner:** S6 does **not** extend `tests/unit/lib/throw-census.ts`. S6 changes no throw and no `reason:`. The keys it
   fixes are JSX text, and the S5.3b ruling on X1 rejects raw-text source scans as the guard. S6's guards are rendered-markup
   legs. S5.4's `reason:`-mode census is where the `key` classifier bites next.
7. **DEF-453's rule.** A refusal or label lookup may name only records the actor is entitled to see at this store. S6 adds
   **no** record lookup on any path. Every label is a static map. The only record names S6b shows (position and store
   in `positionProvenanceLine`) are already on the screen today, from `userDetail(actor.orgId, …)`. The new success
   banner names only the capability label, and nothing from the target person's rows.

### Order
**Strictly serial: S6a → S6b → S6c → S5.4, one tester and one builder** (orchestrator ruling, 2026-09-27). S6a is the only
slice that edits packages. It also touches the shared `@shareat/db` barrel, so if another lane's hunk is in
`packages/db/src/index.ts` the orchestrator adds S6a's export lines (the S5.0 precedent, R2 rulings). S6b edits only
`apps/erp/src/app/admin/users/**`; S6c only the other screens. S6b's `admin/users/actions.ts` is also DEF-452's (S7's)
file: S6b edits only the success banner there, never the local `errorMessage`, and S6b and S7 never run at the same time.
**Caller baseline (every slice):** immediately before each slice's commit, **the orchestrator** regenerates
`docs/production-caller-baseline.txt` from HEAD plus that slice only, with the sanctioned command
`node scripts/production-caller-census.mjs --names > docs/production-caller-baseline.txt`
(`tests/unit/production-caller-ratchet.test.ts` header), reviews the diff, and commits it with the slice. S6a adds
exactly its five function names; S6b removes `capabilityTitle`; S6c removes the other four. No builder or tester
edits the file.

### Invariants (S6, in addition to 1–15)
S6 touches no `Error.message` (Invariant 1), no refusal recording (2), no `errorMessage` branch (4, 11), and no `errors.ts`
(7). It adds no local `errorMessage` (8), makes no app→app import (9), and no label is ever persisted, parsed back, put in
a form value, URL param or refusal record (10).
16. Every label map is an exhaustive `Record` over its enum, defined in the enum's own file. Every lookup function is
    pure and total, and its result has no `_`. `humanise` is private to each file and never exported.
17. No `'use client'` file imports `@shareat/db`, the `@shareat/domain` barrel, or the `@shareat/auth` barrel. Labels
    reach client components as props.
18. Form values, `<option value>`s, hidden inputs and URL params carry the raw key, byte-identical to today. The only
    visible raw key is the muted secondary line under a capability label (design rule 5).
19. S6 adds no record lookup. Labels are static, so nothing S6 renders can name another store's or org's record
    (Invariant 6, DEF-453).

---

### S6a: label sources (the S5.4 precondition)
**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; S6 amendments folded). **Model:** Sonnet, tester then builder. **Migration:** none.

**Contract (BUILDER).** The wording is fixed here. Changing it is a spec change.

| Map (file) | Entries |
|---|---|
| `ITEM_KIND_LABEL` (`packages/db/schema/items.ts`, beside `:47`) | `raw_material: 'Raw material'`, `supply: 'Supply'`, `retail: 'Retail item'`, `meat_slab: 'Meat (slab)'`, `meat_sliced: 'Meat (sliced)'` |
| `DISCREPANCY_DISPOSITION_LABEL` (`schema/trade-discrepancies.ts`, beside `:37`) | `audit: 'Audit only'`, `loss: 'Loss'`, `charge: 'Charged to a person'`, `late_receipt: 'Late receipt'` |
| `ORDER_WASTAGE_DISPOSITION_LABEL` (`schema/order-wastage.ts`, beside `:60`) | `platform_paid: 'Platform paid'`, `absorbed: 'Store absorbed'`, `charged: 'Charged'` |
| `WASTAGE_REASON_LABEL` (`packages/domain/src/stock/wastage-reasons.ts`, beside `:18`) | `spoilage: 'Spoilage'`, `expiry: 'Expired'`, `damage_storage: 'Damaged in storage'`, `damage_handling: 'Damaged in handling'`, `prep_loss: 'Prep loss (trim, peel, bone)'`, `overproduction: 'Overproduction'`, `theft: 'Theft or unexplained loss'`, `quality_reject: 'Failed quality check'`, `customer_return_unsellable: 'Customer return, not resellable'`, `other: 'Other'` |

Functions (design rule 2): `itemKindLabel`, `discrepancyDispositionLabel`, `orderWastageDispositionLabel` (beside their
maps, exported from `@shareat/db`); `wastageReasonLabel` (reaches `@shareat/domain` through the existing `export *`);
`capabilityTitle(name: string)` in `packages/auth/src/capabilities.ts` (stays import-free; its own rule in design
rule 2), exported from `packages/auth/src/index.ts`. Each file's `humanise` is a private, unexported copy. `packages/db/src/index.ts`: extend the `:246` and `:271` export lines, and add one line
for the trade-discrepancies label and function. `CAPABILITY_LABEL` and `ROLE_LABEL` values are **not** changed.
- **BUILDER paths:** `packages/db/schema/items.ts`, `packages/db/schema/trade-discrepancies.ts`,
  `packages/db/schema/order-wastage.ts`, `packages/db/src/index.ts`, `packages/domain/src/stock/wastage-reasons.ts`,
  `packages/auth/src/capabilities.ts`, `packages/auth/src/index.ts` (7). Source only.
- **TESTER paths (disjoint):** `packages/db/tests/t343-s6a-enum-labels.test.ts` (new; the **three** db maps and
  functions), `packages/domain/tests/t343-s6a-wastage-reason-labels.test.ts` (new; the **one** domain map and function),
  `packages/auth/tests/t343-s6a-capability-title.test.ts` (new), `tests/unit/client-bundle-boundary.test.ts` (one new `it`
  plus its negative half only). **Imports come from the defining files, not the barrels:** `packages/db/schema/items.ts`,
  `…/trade-discrepancies.ts`, `…/order-wastage.ts`, `packages/domain/src/stock/wastage-reasons.ts`,
  `packages/auth/src/capabilities.ts` (so a missing barrel line cannot mask or fake a red). Pure unit tests only: no
  Postgres. The caller baseline is the orchestrator's (see Order), with S6a's five names added (the S5.0
  `humanDate`/`internalFault` precedent, R2 rulings).

| Id | Leg | Asserts | Red for the right reason |
|---|---|---|---|
| L1 | + | each map `toEqual`s the table above exactly (three in the db test, one in the domain test); `Object.keys(MAP).sort()` equals its enum tuple sorted (no extra, none missing) | an **assertion** failure: the imported map is `undefined` (not yet exported). The only leg that fails on an assertion. A module-resolution or DB error is **not** a valid red |
| L2 | + | for every enum value `v`: `xLabel(v) === MAP[v]` (all four functions) | `TypeError: … is not a function` (accepted for a new pure function) |
| L3 | ⛔ | totality: `itemKindLabel('prepped') === 'Prepped'`; `wastageReasonLabel('some_old_code') === 'Some old code'`; `discrepancyDispositionLabel('constructor') === 'Constructor'` (no prototype member); no result of any function over enum values plus these three contains `_` or `\n` | `… is not a function` (accepted) |
| L4 | + | for every `Capability` `c`: `capabilityTitle(c) === CAPABILITY_LABEL[c][0].toUpperCase() + CAPABILITY_LABEL[c].slice(1)`; `capabilityTitle('record_sale') === 'Record a sale'`; `capabilityTitle('retired_power') === 'Retired power'` | `… is not a function` (accepted) |
| L5 | ⛔ | every value in all four maps and every `capabilityTitle(c)` is one line, starts upper-case, has no `_`, and no map has two equal values | green once L1 is green (it pins the form rule, not the words) |
| B1 | ⛔ guard | `client-bundle-boundary`: no `'use client'` file imports the bare `'@shareat/auth'` specifier (the `'@shareat/auth/errors'` leaf stays allowed) | green on arrival (no client imports it today). Record that |
| B1n | ⛔ | B1's matcher, fed the fixture source `"'use client';\nimport {\n  ROLE_LABEL,\n} from '@shareat/auth';"`, reports exactly 1 hit. Fed `from '@shareat/auth/errors'`, it reports 0. A matcher that matches nothing fails (DEF-179) | green on arrival |

**Negative halves (unedited, must stay green):** `packages/auth/tests/t343-refusal-text.test.ts` (T1: `CAPABILITY_LABEL`
lower-case, no duplicates), `packages/auth/tests/errors-leaf.test.ts`, `super-admin-capability-set.test.ts`,
`packages/domain/tests/integration/consumption-posting.test.ts` and `usage-records.test.ts` (they read
`WASTAGE_REASONS`, which is unchanged), and the existing `client-bundle-boundary` `it`s.
**Smoketest:** none (no screen changes). **Done when:** "Done when (per slice)", with L1–L4 red→green and the raw red
recorded (L1 an assertion, L2–L4 "is not a function"), and the orchestrator's baseline regeneration adding exactly the
five names, each cited in the commit message.

---

### S6b: `/admin/users` shows labels, and says "now held in their own right" only after it is (DEF-431)
**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; S6 amendments folded). **Model:** Sonnet, tester then builder. **Migration:** none. **Needs S6a**
(`capabilityTitle`); lands before S6c. It is serial with S7 too (both edit `admin/users/actions.ts`).
Evidence: `~/.claude/skills/orchestrator/tools/t341-admin-users-page.png`.

**Change (BUILDER).**
1. **Roles.** `admin/users/page.tsx:75`, `[personId]/page.tsx:78` → `ROLE_LABEL[role]`. `[personId]/page.tsx:118` option
   text → `ROLE_LABEL[r]`, with `value={r}` unchanged.
2. **Capabilities.** Held rows (`:190`), revoked rows (`:266`) and the picker (`:448`) render `capabilityTitle(name)` as
   sans primary text, with the raw key under it as the muted secondary line of design rule 5. The picker's checkbox
   `value={c}` is unchanged.
   `grantName` is a `string` (`packages/db/src/repo/access.ts:484`), and a retired capability can still sit on an old
   row, which is why this uses `capabilityTitle` (total), not `CAPABILITY_LABEL[…]`.
3. **DEF-431 second half.** Delete the pre-click `<span>` at `:242-245`. The row's provenance is already shown at `:192`.
   Add `<input type="hidden" name="intent" value="hold_own_right" />` to the "Hold in their own right" form (`:235-246`).
4. **Banners (`actions.ts:240-247`), success path only, after the tx commits:**
   - `intent === 'hold_own_right'` and exactly one capability → `${capabilityTitle(cap)} is now held in their own right.`
   - one capability otherwise → `Granted: ${capabilityTitle(cap)}.`
   - several → `Granted ${n} capabilities: ${titles.join('; ')}.` (`;` because a label may contain a comma)
   - revoke → `Grant revoked.`, unchanged.

   `intent` only picks the wording. It never skips or changes a gate: every grant still runs `grantCapabilityAsActor` once
   per capability. A forged `intent` on a real grant can only change the banner's wording. The local `errorMessage`
   (`:40-108`) is **not** touched (S7, DEF-452).
- **BUILDER paths:** `apps/erp/src/app/admin/users/page.tsx`, `apps/erp/src/app/admin/users/[personId]/page.tsx`,
  `apps/erp/src/app/admin/users/actions.ts` (3).
- **TESTER paths (disjoint):** `apps/erp/tests/t343-s6b-admin-users-labels.test.ts` (new). Harness:
  `renderToStaticMarkup(await UserAccessPage({ params: Promise.resolve({ personId }), searchParams: Promise.resolve({}) }))`
  (`.test.ts` + `createElement`, per the `t337-access-defaults-grid-render.test.ts` header). Mock `requirePageAccess`
  (actor ≠ person, unless the leg says self), `userDetail`, and `../actions` (as t337 mocks its actions). **Two target
  fixtures:** a **`staff`** target for U1–U4 (active grants `record_sale` with source `'grant'` and `submit_sales_day`
  with source `'position'` via "Cashier at SmokeStore"; one revoked `void_sales_day`; the picker offers
  `grantableCapabilitiesFor('staff')` minus ACTIVE grants only, so a revoked capability stays re-grantable and
  `void_sales_day` appears in both the revoked list and the picker; U1 counts the muted key per section — orchestrator
  ruling 2026-09-27 on a builder QUESTION), and a separate **`super_admin`** target for U5. Keep the real `lib.ts` helpers
  where importable, and mock only what reaches `@shareat/db` at module scope. The action legs use the t337-actions
  harness (`RedirectSignal`, mocked `next/navigation`, session, `withOrgPrincipal`), with **exactly this partial mock**:
  `vi.mock('@shareat/auth', async (orig) => ({ ...(await orig()), grantCapabilityAsActor: vi.fn() }))`. **Expected
  labels are imported from `packages/auth/src/capabilities.ts` directly** (`capabilityTitle`, `ROLE_LABEL`), never typed
  in and never read through the mocked barrel. **Visible text** = the markup with every tag removed (attribute values
  go with the tags) and entities decoded.

| Id | Leg | Asserts | Red for the right reason |
|---|---|---|---|
| U1 | + | (`staff` target) visible text contains `capabilityTitle` of `record_sale`, `submit_sales_day`, `void_sales_day` and of one picker capability; each capability's raw key appears **only** inside its muted secondary element (the design-rule-5 class), directly after its label, and no snake-case token (`/\b[a-z]+(?:_[a-z]+)+\b/`) appears in visible text outside those elements | the label is absent; the key is the primary `font-mono` text |
| U2 | + | (`staff` target) the `'position'` row renders the "Hold in their own right" form with hidden `intent=hold_own_right`, and visible text does **not** contain `now held in their own right` | visible text contains it, and no `intent` field exists |
| U3 | ⛔ | (`staff` target) self page (actor = person): no "Hold in their own right" form (unchanged, `isSelf`) | green now |
| U4 | ⛔ | (`staff` target) every picker checkbox `value` and the hold form's hidden `capability` are raw keys; the set of picker values equals `grantableCapabilitiesFor('staff')` minus ACTIVE grants only — a revoked capability stays offerable (form contract, Invariant 18) | green now |
| U5 | + | (`super_admin` target) detail page visible text contains `Super admin` (exact case), and the role `<select>` options have `value`s = `ROLES` and texts = `ROLE_LABEL`; list page (`admin/users/page.tsx`, its data function mocked) shows `Super admin` for a super-admin row | visible `super admin` (lower case, from `replace`) |
| A1 | + | `setCapabilityGrantAction`, granted, one capability `record_sale` → `ok === 'Granted: Record a sale.'` | `Granted record_sale.` |
| A2 | + | same with `intent=hold_own_right` → `ok === 'Record a sale is now held in their own right.'` | `Granted record_sale.` |
| A3 | + | two capabilities → `ok` names both titles joined by `; `, with no `_` | contains `record_sale, submit_sales_day` |
| A4 | ⛔ | `intent=hold_own_right` with two capabilities → the A3 banner (the own-right sentence is for exactly one) | green after the change (write it with A2; it is the ⛔ half) |
| A5 | ⛔ | `grantCapabilityAsActor` throws `AuthorizationError(…, S)` with `intent=hold_own_right` → an `error` param, no `ok`, and nothing says `now held`; `grantCapabilityAsActor` is called once per capability in every granted leg | green now for the call count; the `ok` absence must hold after |
| A6 | ⛔ | revoke → `ok === 'Grant revoked.'` | green now |

**Negative halves (unedited, must stay green):** `apps/erp/tests/admin-users-lib.test.ts`,
`local-errormessage-convergence.test.ts` (`admin/users/actions.ts` still declares its local `errorMessage`),
`tests/unit/route-capability-coverage.test.ts`, `apps/erp/tests/action-link-sweep.test.ts` (it holds the touch-target
check against `touch-target-baseline.json`; no control enters or leaves), and the grant integration files
`packages/auth/tests/integration/roles.test.ts`, `packages/domain/tests/integration/position-defaults.test.ts`,
`packages/domain/tests/integration/t341-position-grants-per-store.test.ts`.
**Smoketest (9008, screenshots, desktop and phone width, both themes).** (a) `/admin/users`: roles read `Super admin` /
`Manager`. (b) `/admin/users/<staff person>`: held and revoked rows and the picker show labels, each with its key in
muted grey under it. (c) On a position-held row: no "now held" text before the click. Click "Hold in their
own right" → the banner "<Label> is now held in their own right.", and the row now shows its grant provenance.
**Done when:** as per slice; U1, U2, U5, A1–A3 red→green with the raw red recorded; the orchestrator's baseline
regeneration removes `capabilityTitle`.

---

### S6c: the other screens show labels (access defaults, items, usage, discrepancies, order wastage)
**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; S6 amendments folded). **Model:** Sonnet, tester then builder. **Migration:** none. **After S6b**
(strictly serial; no shared path, but one tester and one builder).

**Change (BUILDER).**

| File | Change |
|---|---|
| `admin/access-defaults/grid.tsx:211`, `:319` | render `capabilityTitle(cell.capability)` directly as sans primary text, with `cell.capability` under it as the muted secondary line (design rule 5); hidden inputs (`:38`) unchanged. `GridCapability` and `lib.ts` are **not** changed |
| `items/page.tsx:19`, `:130`, `:181`, `:217` | delete the local `KINDS` copy and use `ITEM_KINDS` from `@shareat/db` (server file; precedent `wastage/page.tsx:2`); `:130`/`:181` → `itemKindLabel(kind)`; `:217` option text → `ITEM_KIND_LABEL[k]`, `value={k}` |
| `items/[id]/page.tsx:62` | `itemKindLabel(item.kind)` |
| `inventory/usage/page.tsx:105`, `:139` | pass `reasons={WASTAGE_REASONS.map((value) => ({ value, label: WASTAGE_REASON_LABEL[value] }))}`; `:139` → `wastageReasonLabel(r.reasonCode)` (the `'—'` null arm kept) |
| `inventory/usage/NewUsageForm.tsx:48`, `:117-120` | prop type `readonly { value: string; label: string }[]`; `<option value={r.value}>{r.label}</option>`. **No import added** (Invariant 17) |
| `inventory/usage/[id]/page.tsx:54` | `wastageReasonLabel(record.reasonCode)` |
| `commissary/discrepancies/page.tsx:137`, `:151` | `discrepancyDispositionLabel(row.disposition)` (null arms kept); the `<select>` at `:162-169` is unchanged |
| `wastage/page.tsx:289`, `:196` | `orderWastageDispositionLabel(w.disposition)` when non-null (today's empty render for null kept); `:196` prose `<code>charged</code>` → `“${ORDER_WASTAGE_DISPOSITION_LABEL.charged}”` |

- **BUILDER paths:** `apps/erp/src/app/admin/access-defaults/grid.tsx`, `apps/erp/src/app/items/page.tsx`,
  `apps/erp/src/app/items/[id]/page.tsx`, `apps/erp/src/app/inventory/usage/{page.tsx,NewUsageForm.tsx}`,
  `apps/erp/src/app/inventory/usage/[id]/page.tsx`, `apps/erp/src/app/commissary/discrepancies/page.tsx`,
  `apps/erp/src/app/wastage/page.tsx` (8).
- **TESTER paths (disjoint):** `apps/erp/tests/t343-s6c-screen-labels.test.ts` (new). Grid legs reuse the
  `t337-access-defaults-grid-render.test.ts` fixture approach (actions mocked, `gridCapabilityGroups()` called live).
  Page legs render `await <Page>({ params?, searchParams })` with the page's own data functions mocked at their import
  specifiers (session, the page's `./lib`, and `withOrgPrincipal` returning the fixture without calling its callback).
  **If a page cannot be rendered in roughly 40 lines of mocks, STOP and report QUESTION. Do not substitute a source scan
  (S5.3b ruling on X1).** Visible text is defined as in S6b.

| Id | Leg | Asserts | Red for the right reason |
|---|---|---|---|
| G1 | + | `DesktopGrid` and `MobileSections`: for every offerable capability, visible text contains `capabilityTitle(c)` (imported from `packages/auth/src/capabilities.ts`), and `c` appears only inside the muted secondary element directly after it; no snake-case token (`/\b[a-z]+(?:_[a-z]+)+\b/`) appears in visible text outside those elements | the label is absent; the key is the primary `font-mono` text |
| G3 | ⛔ | the rendered forms' hidden `capability` values equal the offerable set (t337 R2, green unedited, is the full oracle; this leg re-asserts it on G1's fixture) | green now |
| I1 | + | items list page: a `meat_slab` item row and a `meat_sliced` pending request show `Meat (slab)` / `Meat (sliced)`; visible text has no `meat slab` and no snake-case token; the kind `<select>`'s option `value`s are exactly `ITEM_KINDS` | visible `meat slab` |
| I2 | + | item detail page for a `raw_material` item shows `Raw material` (exact case) and no `raw material` | `raw material` (lower case) |
| R1 | + | usage list page: a wastage row with `damage_storage` shows `Damaged in storage`; `NewUsageForm` (mocked to capture props) receives `reasons` whose `value`s are exactly `WASTAGE_REASONS` and whose `label`s are `WASTAGE_REASON_LABEL[value]`; and the source of `inventory/usage/NewUsageForm.tsx` (read from disk) has no `import` of any `@shareat/` specifier (Invariant 17 for this file) | visible `damage storage`; the prop is a `string[]` (the import check is green now and must stay green) |
| R2 | + | usage detail page with `prep_loss` → `Prep loss (trim, peel, bone)` | `prep loss` |
| R3 | ⛔ | a row whose `reasonCode` is outside the enum (`'legacy_code'`) renders `Legacy code`, not a blank and not `legacy_code` | the red is `legacy code` (lower case); write it with R1 |
| D1 | + | discrepancies page: a resolved `late_receipt` row shows `Late receipt` in both the status line (`:137`) and the resolved sentence (`:151`); the `<select name="disposition">` option `value`s are unchanged | visible `late_receipt` |
| OW1 | + | wastage page: a recent `platform_paid` row shows `Platform paid`; a row with `disposition: null` renders no disposition text (unchanged) | visible `platform_paid` |

(The `NewUsageForm` reason `<select>` renders only after the client flips `kind` to `wastage`, so its option text is
proven by R1's prop contract plus the smoketest, not by static markup.)

**Negative halves (unedited, must stay green):** `t337-access-defaults-grid-render.test.ts`, `t337-access-defaults-actions.test.ts`,
`apps/erp/tests/access-defaults-lib.test.ts` (unedited: `lib.ts` does not change), `action-link-sweep.test.ts` (the
touch-target check), `tests/unit/client-bundle-boundary.test.ts` (its rules, incl. S6a's B1, hold for every client file;
R1 carries the file-specific `NewUsageForm.tsx` check), and `packages/domain/tests/integration/usage-records.test.ts`.
**Smoketest (9008, screenshots, desktop and phone width, both themes).** `/admin/access-defaults` (a store area open:
labels, each with its key in muted grey under it); `/items` (kind column, New item kind select); `/inventory/usage` (switch to Wastage: the reason
select shows labels; the list shows a label); `/commissary/discrepancies` (a resolved row); `/wastage` (recent list).
**Done when:** as per slice; G1, I1, I2, R1, R2, D1, OW1 red→green with the raw red recorded; the orchestrator's baseline
regeneration removes the remaining four S6a names, so none of the five is left. After S6a+S6b+S6c, stamp DEF-431 FIXED,
and S5.4 is unblocked.

### S6 out of scope
Refusal text for kinds and dispositions (S5.4). The app regex wrappers, including `admin/users/actions.ts:40-108` and
`admin/access-defaults/actions.ts:57` (S7/S8, DEF-452). Labels for enums not on screen raw today (`DELIVERY_KINDS`,
`STOCK_MOVEMENT_KINDS`, …). Screens that already map their own labels (`inventory/production/page.tsx:22`,
`commissary/discrepancies/page.tsx:21` `STATUS_LABEL`), which are not re-homed. The discrepancy and wastage `<select>`
option texts, which carry account hints (`Loss — Dr 5300`). Rewording `CAPABILITY_LABEL`'s 96 phrases. POS, CUSTOMER and Website.

### Ian's answers (2026-09-27), folded above
1. **The key on admin capability screens:** shown as small muted grey text under the label, not hover-only (design
   rule 5; S6b U1, S6c G1).
2. **Label wording:** the S6a table is approved as drafted.

### S6d: follow-ups from the S6c post-commit review (`f9cdeac`)
**Status:** APPROVED 2026-09-27 (orchestrator; findings verified by the auditor against source). **Model:** Sonnet,
tester then builder. **Migration:** none. Runs after S5.5m commits, before S7.

Goal: the S6 guards pin what their names promise, and the one raw disposition S6c's own prose points at is labelled.
- **BUILDER paths (2):** `apps/erp/src/app/wastage/[id]/page.tsx` (`:108` `Resolved as ${row.disposition}` →
  `orderWastageDispositionLabel(row.disposition)`, null arm unchanged; the `<select>` at `:145` and every option
  `value` untouched); `apps/erp/src/app/admin/users/[personId]/page.tsx` (comment at `:229-236` only: add that the
  org-wide second row is DEF-456, which Ian ruled 2026-09-27 must stay store-scoped — the comment describes today's
  defect, not the intent). No behaviour change in either.
- **TESTER paths (disjoint):** `apps/erp/tests/t343-s6c-screen-labels.test.ts` (existing) and
  `apps/erp/tests/t343-s6d-wastage-detail-label.test.ts` (new).
  - G1: replace token-membership with U1's strip-then-sweep (remove every muted-secondary element, sweep the rest for
    snake_case → `[]`). Red for the right reason = planting `{capabilityTitle(c)} {c}` as primary text in a scratch copy.
  - D1: add an OPEN discrepancy fixture so the `<select name="disposition">` renders; pin its option `value`s exactly
    (`DISCREPANCY_DISPOSITIONS` order). Add null-disposition fixtures for `:137` and `:151` and pin their rendered text.
  - OW1: pin the `ow-2` (null) row's disposition cell as empty; also pin the `/wastage` `<select>` option values.
  - Usage list: a null `reasonCode` row renders `—`.
  - New W2 (s6d file): `/wastage/[id]` for a resolved `platform_paid` row shows `Resolved as Platform paid` (red:
    `platform_paid`); a null-disposition row unchanged; option values pinned.
- Done when: G1/D1/OW1 strengthened legs green on HEAD and each proved red against its plant (reasoned or scratch copy,
  never a source edit); W2 red→green; typecheck clean; screen check of `/wastage/<id>`.

---

## S5.5m: every malformed money amount refuses in human words (DEF-454)
**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; Ian's answers folded). **Model:**
Sonnet, tester then builder. **Migration:** none (one function signature and 40 string arguments; no schema).
**Order:** before S7. S7 edits `packages/domain/src/trade/index.ts` after this slice (the trade line numbers below).

**Goal.** A mistyped money amount on any screen reads `The payment amount — "abc" is not a valid amount. Use at most
two decimal places.` It never reads `recordPayment: the amount — …` or names an expense or charge by id. The compiler
proves that every caller passes a human label, so a new caller cannot forget one.

### S5.5m evidence (planner, HEAD `5fe72a6`, every call site re-read)
- `packages/domain/src/shared/money-input.ts:34` `parseMoneyInput(raw, rawLabel, humanLabel?)`. With `humanLabel`, the
  throw carries `userMessage` = `${humanLabel} — "${raw}" is not a valid amount. Use at most two decimal places.`
  (`:41`) and `.message` is unchanged (`:38`). Without it the throw is a plain, non-presentable `Error` (`:40`). Its
  only import is `@shareat/core/money` (`:11`). It is exported at the subpath `@shareat/domain/money-input`
  (`packages/domain/package.json:10`, `vitest.config.mts:21`) because app and client-capable code reach it without the
  `@shareat/db` barrel (T-266; the file's own `:26-32` warning).
- **One caller passes a human label:** `cutover/opening.ts:72` (`'This amount'`, S5.3b ruling). **Forty do not:** 36
  sites in 18 domain files and 4 sites in 3 app files, listed in the wording table below. Census:
  `grep -rn "parseMoneyInput(" packages apps --include=*.ts --include=*.tsx`, minus comments, tests and the definition.
- **Two raw labels carry an id:** `ap/index.ts:776-779` (`the allocation for expense ${a.expenseId}`) and
  `ar/index.ts:272-275` (`… for charge ${a.chargeId}`). The same holds at `apps/erp/src/app/ap/actions.ts:269` and
  `customers/actions.ts:148`. The raw stays (Invariant 1). The human label names no id (Invariant 4).
- **One app site re-wraps and drops `userMessage`.** In `apps/erp/src/app/remittance/actions.ts`, `handedOverOn`
  (`:96-104`) catches the throw from `isHandedOver` (`:87-91`, whose `parseMoneyInput` is at `:89`). It throws a fresh
  `Error` whose text is the quoted account name, a colon, and the caught message. So a human label at `:89` alone would
  never reach the screen. **This slice owns that re-wrap for presentable errors.** S8 keeps only non-presentable
  re-wraps (the S8 pointer under "Later slices" says so).
  `apps/erp/tests/remittance-overage-wiring.test.ts:359-400` runs both arrow bodies as source text through
  `new Function('isHandedOver', 'accountName', 'line', body)`. So the bodies must stay plain JavaScript once types are
  erased, and they may use no identifier other than those parameters and globals.
- **Trade line numbers are not visible row numbers today.** `apps/erp/src/app/trade/orders/actions.ts:52-54` drops empty
  rows before `createTradeOrder` numbers lines `i + 1` (`trade/index.ts:274,287`). S5.3b ruled that "Line n" must name
  the visible form row. So rows 31–32 land here as "A line's rate/total". **S7 (Ian, 2026-09-27) adds visible row
  numbers and changes those two labels to `Line ${n}'s rate` / `Line ${n}'s total`** (§S7 change 5).
- **Tests that call it with two arguments.** Once the parameter is required, these break at typecheck and nowhere else:
  `packages/domain/src/shared/money-input.test.ts:13,17,21,26,38,42,43,44,48` and `apps/erp/tests/money-input-resolves.test.ts:26,47`.
  `apps/erp/tests/t343-s1-action-guard.test.ts:46` and `packages/domain/tests/t343-s5-2-verify-invoice-rewrap.test.ts:38`
  mock the function and are unaffected. The root `tsconfig.json:78-82` includes `apps/**`, `packages/**` and `tests/**`.
- **Raw `.message` pins that must stay green unedited:** `packages/domain/tests/integration/cutover.test.ts:550`,
  `service-charge-distribution.test.ts:570`, `apps/erp/tests/integration/t328-trade-inputs-refused-by-parser.test.ts:132`
  (a suffix, so it does not care about the label), and `apps/erp/tests/remittance-overage-wiring.test.ts` (the account prefix).
- T-346 and T-345 have landed (`22475b1`, `7c26f6d`), so Invariant 14 does not hold back `fixed-assets/capitalize.ts`.
- The line numbers in this section are at `5fe72a6`. The builder finds each call by its raw label, not by its line.

### S5.5m design (decided here)
1. **`humanLabel` becomes required.** The signature is `parseMoneyInput(raw: string, rawLabel: string, humanLabel: string)`.
   The `humanLabel === undefined` branch (`:40`) is deleted, so every throw is presentable. **This is the sweep's
   guard:** a missed caller, or any future one, fails `npm run typecheck`. No source scan is needed and none is written
   (S5.3b ruling on X1: raw-text source scans pin spelling, not behaviour). The type system is not a text scan. It
   follows every import, alias and re-export, and it ignores comments.
2. **The wording table below fixes the wording.** Each label is a capitalised noun phrase that completes
   `<label> — "<typed>" is not a valid amount.` The typed value is already quoted in the sentence, so a deictic label
   ("An amount applied to an invoice") finds the row without naming an id. No label names an id, a key or a function.
   The only interpolated value is `cfg.name` at the sales-day tender site. That is the money-account name the cashier
   picked on the same form, an account of the actor's own store that is already on screen (DEF-453).
3. **The raw label never changes** (Invariant 1). Every `.message` stays byte-identical, so refusal recording
   (Invariant 2) and the raw pins above stay green.
4. **`handedOverOn` carries the human sentence through its re-wrap.** Its catch keeps today's raw text byte-identical.
   When the caught error has a string `userMessage`, it throws `Object.assign(new Error(raw), { userMessage })`. That
   `userMessage` is the quoted account name, `": "`, and the caught `userMessage` with its first character lower-cased.
   The screen then reads `"GCash": the amount handed over — "abc" is not a valid amount. Use at most two decimal places.`
   - The narrowing is `err instanceof Error && 'userMessage' in err && typeof err.userMessage === 'string'`, which is
     valid TypeScript and valid JavaScript.
   - **No template literal is nested inside another in either arrow body.** Compute the lower-cased sentence into a
     `const` first (`human.charAt(0).toLowerCase() + human.slice(1)`). Then build the message with one template literal
     whose `${…}` holds only identifiers and calls, or with `+`. The wiring test's extractor reads the body as text.
   - No cast, annotation, import or helper call goes inside either arrow body.
5. **Not a Workflow.** The slice is 22 files: 40 one-argument edits of a single shape, plus one small re-wrap. One
   builder does it in a single pass against the table. One agent per file would pay for 22 cold contexts, each re-reading
   this spec and its file, for edits that take seconds. And because the parameter is required, typecheck stays red
   until the last file is done, so parallel agents could not check their own work either. The per-file instruction
   below is written so the orchestrator *could* fan it out if it overrules this. The builder follows the same text,
   file by file.

### S5.5m wording table (approved by Ian 2026-09-27, as drafted)
Line numbers are at HEAD `5fe72a6`. **Human label** is the literal third argument. It is a template literal only where
it interpolates. The screen shows `<human label> — "<typed>" is not a valid amount. Use at most two decimal places.`

| # | File:line (domain rows are under `packages/domain/src/`) | Raw label today (unchanged) | Human label |
|---|---|---|---|
| 1 | `ap/index.ts:761` | `recordPayment: the amount` | `The payment amount` |
| 2 | `ap/index.ts:776-779` | `recordPayment: the allocation for expense ${a.expenseId}` | `An amount applied to an invoice` |
| 3 | `ap/index.ts:1114` | `suggestPaymentAllocation: the amount` | `The payment amount` |
| 4 | `ar/index.ts:64` | `recordCharge: the charge amount` | `The charge amount` |
| 5 | `ar/index.ts:225` | `recordCollection: the amount` | `The amount collected` |
| 6 | `ar/index.ts:226` | `recordCollection: the platform fee` | `The platform fee` |
| 7 | `ar/index.ts:245-247` | `recordCollection: creditApplied` | `The store credit applied` |
| 8 | `ar/index.ts:272-275` | `recordCollection: the allocation for charge ${a.chargeId}` | `An amount applied to a charge` |
| 9 | `ar/index.ts:633` | `suggestCollectionAllocation: the amount` | `The amount collected` |
| 10 | `cash-requests/index.ts:53` | `createCashRequest: the amount` | `The amount requested` |
| 11 | `cash-requests/index.ts:109` | `decideCashRequest: the approved amount` | `The approved amount` |
| 12 | `cash-requests/index.ts:187` | `releaseCashRequest: the amount` | `The amount released` |
| 13 | `expenses/reimbursement.ts:46` | `payReimbursement: the amount` | `The reimbursement amount` |
| 14 | `fixed-assets/capitalize.ts:85` | `createAsset: the cost` | `The asset's cost` |
| 15 | `fixed-assets/capitalize.ts:103` | `createAsset: the salvage value` | `The salvage value` |
| 16 | `loans/index.ts:92` | `disburseLoan: the amount` | `The loan amount` |
| 17 | `loans/index.ts:167` | `recordLoanPayment: the amount` | `The payment amount` |
| 18 | `money-transfers/index.ts:154` | `createMoneyTransfer: amountOut` | `The amount sent` |
| 19 | `money-transfers/index.ts:155` | `createMoneyTransfer: amountIn` | `The amount received` |
| 20 | `owners/index.ts:78` | `createOwner: the drawing limit` | `The drawing limit` |
| 21 | `owners/index.ts:123` | `recordContribution: the amount` | `The contribution amount` |
| 22 | `payroll/index.ts:72` | `setPayRate: the amount` | `The pay rate` |
| 23 | `payroll/separation.ts:131-134` | `postSeparation: the separation pay` | `The separation pay` |
| 24 | `prepaid/index.ts:420` | `writeOffPrepaidItem: the refund amount` | `The refund amount` |
| 25 | `recurring-expenses/index.ts:91` | `createRecurringTemplate: the default amount` | `The default amount` |
| 26 | `recurring-expenses/index.ts:171` | `updateRecurringTemplate: the default amount` | `The default amount` |
| 27 | `remittance/index.ts:206` | `createRemittance: the declared overage` | `A declared overage` |
| 28 | `sales-days/create.ts:342` | `sales day tenders: "${cfg.name}"'s amount` | `The amount for "${cfg.name}"` (template literal) |
| 29 | `service-charge/index.ts:50` | `distributeServiceCharge: the amount` | `The amount to distribute` |
| 30 | `stock/supplier-returns.ts:369` | `refundSupplierCredit: the amount` | `The refund amount` |
| 31 | `trade/index.ts:274` | `createTradeOrder: line ${i + 1}'s rate` | `A line's rate` (S7 changes it to `Line ${n}'s rate`) |
| 32 | `trade/index.ts:287-290` | `createTradeOrder: line ${i + 1}'s total` | `A line's total` (S7 changes it to `Line ${n}'s total`) |
| 33 | `trade/index.ts:304` | `createTradeOrder: the delivery fee` | `The delivery fee` |
| 34 | `trade/index.ts:305` | `createTradeOrder: other fees` | `The other fees` |
| 35 | `trade/index.ts:314` | `createTradeOrder: the total` | `The stated total` |
| 36 | `wastage/orders.ts:292` | `recordOrderWastage: the amount` | `The wastage amount` |
| 37 | `apps/erp/src/app/ap/actions.ts:269` | `suggestPaymentAllocation: the amount typed for expense ${t.expenseId}` | `An amount you typed against an invoice` |
| 38 | `apps/erp/src/app/customers/actions.ts:148` | `suggestCollectionAllocation: the amount typed for charge ${t.chargeId}` | `An amount you typed against a charge` |
| 39 | `apps/erp/src/app/remittance/actions.ts:89` | `createRemittanceAction: the amount handed over` | `The amount handed over` (on screen: `"<account>": the amount handed over — …`, design rule 4) |
| 40 | `apps/erp/src/app/remittance/actions.ts:146` | `createRemittance: the declared overage` | `A declared overage` |

Unchanged: `cutover/opening.ts:72` (`This amount`, S5.3b).

### S5.5m build
**Per-file instruction.** The text is exact, and it is the same whether one builder does the work or it is fanned out:
> In `<file>`, at each `parseMoneyInput(` call that the S5.5m wording table lists for this file, add that row's human
> label as the third argument. Use a string literal, or a template literal only where the table interpolates. Change
> nothing else: not the raw label, not the other arguments, not the surrounding code, comments or imports. If a listed
> call (found by its raw label) is not in the file, or the file holds a `parseMoneyInput(` call that the table does not
> list, STOP and report QUESTION. Report the lines you changed.

Two files take one extra change each:
- `packages/domain/src/shared/money-input.ts`: make `humanLabel: string` required. Delete the line
  `if (humanLabel === undefined) throw err;` (`:40`). Update the doc comment: the parameter is required (S5.5m,
  DEF-454), and the "~20 callers … keep compiling" paragraph goes. The only import stays `@shareat/core/money`.
- `apps/erp/src/app/remittance/actions.ts` `handedOverOn` (`:96-104`): apply design rule 4. Nothing else in the body changes.

**The builder's gate is `npm run typecheck` clean**, plus the named legs green. A caller the builder missed shows up
there, not in vitest.

- **BUILDER paths (22):** `packages/domain/src/shared/money-input.ts`; `packages/domain/src/{ap/index.ts, ar/index.ts,
  cash-requests/index.ts, expenses/reimbursement.ts, fixed-assets/capitalize.ts, loans/index.ts, money-transfers/index.ts,
  owners/index.ts, payroll/index.ts, payroll/separation.ts, prepaid/index.ts, recurring-expenses/index.ts,
  remittance/index.ts, sales-days/create.ts, service-charge/index.ts, stock/supplier-returns.ts, trade/index.ts,
  wastage/orders.ts}` (18); `apps/erp/src/app/{ap/actions.ts, customers/actions.ts, remittance/actions.ts}` (3). Source only.
- **TESTER paths (disjoint):**
  - New: `packages/domain/tests/t343-s5-5m-money-label-required.test.ts`,
    `apps/erp/tests/integration/t343-s5-5m-money-labels.test.ts` and `apps/erp/tests/t343-s5-5m-remittance-rewrap.test.ts`.
  - Amended: `packages/domain/src/shared/money-input.test.ts` and `apps/erp/tests/money-input-resolves.test.ts`.
    **This amendment is ruled here, and it is not a weakening.** Each two-argument call gains a third argument
    `'The amount'`. No assertion, expected string or test title changes. Both files assert `.message` and the return
    value, and neither of those changes. **The tester makes the amendment in the RED phase**, with the new legs. The
    parameter is still optional then, so the amended files typecheck before and after the builder.

| Id | Leg | Asserts | Red for the right reason |
|---|---|---|---|
| T1 | + type | in `t343-s5-5m-money-label-required.test.ts`: `// @ts-expect-error S5.5m — humanLabel is required` directly above `parseMoneyInput('1', 'x')`; the runtime result is `'1.00'` | **`npm run typecheck`** reports `TS2578: Unused '@ts-expect-error' directive` at that line. Vitest is green, so this leg's red comes from the typecheck. Record the raw tsc line |
| T1n | ⛔ | same file: `parseMoneyInput('1', 'x', 'The amount')` with no directive typechecks and returns `'1.00'` | green now |
| T2 | ⛔ | same file: `parseMoneyInput('abc', 'fn: the amount', 'The amount')` throws an `Error` whose `.message` is exactly `fn: the amount — "abc" is not a valid amount. Use at most two decimal places.`, and whose `userMessage` is the same sentence with `The amount` in place of the raw label; `parseMoneyInput('1.234', 'x', 'The amount')` also carries `userMessage` | green now (S5.3b); pins the three-argument contract |
| H1 | + | integration, the `createSalesDay` tender path (`sales-days/create.ts:118` → `writeTenders`, `:228` → the parse at `:342`; use the nearest existing sales-days fixture): a tender typed `abc` on the money account `GCash` → `errorMessage(err)` from the shared `apps/erp/src/lib/constraint-messages.ts` is exactly `The amount for "GCash" — "abc" is not a valid amount. Use at most two decimal places.` | the rendered text still carries `sales day tenders` / `'s amount` (no `userMessage`) |
| H2 | + | integration, `recordPayment` (the AP fixture): amount `1.234` → `The payment amount — "1.234" …`; an allocation typed `abc` → `An amount applied to an invoice — "abc" …`, and the rendered text has no UUID and no `[hidden]` | today's text: the raw label, with the allocation's id redacted to `[hidden]` |
| H3 | + | integration, `createTradeOrder` (the `t328-trade-inputs-refused-by-parser` harness): `deliveryFee: 'abc'` → `The delivery fee — "abc" …` | text derived from the raw label, not the human one |
| H4 | + | integration, `createCashRequest`: `abc` → `The amount requested — "abc" …` | text derived from the raw label |
| H5 | + | `createRemittanceAction`. Action harness: `RedirectSignal`, mocked session and `withOrgPrincipal`, the real `@shareat/domain/money-input`, the real shared `errorMessage`. One line typed `abc` from the account `GCash` → the `error` param is exactly `"GCash": the amount handed over — "abc" is not a valid amount. Use at most two decimal places.` | `"GCash": createRemittanceAction: the amount handed over — …` |
| H6 | ⛔ | every H leg also asserts that `.message` is byte-identical to today's raw sentence (Invariant 1) | green now |

**If a site cannot be reached with about 40 lines of fixture, STOP and report QUESTION. Do not substitute a source scan
(S5.3b ruling on X1).** H1–H5 sample the wiring: the highest-traffic screens and the one re-wrap. T1 is the exhaustive
proof, because a caller without a label does not compile.

**Negative halves (unedited, must stay green):**
- `packages/domain/tests/integration/`: `cutover.test.ts` (`:550`), `service-charge-distribution.test.ts`, `order-wastage.test.ts`.
- `apps/erp/tests/integration/`: `t328-trade-inputs-refused-by-parser.test.ts`,
  `t328-trade-rate-message-names-the-rate.test.ts`, `t327-operator-sentence-two-paths.test.ts`.
- `apps/erp/tests/remittance-overage-wiring.test.ts`. It executes the `isHandedOver` and `handedOverOn` bodies, and
  design rule 4 keeps them plain JavaScript.
- `packages/domain/src/shared/money-positivity-guard.test.ts`, `t343-s1-action-guard.test.ts`, `t343-s5-2-verify-invoice-rewrap.test.ts`.
- `tests/unit/t343-throw-ratchet.test.ts`. The ratchet counts `throw new Error(`. This slice changes arguments,
  deletes one `throw err;` (`money-input.ts:40`, which the ratchet does not count), and adds throws only in
  `apps/erp/src/app/remittance/actions.ts`, which is not ratcheted. So no `CEILINGS` entry moves.

**Caller baseline:** no exported function is added or removed, so the orchestrator's regeneration must show no diff. If
it does, STOP.

**Smoketest (9008, screenshots).**
- (a) `/sales-days/new`: type `abc` in a tender → the banner reads `The amount for "<wallet>" — "abc" …`.
- (b) `/remittance`: type `abc` as an amount handed over → `"<account>": the amount handed over — …`.
- (c) An AP supplier page: type `1.234` in the amount applied to an invoice, and submit **Pay** without using
  auto-allocate → `An amount applied to an invoice — "1.234" …`.

**Done when:** as "Done when (per slice)", plus:
- T1 goes red at typecheck, then green.
- H1–H5 go red, then green. Record the raw reds.
- Typecheck is clean.
- DEF-454 is stamped FIXED.

### S5.5m invariants (in addition to 1–19)
20. `money-input.ts`'s only import is `@shareat/core/money`. It never imports `refuse`, `RefusalError`, or anything
    that reaches `@shareat/db` (T-266: `@shareat/domain/money-input` is reachable without the db barrel). **No test
    guards this.** `client-bundle-boundary.test.ts` checks client files' specifiers, not this leaf's imports. The guard
    is the reviewer reading the diff of `money-input.ts`.
21. `humanLabel` is required. Every caller passes a capitalised noun phrase that names no id, key or function
    (Invariant 4). The one interpolation is the tender's money-account name (DEF-453).
22. Every raw label and every `.message` is byte-identical (Invariant 1). Only `userMessage` is added.

### S5.5m out of scope
- Visible trade line numbers. S7 adds them (change 5).
- Every other refusal in the 18 files: only the money parse changes.
- `parseFourDecimalCost` and `parseQuantityInput`, which have their own label splits (S5.3 and later).
- The issue messages in `money-lines.ts`, which are already human.
- Non-presentable re-wraps (S8).
- POS, CUSTOMER and Website.

**Order:** S5.5m, then S7. S5.5m shares no file with S6a–S6c or S5.4, so it may run beside S6 in another lane at the
orchestrator's choice. It shares `packages/domain/src/trade/index.ts` with S7, so S7 starts from S5.5m's commit.

### S5.5n: follow-ups from the S5.5m post-commit review (DEF-457, DEF-458, DEF-459)
**Status:** APPROVED 2026-09-27 (orchestrator; findings verified by the auditor against source). **Model:** Sonnet,
tester then builder. **Migration:** none. Runs after S7 and S6d commit (S7 edits neither file below except as noted).

1. **DEF-457 (money):** `apps/erp/src/app/customers/actions.ts` — the `creditApplied` spread (`…Number(creditApplied) > 0 …`,
   find by text) sends the field whenever the trimmed text is non-empty, so `'1,000'` reaches `parseMoneyInput` and
   refuses with "The store credit applied — …". An empty box still omits it (domain defaults `'0'`). A typed `'0'` is sent
   and parses to zero, which the domain already accepts. Same pattern as the allocation fix documented at `:170-173`.
2. **DEF-458:** `packages/domain/src/shared/money-input.ts` — distinguish the two `money()` failures. A `RangeError` gets
   `<label> — "<raw>" is too large. The most an amount can be is 999,999,999,999.99.` (raw and human forms, same shape as
   today's); every other failure keeps today's sentence byte-identical. Stays import-free except `@shareat/core/money`.
   Check the real ceiling in `packages/core/src/money.ts` and quote it exactly.
3. **DEF-459:** at the four id-carrying sites (`packages/domain/src/ap/index.ts` allocation-for-expense,
   `packages/domain/src/ar/index.ts` allocation-for-charge, `apps/erp/src/app/ap/actions.ts` and
   `apps/erp/src/app/customers/actions.ts` typed-for-expense/charge; find by raw label text) wrap the `parseMoneyInput` call
   in `try { … } catch (err) { logger.info({ err }, '<site>: malformed allocation amount'); throw err; }` using each
   file's existing logger import (if a file has none, use `@shareat/core`'s `logger` — check what the file already
   imports; if that would add an import to a `'use client'` path, STOP and report). The thrown error is unchanged.
- **BUILDER paths:** `packages/domain/src/shared/money-input.ts`, `packages/domain/src/ap/index.ts`,
  `packages/domain/src/ar/index.ts`, `apps/erp/src/app/ap/actions.ts`, `apps/erp/src/app/customers/actions.ts` (5).
- **TESTER paths:** `apps/erp/tests/integration/t343-s5-5n-followups.test.ts` (new) and
  `packages/domain/src/shared/money-input.test.ts` (new `describe` only).
  - C1 (DEF-457): collect with `creditApplied='1,000'` → refusal naming "The store credit applied", and NO journal entry /
    collection row written (red: succeeds, money account debited the full net). C1n: empty box → collection succeeds,
    credit 0 (green now).
  - R1 (DEF-458): `parseMoneyInput('99999999999999', 'x', 'The amount')` → `userMessage` contains "too large" and not
    "decimal places" (red now); R1n: `'1.234'` → today's sentence byte-identical (green now).
  - L1 (DEF-459): one site (ap allocation) with a malformed amount → the logger receives one `info` call carrying the
    raw (spy the logger module); the thrown `userMessage` unchanged (red: zero calls).
- Done when: reds red→green, negatives green unedited, typecheck clean, `money-input.ts` import set unchanged, screen
  check of the customer collection with `1,000` in the credit box.

---

## S7: app wrappers stop pre-empting refusals, and trade lines are numbered (DEF-452; the "≈40 app regexes")
**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; Ian's answers folded). **Model:**
Sonnet, tester then builder. **Migration:** none.

**Runs strictly after both S6c and S5.5m are committed.**
- `admin/users/actions.ts` belongs to both S6b (the success banner) and S7 (the local `errorMessage`), and one tester
  and one builder run S6a → S6b → S6c.
- `packages/domain/src/trade/index.ts` is S5.5m's file (rows 31–32), and S7 edits it again.

S7 starts only when both commits are on `main`. The builder re-reads every BUILDER file at that HEAD before editing.

**Goal.**
- On the 13 screens DEF-452 names, a refused action shows the S2/S2b sentence, which names the store and where the job
  is. It does not show a screen-local "Only a manager or admin…".
- Any presentable error beats a screen-local regex. Local sentences for constraint names and plain domain throws stay.
- On the new trade order form, every line shows its number, and every refusal about a line names that visible number.

### S7 evidence (planner, HEAD `5fe72a6`, all files re-read)
- **The rule from S5.1d still holds.** All seven `authorize()` throw sites pass a `userMessage` (S2/S2b), and the
  shared `errorMessage` (`apps/erp/src/lib/constraint-messages.ts:296`) is its only reader. So a local branch keyed on
  authorize's raw text is a pure bypass.
- **The census is exactly DEF-452.**
  - `grep -rn "may not '" apps/erp/src` finds 30 branches, all in the 13 files.
  - A wider grep for other authorize-shaped keys (`no store scope`, `/authorize:/`, `has no active role`,
    `instanceof AuthorizationError`, `.capability ===`) finds one more branch (`admin/access-defaults/actions.ts:43`)
    and nothing else. S5.1c and S5.1d removed the rest.
  - **So the "≈40" in the Later-slices S7 line is 31 today, and all 31 are in this slice. Nothing is left to list for later.**
- **In all 13 files, find each branch by its regex and each function by its name, never by line.** The line numbers
  below are at `5fe72a6`, and S6b has already moved lines in `admin/users/actions.ts`.

  | File (under `apps/erp/src/app/`) | Local fn (at `5fe72a6`) | Bypass branches, by regex (deleted) | Kept branches, by regex |
  |---|---|---|---|
  | `inventory/pos-map/actions.ts` | `:21` | `manage_pos_map`, `request_pos_map`, `decide_pos_map_request` | none |
  | `inventory/pos-usage/actions.ts` | `:22` | `record_stock_movement`, `finalize_pos_usage_pull`, `request_pos_map` | none |
  | `inventory/production/actions.ts` | `:31` | `record_stock_movement`, `post_production`, `edit_posted_production`, `void_production` | `/live slicer payment/` → raw (S8's, non-presentable only) |
  | `inventory/usage/actions.ts` | `:41` | `record_stock_movement`, `record_wastage`, `post_usage`, `void_usage_record` | `/is a parking spot/`, `/storage room; only an operating room/`, `/is inactive and cannot be a usage source/`, `/a posted usage record is immutable/`, `/a voided usage record is terminal/` |
  | `inventory/counts/actions.ts` | `:45` | `open_count_session`, `commit_count`, `record_stock_movement` | `/already in active count session/`, `/is frozen by an active count session/`, `/count_lines_counted_non_negative/`, `/count session .* is already committed/` |
  | `items/actions.ts` | `:53` | `approve_item`, `manage_items` | `/items_org_name_key/`, `/items_org_code_key/` |
  | `staff/actions.ts` | `:40` | `enrol_staff`, `manage_store_settings` | the `return raw` branches (S8's, non-presentable only); `/person_credentials_lookup_hash_unique/` |
  | `staff/[employmentId]/credentials/actions.ts` | `:23` | `manage_attendance` | none |
  | `trade/orders/actions.ts` | `:30` | `approve_buyer` | none |
  | `commissary/catalogue/actions.ts` | `:25` | `manage_commissary_offerings`, `manage_commissary_map` | none |
  | `attendance/terminals/actions.ts` | `:34` | `provision_clock_terminal`, `manage_attendance` | none |
  | `admin/users/actions.ts` | `:39` | `manage_users`, `grant_capability`. Also **dead once presentable wins**, because each thrower already carries a `userMessage`: `/may not change their own role/` (`roles.ts:347`), `/may not grant themselves a capability/` (`roles.ts:579`), `/outranks you/` (`roles.ts:452`), `/requires super_admin/` (`roles.ts:397`), `/only active admin/` (`roles.ts:500`), `/does not exist in org/` (`roles.ts:369,599`, `credentials-admin.ts:45`), `/^revokeCredential:/` and `/does not exist or is already revoked/` (`recordGone` at `sessions.ts:196`, `access.ts:265,681`) | `/person_credentials_external_id_unique/` |
  | `admin/access-defaults/actions.ts` | `:38` | `grant_capability`, `/has no active role/` (`authorize.ts:141`, S2 `noActiveRole`) | `/does not belong to this organisation/`, `/does not exist in this organisation/`; the `return raw` branch (S8's, non-presentable only) |
- **Why not collapse to `err instanceof AuthorizationError && err.capability === …`** (the Later-slices option).
  Every `AuthorizationError` from `authorize()` and `roles.ts` already carries its own sentence. A capability-keyed
  local sentence would still pre-empt it, and would lose what S2b added: the store, and where the job is. So every
  branch is **deleted**, and none is re-keyed (Invariant 24).
- **Three local admin sentences are better than the domain's.** Once presentable wins, the S5a `userMessage` would
  replace each of them on screen. Ian chose option A (2026-09-27): the better sentences move into `roles.ts` (the S5.3b
  proof-photo precedent).

  | `roles.ts` (at `5fe72a6`) | S5a `userMessage` today | Local sentence (`admin/users/actions.ts`) |
  |---|---|---|
  | `:347-351` self role | `An actor may not change their own role — ask another admin, so a mistake here cannot lock the org out.` | `You cannot change your own role. Ask another admin — this is what stops one mis-click locking the org out.` |
  | `:579-583` self grant | `An actor may not grant themselves a capability — ask another admin, so nobody can widen their own authority.` | `You cannot give yourself a capability. Ask another admin — otherwise anyone holding this screen could widen their own authority, and nobody would have approved it.` |
  | `:500-508` last admin | `Refusing to demote this org's only active admin who can sign in — appoint another admin or super admin who holds a credential first, …` | `This is the org's only active admin who can sign in. Appoint another admin or super-admin and give them a PIN or an email account first — otherwise nobody is left who can manage users.` |

  "An actor" is internal vocabulary. For the other dead branches:
  - S5a's `outranks` and `requires super_admin` sentences name the roles.
  - `goneSentence` covers the rest.
  - The one gap is `/^revokeCredential:/`, where `goneSentence('credential')` reads worse than the local "sign-in
    account". So `sessions.ts:196`'s kind becomes `'sign-in account'` (change 4).
- **Six files end with no local branch:** pos-map, pos-usage, credentials, trade/orders, catalogue and terminals. Each
  local function would shrink to `return sharedErrorMessage(err)`, so it is deleted and the shared function is imported
  unaliased. Every function in the 13 files is private (not exported), and no test mocks one by name (grep
  `apps/erp/tests`). `local-errormessage-convergence.test.ts` checks only the files that still declare a local copy.
- **No existing test asserts a deleted sentence.** Every deleted sentence was grepped over `apps/erp/tests`,
  `packages` and `tests`, and so was `credential could not be found`. The only hits are two comments
  (`credentials-admin.ts:40`, `credentials-admin.test.ts:375`) and one test *title* (`production.test.ts:651`).
  `roles.test.ts:393,1046,1063` match the raw `.message`, which does not change.
- **S8 scope shift.** Once each wrapper returns presentable errors first, S8's raw returns in production, staff and
  access-defaults only ever see non-presentable errors. S8 keeps those, and nothing more, in these files. The S8
  pointer under "Later slices" records this.
- **Trade line numbers (Ian, 2026-09-27: add them now, in S7).**
  - `createTradeOrder` has one caller: `apps/erp/src/app/trade/orders/actions.ts:60` (`createOrderAction`).
    `NewOrderForm.tsx` (a `'use client'` component rendered by `trade/orders/page.tsx:138`) is the only form that posts
    trade lines.
  - The form shows no row number today (`NewOrderForm.tsx:161-215`: Item, Quantity and Rate per row).
  - The action drops rows with an empty `itemId` before the domain (`actions.ts:52-54`).
  - The domain numbers every line refusal `i + 1` over the surviving rows: `trade/index.ts:222`, `:224`, `:238`,
    `:260`, `:263`, `:274` (rate parse), `:275`, `:276`, `:278`, `:289` (total parse) and `:292`.
  - So "line 3" can name a row the person cannot see. The deliveries precedent (S5.3b R3: `documents.ts:69,143`,
    `inventory/deliveries/actions.ts:129,148`) numbers rows before the filter, and has the domain use
    `line.lineNo ?? i + 1`.

### S7 change (BUILDER)
1. **Seven files keep some local branches:** production, usage, counts, items, staff, admin/users and access-defaults.
   In each:
   - (a) The first statement of the local `errorMessage` is `if (isPresentable(err)) return sharedErrorMessage(err);`.
     Import `isPresentable` from `@/lib/error-shape`, as S5.1d did.
   - (b) Delete the bypass and dead branches in the table, found by regex.
   - (c) Every kept branch keeps its text and its order, S8's raw returns included.
   - (d) Fix any doc comment that names authorize denials or the deleted cases.
2. **Six files keep nothing.** Delete the local `errorMessage`, and change the import to
   `import { errorMessage } from '@/lib/constraint-messages';`. Call sites are unchanged.
3. **`packages/auth/src/roles.ts`.** Replace the third argument (`userMessage`) of the three throws found by their raw
   text (`may not change their own role`, `may not grant themselves a capability`, `only active admin who can sign in`)
   with these, exactly:
   - self role: `You cannot change your own role. Ask another admin — this is what stops one mis-click locking the org out.`
   - self grant: `You cannot give yourself a capability. Ask another admin, so nobody can widen their own authority without someone else approving it.`
   - last admin: `This is the org's only active admin who can sign in. Appoint another admin or super admin and give them a PIN or an email account first — otherwise nobody is left who can manage users.`

   The first argument (the raw text) and the capability stay byte-identical. No other `roles.ts` line changes.
4. **`packages/db/src/repo/sessions.ts`** (`revokeCredential`, `:196` at `5fe72a6`): the `recordGone` kind changes from
   `'credential'` to `'sign-in account'`. The raw first argument stays byte-identical. The screen then reads
   `That sign-in account could not be found. Someone may have changed it — reload the page and try again.`
5. **Trade line numbers.**
   - `apps/erp/src/app/trade/orders/NewOrderForm.tsx`: `lines.map((l, idx) => …)` renders, first in each row, a visible
     `Line {idx + 1}` label (a `<span>` spanning the row's grid, `text-xs font-medium` in the form's existing label
     colours). No control is added or removed, and no import is added (Invariant 17).
   - `apps/erp/src/app/trade/orders/actions.ts` `createOrderAction`: each posted row gets `lineNo: i + 1` in the `.map`
     BEFORE the `.filter`, which is the deliveries shape. The rows are in document order, so `i + 1` is the visible
     `Line n`.
   - `packages/domain/src/trade/index.ts`: `TradeLineDraft` gains `readonly lineNo?: number`, documented as the
     visible form row, as in `deliveries/documents.ts:69`. At the top of the `createTradeOrder` loop,
     `const n = draft.lineNo ?? i + 1;`. Every `line ${i + 1}` in that loop's messages becomes `line ${n}` (the 11
     sites above). Rows 31–32's human labels (from S5.5m) become `` `Line ${n}'s rate` `` and `` `Line ${n}'s total` ``.
     `lineNo` is not persisted: the `lines.push` shape and `tradeRepo.insertLines` are unchanged.
   - With no `lineNo`, every message is byte-identical to today, so existing tests and any non-form caller are
     unaffected. With `lineNo`, the number in the raw is the visible row (the S5.3b R3 precedent; Invariant 25).
6. **The ratchet does not move.** S7 changes arguments, deletes app branches and renumbers existing messages. It adds or
   removes no `throw new Error(` in a ratcheted directory.

- **BUILDER paths (17):** the 13 `actions.ts` files in the table (`trade/orders/actions.ts` also takes change 5),
  `packages/auth/src/roles.ts`, `packages/db/src/repo/sessions.ts`, `apps/erp/src/app/trade/orders/NewOrderForm.tsx`
  and `packages/domain/src/trade/index.ts`. Source only.
- **TESTER paths (disjoint), all new:**
  - `apps/erp/tests/t343-s7-wrapper-refusals.test.ts`: the 11 non-admin files.
  - `apps/erp/tests/t343-s7-admin-refusals.test.ts`: admin/users and access-defaults.
  - `apps/erp/tests/t343-s7-trade-line-numbers.test.ts`: the action and form legs of change 5.
  - `apps/erp/tests/integration/t343-s7-trade-line-numbers.test.ts`: the domain legs, using the
    `t328-trade-inputs-refused-by-parser` harness.
  - `packages/auth/tests/integration/t343-s7-roles-sentences.test.ts`: uses the fixture approach of `roles.test.ts`.
  - `packages/db/tests/integration/t343-s7-credential-gone.test.ts`, or a new `describe` in the nearest existing
    sessions-repo integration file. The tester picks one and names it in the READY report.

  **App harness:** the same as `t343-s5-1d-wrapper-refusals.test.ts`.
  - `RedirectSignal`. Mock `next/navigation`, `next/cache`, the session and each file's `withOrgPrincipal`. Domain
    functions are mocked to throw.
  - Use the REAL `@/lib/constraint-messages` and `@/lib/error-shape`, the real `AuthorizationError` (third argument S),
    and the real `refuse` / `recordGone` from `packages/db/src/refusal` and `packages/db/src/repo/record-gone`.
  - For admin/users, mock `@shareat/auth` partially:
    `vi.mock('@shareat/auth', async (orig) => ({ ...(await orig()), grantCapabilityAsActor: vi.fn(), assignRoleAsActor: vi.fn() }))`,
    plus anything else the action calls.
  - `provisionTerminalAction` returns `{ ok: false, error }` instead of redirecting, so read `error`.
  - Form legs render with `renderToStaticMarkup(createElement(NewOrderForm, props))` (`.test.ts` plus `createElement`,
    as in the `t337-access-defaults-grid-render.test.ts` header). Visible text is defined as in S6b.
  - Take action and export names from the files at HEAD.

  **If one file's action cannot be driven with about 40 lines of mocks, STOP and report QUESTION. Do not substitute a
  source scan (S5.3b ruling on X1).**

| Id | Leg | Asserts | Red for the right reason |
|---|---|---|---|
| P1 | + (`it.each`, one row per deleted `may not '<cap>'` branch: **30 rows**, by file and capability as in the table above) | an action in that file, whose domain mock throws `new AuthorizationError("authorize: role 'staff' may not '<cap>'", cap, S)` → the rendered error `=== S` | that file's local sentence for `<cap>` |
| P2 | + | access-defaults: raw `authorize: person <uuid> has no active role in org <uuid>` with `userMessage` S → `=== S` | `Your account has no active role, so nothing here can be granted or changed.` |
| P3 | + (one row per file that keeps branches: 7) | `refuse('<raw that matches a kept branch>', S)` → `=== S`. Rows: production `… live slicer payment …`; usage `… is a parking spot …`; counts `… already in active count session …`; items, a raw containing `items_org_name_key` (no `code`); staff `… already has an open employment …`; admin/users `refuse('… person_credentials_external_id_unique …', S)` (no `code`); access-defaults `… does not exist in this organisation …` | the kept branch's local sentence, or the raw for the raw-return rows |
| P4 | + (2 rows) | admin/users: (a) raw `revokeGrantById: grant <uuid> does not exist or is already revoked`, built with the real `recordGone(raw, 'grant')` → `goneSentence('grant')`; (b) raw `revokeCredential: credential <uuid> does not exist or is already revoked`, built with `recordGone(raw, 'sign-in account')` → `goneSentence('sign-in account')` | (a) `That grant was already revoked — reload the page to see the current state.`; (b) `That sign-in account was already unlinked — reload the page to see the current state.` |
| P5 | + | repo integration: `sessionsRepo.revokeCredential` on an already-revoked credential throws a `RecordGoneError` whose `userMessage` is `goneSentence('sign-in account')`, and whose `.message` is byte-identical to today's | `userMessage` is `goneSentence('credential')` |
| K1 | ⛔ (one row per file that keeps branches: 7) | a **non-presentable** error that hits a kept branch renders exactly today's text. Build constraint-shaped errors the way `local-errormessage-convergence.test.ts` does. Rows: production, the raw return; usage, the parking-spot sentence; counts, the frozen-room sentence; items, the `{ code: '23505', constraint: 'items_org_name_key' }` sentence; staff, the `must be exactly 6 digits` raw; admin/users, the `{ code: '23505', constraint: 'person_credentials_external_id_unique' }` sentence; access-defaults, the `belongs to a different store` raw | green now |
| K2 | ⛔ (one row per emptied file: 6) | plain `Error('fn: <uuid> text')` → equals the shared `errorMessage(err)`, with no UUID | green now |
| R1 | + | integration: `assignRoleAsActor` on self → `userMessage === <self-role sentence>`; `grantCapabilityAsActor` on self → `<self-grant sentence>`; demoting the org's only credentialed admin → `<last-admin sentence>`. The texts come from change 3 and are typed into the test, because they ARE the contract | the S5a sentences (`An actor may not …` / `Refusing to demote …`) |
| R1n | ⛔ | the same three throws: `.message` is byte-identical to today's, and `capability` is unchanged | green now |
| N1 | + | `createOrderAction` with posted rows `itemId = ['a', '', 'b']` → the mocked `createTradeOrder` receives two lines, with `lineNo` 1 and 3 | `lineNo` is absent |
| N2 | + | integration: `createTradeOrder` with two valid lines, the second carrying `lineNo: 3` and `rate: 'abc'` → `userMessage` is exactly `Line 3's rate — "abc" is not a valid amount. Use at most two decimal places.` and `.message` is `createTradeOrder: line 3's rate — "abc" …` | `userMessage` is `A line's rate — …` and `.message` says `line 2` |
| N2n | ⛔ | the same order with no `lineNo` → `.message` byte-identical to today's (`line 2's rate`), and `userMessage` is `Line 2's rate — …` | the red is only in `userMessage` (`A line's rate`); `.message` is green now |
| N3 | + | `NewOrderForm` with one item: visible text contains `Line 1`, and the form's controls (`itemId`, `quantity`, `rate` fields and the two buttons) are unchanged | `Line 1` is absent |

**Negative halves (unedited, must stay green):**
- `apps/erp/tests/`: `local-errormessage-convergence.test.ts`, `t343-s5-1d-wrapper-refusals.test.ts`,
  `t343-s5-1c-commissary-refusals.test.ts`, `t343-s1-presentable.test.ts`, `t343-s5-action-guard.test.ts`,
  `t337-access-defaults-actions.test.ts`, `t343-s6b-admin-users-labels.test.ts`, `t343-s6c-screen-labels.test.ts`,
  `remittance-overage-wiring.test.ts`, and `action-link-sweep.test.ts` (touch-target baseline: the new `Line n` span
  is not a control).
- S5.5m's `t343-s5-5m-*` files, except row 31's assertions if any name `A line's rate`. S5.5m's H3 uses the delivery
  fee, not a line rate, so none should.
- `apps/erp/tests/integration/`: `t328-trade-inputs-refused-by-parser.test.ts` and
  `t328-trade-rate-message-names-the-rate.test.ts` (no `lineNo`, so the raw is byte-identical), plus
  `packages/domain/tests/integration/trade.test.ts`.
- `packages/auth/tests/integration/roles.test.ts` (`:393`, `:1046` and `:1063` match the raw; `:1144` expects
  `Super admin`), `credentials-admin.test.ts`, and `packages/auth/tests/t343-s5a-census.test.ts`.
- `packages/domain/tests/integration/production.test.ts`, `tests/unit/t343-throw-ratchet.test.ts` and
  `tests/unit/client-bundle-boundary.test.ts` (`NewOrderForm` gains no import).

**Caller baseline:** no exported function is added or removed, so no diff is expected. If there is one, STOP.

**Smoketest (9008, screenshots, desktop and phone width).**
- (a) As staff on `/inventory/production`, post a run → the S2 sentence for `post_production`, not "Only a manager or admin can post…".
- (b) As a manager whose job is at store A, on `/inventory/counts?store=<B>`, open a count → the S2b sentence "…the
  Manager job that lets you is at A".
- (c) As an admin on your own `/admin/users/<self>` page, change your role → `You cannot change your own role. …`.
- (d) As staff on `/admin/access-defaults`, tick a cell → the S2 sentence for `grant_capability`.
- (e) `/trade/orders`: the new-order form shows `Line 1`, `Line 2`, `Line 3`. Type `abc` as line 3's rate → the banner
  reads `Line 3's rate — "abc" …`.

**Done when:** as "Done when (per slice)", plus:
- P1–P5, R1, N1, N2 and N3 go red, then green. Record the raw reds.
- DEF-452 is stamped FIXED.
- The Later-slices S7 line is closed: all 31 authorize-shaped app branches are gone, and none remains to list.

### S7 invariants (in addition to 1–22)
23. In every app `errorMessage`, a presentable error returns `sharedErrorMessage(err)` before any local branch. No app
    branch keys on `authorize()`'s raw text (`may not '…'`, `no store scope`, `authorize:`, `has no active role`).
    Behavioural legs prove this, not a source scan.
24. A refusal's sentence comes from its `userMessage`, written in `packages`. No app maps `err.capability` to a sentence
    of its own. A better sentence moves into the domain (the S5.3b precedent). It is never kept as an app override.
25. The raw `.message` is byte-identical at every `roles.ts` and `sessions.ts` site S7 touches (Invariant 1; K4). One
    exception: a trade line refusal with a `lineNo` numbers the line by its visible row. That is the S5.3b R3 ruling.
    Without `lineNo` the raw is byte-identical.

### S7 out of scope
- S8's raw returns in these same files (production `/live slicer payment/`, the staff `return raw` branches, the
  access-defaults `return raw` branch). After S7 these see only non-presentable errors, and they stay below the
  presentable guard. The four choke-point bypasses are also S8's.
- Wrappers keyed only on constraints, with no authorize branch: `expenses`, `remittance`, `till`,
  `statutory-discounts`, and the `SalesDayBlockedError` formatting in `sales-days`.
- Rewording any S2/S2b sentence.
- Trade dispatch, receive and void line refusals: only `createTradeOrder`'s loop is renumbered.
- POS, CUSTOMER and Website.

### Ian's answers (2026-09-27), folded above
1. **S5.5m wording table:** approved as drafted.
2. **S7:** option A. The three better admin sentences move into `roles.ts` (change 3), and legs R1/R1n are added.
3. **Trade row numbers:** added now, inside S7 (change 5). Order: S5.5m first, with rows 31–32 as "A line's rate/total".
   Then S7 changes them to `Line ${n}'s rate` / `Line ${n}'s total`.

Folded from the orchestrator's audit, in the bodies above:
- S5.5m:
  - It owns the presentable `handedOverOn` re-wrap; S8 keeps non-presentable re-wraps.
  - The tester amends the two-argument test files in the RED phase.
  - The builder's gate is a clean typecheck.
  - Invariant 20's guard is the reviewer.
  - No nested template literal in the re-wrap.
  - H1 follows the `createSalesDay` tender path.
  - Smoketest (c) uses Pay, not auto-allocate.
  - The ratchet wording is corrected.
- S7:
  - P3's admin/users row uses `person_credentials_external_id_unique`.
  - `sessions.ts:196`'s kind becomes `'sign-in account'` (change 4, P4b, P5).
  - The S8 scope shift is recorded.
  - Branches are found by regex in all 13 files.
