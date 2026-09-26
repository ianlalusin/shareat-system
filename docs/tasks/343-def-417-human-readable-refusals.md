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
- **S6** labels for dispositions and item kinds (rows 10, 11) beside the enums in `packages/db/schema/*`; also the raw
  keys already on screen (`admin/access-defaults/grid.tsx:211,319` → `CAPABILITY_LABEL`; `admin/users/*` →
  `ROLE_LABEL`; `items/page.tsx` kind; `inventory/usage` reason codes).
- **S6b (DEF-431, folded in by Ian 2026-09-25)** `/admin/users/[id]` "Extra capability grants": show `CAPABILITY_LABEL`
  for held rows and the grant grid, with the key as secondary text at most. Show "…now held in their own right" only
  AFTER "Hold in their own right" succeeds, not beside every row beforehand. Evidence: `~/.claude/skills/orchestrator/tools/t341-admin-users-page.png`.
- **S2b (DEF-430, folded in by Ian 2026-09-25; lands after T-341) — now specced in full at §S2b (APPROVED 2026-09-26).** A store-scoped refusal from axis 3b where the person
  holds the capability via a position at OTHER stores must not blame the role. Name the store and where the job is, e.g.
  "…can't submit a sales day at SmokeStore Two — their Cashier job is at SmokeStore." Needs a refusal-only lookup,
  savepointed like S2's. Evidence: `t341-smk2-refusal.png`.
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
| S6 / S6b | labels; DEF-431, listed above | 10, 11 | — | S6b is UI-only and may run beside any S5 group; S6's kind and disposition labels are S5.4's precondition |
| S5.4 | commissary `Outcome` reasons | 10, 11 | ≈16 reasons | needs S6 labels and an app edit that overlaps S8 |
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
