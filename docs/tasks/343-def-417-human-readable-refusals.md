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
- **S6b (DEF-431, folded in by Ian 2026-09-25)** `/admin/users/[id]` "Extra capability grants": show `CAPABILITY_LABEL`
  for held rows and the grant grid, with the key as secondary text at most. Show "…now held in their own right" only
  AFTER "Hold in their own right" succeeds, not beside every row beforehand. Evidence: `~/.claude/skills/orchestrator/tools/t341-admin-users-page.png`.
- **S2b (DEF-430, folded in by Ian 2026-09-25; lands after T-341)** a store-scoped refusal from axis 3b where the person
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
  — a bypass S8 does not list**). The S1 UUID gate never sees them.
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
`extends RefusalError` (name, `message`, `userMessage` unchanged). `record-gone.ts` exports pure
`goneSentence(what, notLonger?)`; `recordGone` uses it (one wording). `@shareat/db` exports both values. This departs
from the one-liner ("RefusalError in domain") because auth could not reach a domain class; the domain file still
exists as the producer API:

`packages/domain/src/shared/refusal.ts` (new) re-exports `RefusalError` and adds:
| Helper | Returns | Use |
|---|---|---|
| `refuse(raw, sentence)` | `RefusalError` | every refusal a person can act on |
| `gone(raw, what, notLonger?)` | `RefusalError`, `userMessage = goneSentence(…)` | "X does not exist" in domain |
| `internalFault(raw)` | `InternalFaultError extends Error`, **no** `userMessage` | unreachable invariants ("carries no journalEntryId — data inconsistency", "no ordering key"); shows S1's fallback and leaves the ratchet honestly |
| `humanDate(d)` | `formatBusinessDateTime(businessDayRange(d).start, { dateStyle: 'medium' })` | no second date formatter |

`refuse` throws a plain `Error` at call time if `sentence` is empty, multi-line, or contains a UUID (a programming
error, caught by tests, never by users). `message` is always `raw`, byte-identical (Invariant 1).

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
`/^(id|[a-z]\w*Id|uid)$/`), **key** (`itemKind|kind|disposition|role|capability`), else **plain**. It returns
`{ file, line, kind, callee, text }`, counts `refuse(`/`gone(`/`internalFault(` sites, and classifies `refuse`'s 2nd
argument with the same classifier.

### Groups: order and why
| # | Group | Rows | Sites | Why this position |
|---|---|---|---|---|
| S5.0 | foundation + widened scanner | — | 0 converted | everything below depends on it; the scanner must be trusted before any "0 left" |
| S5.1 | sales days + expenses | 7, 8, 12 | 56 | highest traffic: every store, every day (submit/verify/void a day; record/approve an expense) |
| S2b | DEF-430, listed above | — | — | T-341 landed (`4e986a3`); disjoint from S5.1 and may run beside it; **must precede S5a** (both edit `auth/src/refusal-text.ts`) |
| S5a | auth roles + credentials | 15 | 7 raw + 11 two-arg | admin-only traffic; serial after S2b |
| S5.2 | AP + customers + repo `ap.ts` | 9, 14b, new | 39 + 11 + 3 | weekly supplier and customer work |
| S5.3 | deliveries + catalogue + opening | 13, 14a, 16 | 10 + 16 + 9 | low traffic; `run_cutover` is once per org |
| S6 / S6b | labels; DEF-431, listed above | 10, 11 | — | S6b is UI-only and may run beside any S5 group; S6's kind and disposition labels are S5.4's precondition |
| S5.4 | commissary `Outcome` reasons | 10, 11 | ≈16 reasons | needs S6 labels and an app edit that overlaps S8 |
| S5.5+ | the ≈180 unowned sites (stock, production, …) | — | — | specced later; ledger, fixed-assets, stores and scheduler after T-346 |

**Ratchet rule (every group):** lower `CEILING` by exactly the number of raw `throw new Error(` the group removed
(measured before and after on its own files, both numbers in the commit message). Tightening to the measured total
(taking S3's 43) is done by the first S5 commit **after T-346 lands**; earlier would turn T-344..T-346 red. Never raised.

---

### S5.0: foundation and the widened scanner
**BUILDER:** `packages/db/src/refusal.ts` (new), `packages/db/src/repo/record-gone.ts`, `packages/db/src/index.ts`,
`packages/domain/src/shared/refusal.ts` (new), `packages/domain/src/index.ts` (one export line).
**TESTER:** `tests/unit/lib/throw-census.ts` (new), `tests/unit/t343-s5-throw-census.test.ts` (new),
`packages/domain/tests/t343-s5-refusal.test.ts` (new), `packages/db/tests/t343-repo-refusal-census.test.ts` (new `describe` only).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| W1 | + | fixture of 5 shapes (single template; multi-line template with trailing comma; `'…' + \`${x.supplierId}\``; `'store ' + storeId + '…'`; nested `${a ? \`${b.id}\` : ''}`) yields exactly 5 **id** hits at the right lines | green on arrival (tester code); record the S3 regex's count on the same fixture (expected 2) as the gap evidence |
| W2 | ⛔ | an id-free fixture (plain string; template interpolating only `amount`, `name`, `status`) yields 0 hits; AND the shared `assertFinds(scanner, fixture, 5)` helper **fails** when given `() => []` (a scanner that matches nothing must fail, DEF-179) | green on arrival |
| W3 | + | real tree: scanning `packages/db/src/repo` finds the 3 `ap.ts` id hits, and **visits** the `remittance.ts` nested-template throw and the `attendance-punches.ts` concatenated throw (present in the all-throws list) | green on arrival |
| W4 | + | db census `describe('T-343 S5.0 — widened scanner')`: every id hit is `recordGone(`, in `CLASSIFIED_INTERNAL`, or in `PENDING_S5_2` = exactly the 3 `ap.ts` sites (pinned by message substring); a stale `PENDING_S5_2` entry fails | green on arrival; S5.2 empties the list |
| F1 | + | `refuse(raw, s)`: `instanceof RefusalError` and `Error`, `message === raw`, `userMessage === s`, `name === 'RefusalError'` | import fails (module missing) |
| F2 | + | `gone(raw, 'expense', 'posted').userMessage === recordGone(raw, 'expense', 'posted').userMessage`; `recordGone(…) instanceof RefusalError` | missing |
| F3 | ⛔ | `internalFault(raw)` has no own `userMessage`; `message === raw` | missing |
| F4 | ⛔ | `refuse(raw, '')`, `refuse(raw, 'a\nb')`, `refuse(raw, \`x ${U}\`)` each throw at call time | missing |
| F5 | + | `humanDate('2026-09-25')` equals the `formatBusinessDateTime` expression above and contains `2026` and `25` | missing |

**Negative halves (unedited):** `packages/db/tests/t343-record-gone.test.ts` (byte-identical after the re-parent), the
S3 `C1` describe, `packages/auth/tests/errors-leaf.test.ts`, `tests/unit/t343-throw-ratchet.test.ts`.

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

**BUILDER:** the 9 source files above; `tests/unit/t343-throw-ratchet.test.ts` `CEILING` line only (lower by the
measured drop; `internalFault` sites leave the count too).
**TESTER:** `packages/domain/tests/t343-s5-domain-census.test.ts` (new; a `CONVERTED_DIRS` list each later group
appends to); `packages/domain/tests/integration/sales-days.test.ts` and `expenses.test.ts` (new
`describe('T-343 S5.1 …')` only); `apps/erp/tests/t343-s5-action-guard.test.ts` (new).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| D1 | + | census: `sales-days/`, `expenses/` have 0 raw `throw new Error(`; every `refuse(` 2nd arg classifies **plain** | red: 56 raw sites (record the list) |
| D2 | ⛔ | census floor: across `CONVERTED_DIRS`, `refuse(` + `gone(` + `internalFault(` ≥ 50 (a converted tree that scans empty fails) | red: 0 |
| E1 | + | `voidSalesDay` on an open day → `userMessage` exactly the `verify.ts:179` sentence with `open`; no UUID | undefined |
| E2 | + | duplicate `createSalesDay` → `userMessage` contains `humanDate(date)`, no UUID | undefined |
| E3 | + | `approveExpense` on a voided expense → exact sentence; `voidExpense` on a stale id → `/^That expense could not be found\./` | undefined |
| E4 | + | `createExpense` with supplier A's invoice and `supplierId` B → names both suppliers | undefined |
| E5 | ⛔ | each E1–E4 `err.message` still matches its current regex (`/only a verified day has a posting/`, `/already exists for store/`, `/is voided — cannot post/`, `/does not own supplier invoice/`) | green before and after |
| E6 | ⛔ | a planted verified day with no journal entry → `InternalFaultError` with no `userMessage`; through `errorMessage` → the S1 fallback | class missing |
| A1 | + | `voidSalesDayAction` (redirect mocked as in R7; real `constraint-messages`) with a mocked `voidSalesDay` throwing `refuse(\`… ${U}\`, s)` → decoded `error` === `s` | green if S1 holds; if red, report it (a bypass) |

**Negative halves (unedited):** `sales-days.test.ts`, `expenses.test.ts`, `expense-categories-admin.test.ts`,
`expenses-staff-float.test.ts`, `ap.test.ts`, every app test matching these messages; the full integration suite.
**Smoketest (9008):** void an open sales day; approve a voided expense. Sentences as tabled, both themes.

---

### S5a: auth roles and credentials (row 15), after S2b
`AuthorizationError` already takes `userMessage` (S2). `RefusalError` comes from `@shareat/db`.
- `roles.ts:367,586` · `credentials-admin.ts:45` → third arg `goneSentence('person')`.
- `roles.ts:393` → `Only a super admin can make someone ${ROLE_LABEL[input.role]}. Your role is ${ROLE_LABEL[actorRole] ?? 'none'}.`
- `roles.ts:447` → `This person is ${ROLE_LABEL[targetRole]}, which outranks you, so you can't change their role.`
- `roles.ts:577` → `new RefusalError(raw, "That isn't a permission this system knows.")`.
- id-free `AuthorizationError`s (`roles.ts:346,376,494,570,592`, `credentials-admin.ts:261`) → third arg, rule 4.
- `credentials-admin.ts:67,69,75,78,189,211` → `new RefusalError(raw, <same sentence>)` (already written for a person).
Sentences live in `packages/auth/src/refusal-text.ts`. ⛔ `errors.ts` untouched (Invariant 7); `capabilities.ts` read only.
**BUILDER:** `packages/auth/src/{roles.ts,credentials-admin.ts,refusal-text.ts}`; the ratchet `CEILING` line.
**TESTER:** `packages/auth/tests/t343-s5a-census.test.ts` (new); `packages/auth/tests/integration/roles.test.ts` (new `describe` only).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| K1 | + | census: `auth/src` has 0 raw `throw new Error(`; every `new AuthorizationError(` has 3 args | red: 7 raw, 11 two-arg |
| K2 | + | an admin assigning `super_admin` → `userMessage` contains `Super admin`, not `'super_admin'` | undefined |
| K3 | + | assigning a role to a missing person → `/^That person could not be found\./`, no UUID | undefined |
| K4 | ⛔ | K2/K3 `err.message` byte-identical to today; `roles.test.ts` case 6 (the DEF-177 absence) green unedited | green before and after |

---

### S5.2: AP, customers, and the repo sites S3 missed (rows 9, 14b)
Scope: `packages/domain/src/ap/index.ts` (39), `packages/domain/src/customers/index.ts` (11), and
`packages/db/src/repo/ap.ts:431,437,443` → `RefusalError`: `Invoice ${invoiceNo} from ${supplierName} has been voided, so
nothing more can be recorded against it.` · `… hasn't been verified yet, so this can't post against it.` · `… has only
₱${remaining} left of ₱${total}; ₱${amount} doesn't fit.` Names come from the `capacity` row; extend `capacityOf`'s
select with `invoiceNo` and the supplier name if absent (same query, no new one). Not-found → `gone`;
`ap/index.ts:747,754,756` name the expense by its human key (one refusal-path read); `:918`, `:1010`, `:1022` →
`internalFault` (states the caller cannot produce).
**BUILDER:** those three source files; the ratchet line. **TESTER:** census `CONVERTED_DIRS += ap, customers`; the db
census empties `PENDING_S5_2`; `packages/domain/tests/integration/ap.test.ts` (new `describe` only).

| Id | Leg | Asserts | Expected red |
|---|---|---|---|
| P1 | + | census: 0 raw in `ap/`, `customers/`; `PENDING_S5_2` empty | red: 50 + 3 |
| P2 | + | an expense against a voided invoice → names `invoiceNo` and the supplier, no UUID | undefined |
| P3 | + | `recordPayment` over-allocating one expense → names it as `"particulars" (date)` | undefined |
| P4 | ⛔ | P2/P3 messages match today's regexes; `ap-aging`, `ap-auto-allocate`, `supplier-master`, `supplier-returns` green unedited | green |

### S5.3: deliveries, catalogue, opening balances (rows 13, 14a, 16)
Scope: `deliveries/documents.ts` (10; `:126`, `:129` → `Line ${n}: …` by position; `:115` → `gone(raw, 'proof photo')`),
`commissary/catalogue.ts` (16; stores as `Name (CODE)`, items by name), `cutover/opening.ts` (9; `:164` →
`gone(raw, 'opening figure')`). **BUILDER:** those three files; the ratchet line. **TESTER:** `CONVERTED_DIRS +=` the
three files; one integration leg per file (new `describe` in the nearest existing file) + a ⛔ message-regex leg.
Red: 35 raw.

### S5.4: commissary Outcome reasons (rows 10, 11), after S6
`Outcome`'s failure arm gains optional `userReason?: string` (`commissary/outcome.ts`); every `reason:` in
`transfer.ts`/`discrepancy.ts` sets it: item kinds and dispositions through S6's labels, the `short` list by item
**name** (one refusal-path read of the listed ids), discrepancies deictically. Apps render
`result.userReason ?? result.reason` through the shared S1 redaction at the three `commissary/**/actions.ts` sites
above. Coordinate with S8, which owns the bypass list (`orders/[id]/actions.ts:106` is added to it). **TESTER:** census
in the scanner's `reason:` mode over the two files (red: ≈16 id/key reasons); one integration leg each for transfer
and discrepancy; ⛔ `reason` byte-identical.

### Invariants (S5, in addition to 1–11)
12. One `RefusalError` class; `recordGone` and `gone` share `goneSentence`.
13. `internalFault` never carries a `userMessage`; it is only for states no user input can produce.
14. No S5 group edits a file owned by T-344/T-345/T-346 until that task lands.
15. The ratchet only falls; every drop is the group's own measured count.

### Done when (per group)
As "Done when (per slice)" above, plus: the census lists the group's dirs and goes red→green with the raw list
recorded; `CEILING` lowered by the measured drop; the group's highest-traffic refusal smoketested on 9008. After S5.4,
DEF-417 part 2 rows 7–16 are stamped FIXED; the ≈180-site remainder stays open under S5.5+.

### S5 Amendment R1 — spec review (2026-09-25), binding
Independent Opus review returned CHANGES. Where this amendment and the S5 body differ, this wins.

1. **(HIGH) The fifth bypass was mis-traced.** `apps/erp/src/app/commissary/orders/[id]/actions.ts:106` shows
   `result.reason` from `postMessageAction` (`:67`) → `postOrderMessage`, whose id-bearing reasons are
   `packages/domain/src/commissary/messages.ts:40` and `:61` (`order ${input.orderId} does not exist`), not
   transfer/discrepancy. New group **S5.1b: commissary order messages**. It does not wait on S6 and runs any time after S5.0.
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
