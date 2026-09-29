# T-350: an admin can change a channel's payout account after it is set (DEF-477)

**Status:** S3 DONE 2026-09-28 (migration 0167; audit rows proven live). DONE 2026-09-28 (gates PASS; §9.4 forged-session smoketest 19/19; post-commit audit pending, option (a)). APPROVED 2026-09-28 (orchestrator). **Model:** Sonnet, tester then builder. **Migration:** none.
**Runs after** the T-343 S5.5v/u/w commit (`channel-settlements/actions.ts` is an S5.5v path).

## Why
Ian, 2026-09-28: *"admin must be able to change that when set cause in real world payment accounts can be updated."*
On `/channel-settlements` the payout-account picker (`apps/erp/src/app/channel-settlements/page.tsx:81-130`) renders
only for channels with NO account (`unwired`, `:53`). Once set, the channel card shows the account name
(`:158`) and nothing on screen can change it. The domain already allows a re-set: `setChannelPayoutDestination`
(`packages/domain/src/channel-settlements/index.ts:574`) has no "already set" refusal and is gated by
`manage_store_settings` for the channel's store. So the gap is the screen, plus refusals that are still developer
`throw new Error` text.

Changing the account is safe for history: a posted settlement's journal lines carry the account they used; the channel
setting is read only when a new settlement posts.

## Ian's ruling (2026-09-28): ADMIN ONLY
Both the first set and every later change need a new store-scoped capability **`set_channel_payout`** (super ✅, admin ✅,
manager ✗, staff ✗). ⚠️ The CAPABILITY-MATRIX.md row is added BY THE ORCHESTRATOR IN THE SAME COMMIT as `capabilities.ts` — `tests/unit/capability-matrix.test.ts` fails if the document and the union disagree (a pre-wired row made the gates red, 2026-09-28). Row text: "| `set_channel_payout` | store | ✅ | ✅ | **✗** | ✗ | T-350 / DEF-477. Ian, 2026-09-28: admin only. |" beside `set_cash_policy`. It replaces
`manage_store_settings` in `setChannelPayoutDestination`. Declare it exactly as `set_cash_policy` is declared in
`packages/auth/src/capabilities.ts` (the union `:232`, the list `:360`, scope `:530`, tier `:714`, the role table
`:921`, the human title `:1131` — "change where a sales channel's payouts bank"). Wherever this spec says
`manage_store_settings` below, read `set_channel_payout`. A manager now sees the account but neither the unwired panel's
form nor Change (the unwired warning still shows, with "an admin must set it").

## Contract
1. **Screen — `apps/erp/src/app/channel-settlements/page.tsx`.** Every channel card (`:142-160`) for a WIRED channel
   shows its payout account and, when the viewer holds `manage_store_settings` at that channel's store, a **Change**
   control that reveals the same form as the unwired panel (`setPayoutDestinationAction`, hidden `channelId`, a
   `moneyAccountId` select of that store's active accounts) with the current account pre-selected, plus a Cancel.
   Use a `<details>`/`<summary>` disclosure (server component, no client state). Viewers without the right see the
   account name only, no control. The unwired panel is unchanged.
2. **Capability check for rendering.** Decide visibility with the repo's existing server-side "can the actor do X at
   store Y" helper used by other pages (grep `can(` / `hasCapability` in `apps/erp/src/app`); the domain `authorize`
   stays the real gate.
3. **Domain — `setChannelPayoutDestination`.** (a) Choosing the account that is already set is a no-op success
   (no write). (b) The three `throw new Error(` refusals (`:582`, `:588`, `:595-601`) become `refuse(<same raw>,
   <human sentence>)`: "That channel no longer exists.", "That money account no longer exists.",
   "<account> belongs to another store. A channel banks into its own store's account — moving money between stores is
   a transfer, not a setting.", "<account> is retired, so nothing can be banked into it." Ratchet ceiling for
   `channel-settlements` lowers accordingly (tester).
4. **Banner.** On success after a change: `?ok=destination` reads "Payout account changed. New settlements bank into
   <account>." when the channel already had one; keep today's text for a first set. (Pass `changed=1` in the redirect.)

- **BUILDER paths:** `packages/auth/src/capabilities.ts`, `apps/erp/src/app/channel-settlements/page.tsx`, `apps/erp/src/app/channel-settlements/actions.ts`,
  `packages/domain/src/channel-settlements/index.ts`.
- **TESTER paths:** `apps/erp/tests/t350-channel-payout-change-render.test.ts` (new),
  `apps/erp/tests/integration/t350-channel-payout-change.test.ts` (new); ruled edit: `tests/unit/t343-throw-ratchet.test.ts`
  (channel-settlements ceiling only).
- **Red legs:**
  - C1: an actor with `manage_store_settings` changes a wired channel from account A to B → the channel reads B; a
    settlement posted before the change still shows A in its journal lines (red: none today — screen legs below are
    the red; C1 may be green at domain level, say so).
  - C2: choosing the same account again writes nothing (row `updated_at` unchanged, or no audit row).
  - C3: an actor WITHOUT the right at that store is refused by `authorize` (domain) and sees no Change control (render).
  - C4: another store's account → the human "belongs to another store" sentence (red: developer text).
  - C5: a retired account → the human "retired" sentence.
  - R1 (render): a wired channel card for a manager shows "Change" and a select pre-selected to the current account
    (red: no control today); R2: a viewer without the right sees no control.
- **§9.4:** tester changes a channel's payout account in Chrome on 9008 and records a settlement afterwards.
- **Extra legs (admin only):** C6 a MANAGER is refused both a first set and a change (red: allowed today); R3 a manager
  sees no form in the unwired panel and no Change. Capability-matrix tests (grep `CAPABILITY-MATRIX` in tests) must
  stay green with the new row — the tester adds the ✗-fires proof there if the suite requires one per capability.
- **Out of scope:** a change history screen.
- **Done when:** reds red→green, typecheck clean, ratchet not raised, smoketest done.

## S2: follow-ups from the post-commit review of `0ffb0fe` (APPROVED 2026-09-28, orchestrator)
Auditor findings were source-reading only (no plants); **the tester's reds are the verification** — a leg that is
green today is reported, not forced. **Model** Sonnet, tester then builder. **Migration** none.

- **F1 (HIGH) retired current account.** `page.tsx:~206`: the Change select only lists active accounts, so a channel
  whose current account is retired pre-selects option 0 and Save repoints to an account nobody chose. Fix: the select
  gets a disabled, selected placeholder "— choose the new account —" whenever the current account is not in the list
  (and the card names the current account as "(retired)"); `required` stays, so Save without a choice is refused by the
  browser and, server-side, by the existing "Choose the account" refusal. Red **S2-R1**: retired current account →
  no option is pre-selected except the disabled placeholder.
- **F2 (MED) render gate is org-wide.** `page.tsx:54-59` uses `heldCapabilities`, which ignores store scope. Fix: decide
  visibility per channel at the channel's store (the per-store holding check the repo already exposes — grep
  `heldCapabilitiesAtStore`/`canAtStore`/`authorize`-shaped read helpers; if none exists, STOP and report — do not
  write a new auth helper in the page). Correct the comment at `:51-53`. Red **S2-R2** (fixture: an admin scoped to ONE store, a channel in another; ⛔ must not be asserted through a `heldCapabilities` mock, which agrees with the bug): admin scoped to store A sees
  Change on A's channel, not on B's.
- **F3 + F5 (MED/LOW) banner.** A same-account no-op must not say "changed": the domain result carries `wrote`
  (or equivalent) and the action sets `changed=1` only when a write happened. The account name in the banner is read
  server-side from the channel, not echoed from the URL. Reds **S2-C7** (no-op → redirect has no `changed=1`),
  **S2-R3** (`?ok=destination&changed=1&account=X` for a channel whose account is not X does not render X).
- **F6 (LOW) empty list.** No active accounts at the store → the Change panel says so and shows no form (same as the
  unwired panel's sentinel). Red **S2-R4**.
- **F4 + F8 (MED/LOW) tests only (tester).** Add a cross-store leg: `set_channel_payout` held only at store A,
  channel in store B → refused (**S2-C8**). C3/C6 assert the refusal is the authorization refusal (the repo's
  `AuthorizationError` / role-may-not shape), not any throw.
- **F10 (LOW) test comment only (tester).** `capability-matrix.test.ts:424-430`: rewrite the justification (routing
  is not a ceiling) and state that the adminless-manager fallback (bible row 196) grants it.
- **F7 dismissed (orchestrator), on the RLS reason only.** (Load → authorize → refuse "no longer exists" would also be possible; revisit if this function's ordering is touched again.) Ids are opaque
  UUIDs and RLS confines the read to the actor's org, so the "probe" reveals only that an id in your own org exists.
- **F9 → Ian.** Whether a payout-account change must leave a record (audit row). Not built until he rules.

- **BUILDER paths:** `apps/erp/src/app/channel-settlements/page.tsx`, `apps/erp/src/app/channel-settlements/actions.ts`,
  `packages/domain/src/channel-settlements/index.ts`.
- **TESTER paths:** `apps/erp/tests/integration/t350-channel-payout-change.test.ts`,
  `apps/erp/tests/t350-channel-payout-change-render.test.ts`, `tests/unit/capability-matrix.test.ts` (comment only).

## Ian's rulings, 2026-09-28 (after S2)
- **F9 → YES:** payout-account changes are recorded in the audit log (bible §13 row 238). Built as **S3**; spec pending
  (mechanism: `audit_log` has no writer and FORCE RLS with zero policies).
- **Adminless fallback → KEEP:** with no admin, a manager may set/change it (bible §13 row 239). No code change —
  `capability-matrix.test.ts` already pins it.

## S3: record every payout-account change in the audit log
Ian, 2026-09-28 (bible §13 row 238): *"record payout account changes in the audit log"*: who, when, old → new account,
per change; a same-account no-op records nothing. **Model** Sonnet, tester then builder. **Migration** YES, `0167`.

### Decision: (A). This is the first writer of `audit_log`; the table gains `org_id` and org-scoped policies
- **(A) chosen.** Ian said *the audit log*, and it already exists for exactly this: `schema/audit-log.ts` (actor,
  action, entity, entity_id, before/after jsonb, source, occurred_at, append-only per bible §4.2 rule 9). It is
  `system_only` for ONE stated reason: *"no org column today … until Phase 2 adds the column"* (`rls/registry.ts:285-291`,
  `0011:146-148`). Adding the column is the planned path, not a workaround. v1 has the same shape: one generic
  per-store activity log written from many actions (`ERP-rebuild/src/lib/server/activity-log.ts`), never a table per
  setting. A reusable log also answers DEF-169 (zero writers) the boring way.
- **(B) rejected.** `period_overrides` chose its own table because it needs an FK to `journal_entries`, so "an override
  with no entry" is unrepresentable (`period-overrides.ts:57-63`). A payout change has no such partner row. A new
  `channel_payout_history` would be a one-off, and the next audited setting would need another.
- **(C) rejected.** `systemTransaction` cannot reach it: the caller list is closed. The ⛔ at `client.ts:144` ("never add
  a policy to make the app role work") is about tables with NO org column that hold captured PII; once `audit_log`
  carries `org_id` it is an ordinary tenant table. `sales_channels.updated_at` records only when, not who or what.

### Rulings (planner)
- **A first set is recorded too** (none → A). It changes where money banks; `before` carries nulls.
- **Row shape:** `org_id` = actor.orgId, `actor_person_id` = actor.personId (never null: the repo signature takes
  `string`, so a user action without an actor does not compile), `action` = `'set_channel_payout'` (the capability
  name, greppable), `entity` = `'sales_channels'`, `entity_id` = channelId, `source` = `'web'`,
  `before` = `{ "moneyAccountId": <old id|null>, "moneyAccountName": <old name|null> }`,
  `after` = `{ "moneyAccountId": <new id>, "moneyAccountName": <new name> }`, `occurred_at` default now().
  Names are captured at write time, so a later rename cannot rewrite history.
- **Same transaction, only when `wrote === true`,** immediately after `R.setDestinationAccount`. The old account's name
  is read with `moneyAccountsRepo.getById` (it returns retired accounts too) before the UPDATE. The no-op and every
  refusal return before either write.
- **`source` is `'web'` inside the domain** because the ERP screen is this function's only caller
  (`actions.ts:197`). Say so in a comment: a second front-end calling this must thread `source` through, not inherit `'web'`.
- **Who may read:** org members, through RLS, the same as `sales_channels`. No reader or screen is built (out of
  scope, as in S1). A future viewer adds a capability; RLS alone is not the gate for a screen.

### Migration `0167_t350_audit_log_org_scope.sql`, hand-authored (ADR-012 §5)
The header names T-350 S3 / bible row 238 / DEF-169, gives the why (above), and says `Hand-authored per ADR-012 §5`. Journal:
`{ idx: 167, version: "7", when: 1800502307084, tag: "0167_t350_audit_log_org_scope", breakpoints: true }`
(= 0166's `when` + 86_400_000). No snapshot file. Statements:
1. Guard: a `DO` block that raises `'audit_log has rows; 0167 cannot assign them an org'` if `EXISTS (SELECT 1 FROM
   "audit_log")`. The table has never had a writer (DEF-169; the 2026-08-24 purge review counted 0), so this should
   never fire. If it does, stop rather than guess an org.
2. `ALTER TABLE "audit_log" ADD COLUMN "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT;`
3. `CREATE INDEX "audit_log_org_occurred_at_idx" ON "audit_log" ("org_id", "occurred_at");`
4. Policies, one per command and deliberately NOT `FOR ALL`: `CREATE POLICY "audit_log_org_read" ON "audit_log" FOR SELECT
   USING ("org_id" = app_current_org());` and `CREATE POLICY "audit_log_org_append" ON "audit_log" FOR INSERT WITH
   CHECK ("org_id" = app_current_org());`. There is no UPDATE/DELETE policy, so under FORCE RLS the app role can never
   touch a written row. Use `app_current_org()` only, never raw `current_setting` (DEF-077). ENABLE/FORCE are already
   on (0011).
5. Append-only trigger, modelled on `0082:141-153` (`attendance_punches_refuse_mutation`): `audit_log_refuse_mutation()`
   raises `restrict_violation` on every row UPDATE/DELETE, unconditionally, for every role including the owner.
   ⚠️ The cutover purge TRUNCATEs (`cutover/purge.ts:18-27`), and row triggers do not fire on TRUNCATE, so `purge` still
   works. No GRANT is needed (0011's default privileges cover it).

### BUILDER items
- B1 `packages/db/schema/audit-log.ts:15-24`: add `orgId: uuid('org_id').notNull().references(() => organizations.id,
  { onDelete: 'restrict' })`, the new index, and `// NOTE: policies + append-only trigger hand-added in migration 0167`.
  Update the header comment (org-scoped from 0167; T-350 is the first writer).
- B2 `packages/db/migrations/0167_t350_audit_log_org_scope.sql` (new) + `packages/db/migrations/meta/_journal.json`.
- B3 `packages/db/src/rls/registry.ts:285-291`: set `audit_log` to `scope: 'org_column'` and rewrite the reason (org
  column added in 0167; read/append only, no update/delete policy; append-only trigger).
- B4 `packages/db/src/cutover/classification.ts:170-175`: stays `purge` and the reason still holds. No edit unless a
  guard demands one.
- B5 `packages/db/src/repo/audit-log.ts` (new): `append(tx, orgId, { actorPersonId: string, action, entity, entityId,
  before, after, source })` does a drizzle insert and returns the id. Export `auditLogRepo` from `packages/db/src/index.ts`
  beside `channelSettlementsRepo` (`:186`).
- B6 `packages/domain/src/channel-settlements/index.ts:700-721`: read the old account (if any) before the UPDATE. After
  `R.setDestinationAccount`, call `auditLogRepo.append(trx, actor.orgId, {...})` following the row-shape ruling.

- **BUILDER paths:** `packages/db/schema/audit-log.ts`, `packages/db/migrations/0167_t350_audit_log_org_scope.sql`,
  `packages/db/migrations/meta/_journal.json`, `packages/db/src/rls/registry.ts`, `packages/db/src/repo/audit-log.ts`,
  `packages/db/src/index.ts`, `packages/domain/src/channel-settlements/index.ts`.
- **TESTER paths:** `apps/erp/tests/integration/t350-s3-audit.test.ts` (new), `packages/db/tests/integration/audit-log-rls.test.ts`
  (new). Ruled edit: `tests/unit/rls-registry.test.ts:102-106` (drop `audit_log` from the system_only list and assert it
  is `org_column`).
- **Red legs.** Run them through `asOrg`, i.e. the restricted app role, never the owner connection (which bypasses RLS).
  - **C9** an admin changes A → B: exactly one `audit_log` row. Its org is the channel's org, actor = the admin's person id
    (not null), action `set_channel_payout`, entity `sales_channels`/channelId, source `web`, before `{A id, A name}`,
    after `{B id, B name}`. Red: nothing writes the table, and the app role cannot insert (42501, zero policies).
  - **C9b** a first set, none → A: one row, before `{null, null}`. Red: same.
  - **C10** choosing the same account again: zero new rows. ⚠️ Green today because nothing writes; report it. It starts
    to matter after B6.
  - **C11** refused changes write zero rows: a manager (non-fallback), another store's account, a retired account,
    S2-C8's cross-store actor. Green today for the same reason; report it, do not force it.
  - **C12** atomicity: the change runs inside a tx that then throws, so neither the channel's new account nor an audit
    row persists. Green today (vacuously); report it.
  - **L1** org A's principal reads its own audit row (count 1). Red: system_only, so the tenant sees 0.
  - **L2** org B's principal reads 0 of org A's rows. It must stay green after 0167; this is the leak guard.
  - **L3** org A's principal inserting a row with org B's `org_id` → 42501 (WITH CHECK). Today every insert is refused,
    so this is green for the wrong reason; after 0167 the org check is what refuses. Assert by SQLSTATE and pair it with L1.
  - **L4** the app role's UPDATE/DELETE of its own org's row affects 0 rows and leaves the row unchanged. The owner
    connection's UPDATE and DELETE → `restrict_violation` (23001). Red: there is no trigger.
  - **L5** unit: the registry scope for `audit_log` is `org_column`. Red: it is `system_only`.
  - **L6** the existing cutover purge integration test still passes with the trigger in place (the TRUNCATE path).
- **Also (orchestrator, not builder):** DEF-169 becomes partially resolved (first writer). `docs/CAPABILITY-GAPS.md:423,447`
  no longer holds "zero writers", and the "zero writers" notes in `docs/discovery/28-reference-data-administration.md:547`
  and T-229/T-230 are now history.
- **Out of scope:** an audit-log viewer; auditing any other setting.
- **Done when:** C9/C9b/L1/L4/L5 go red→green; C10/C11/C12/L2/L3/L6 are green; the migration is proven from zero on a
  scratch DB (ADR-012 §5 item 8); typecheck is clean; the ratchet is not raised. §9.4: the tester changes a payout
  account on 9008 and reads the row back with a psql select.
- **Questions for Ian:** none. Recording the first set is a planner ruling above; he can reverse it by saying so.

### S3 orchestrator amendments (bind; from the independent spec audit, 2026-09-28) — S3 APPROVED with these
- **M1.** L2 and L3 are RED today (no `org_id` column → 42703 before RLS). Move both to red→green; L3 asserts SQLSTATE
  42501 after 0167.
- **M2.** L6 must seed: insert an `audit_log` row as owner, run `applyPurge`, assert the row is gone — proves
  `purge.ts:355`'s TRUNCATE passes the append-only trigger.
- **M3 (planner ruling).** Classification stays `purge`; B4 rewrites the reason at `classification.ts:170-175`:
  "rows written before cutover record rehearsal and pilot actions, not production history; they are dropped at
  cutover." Builder path added: `packages/db/src/cutover/classification.ts` (reason text only).
- **M4.** Builder path added: `packages/db/src/client.ts:143-147` — take `audit_log` out of the zero-policy sentence.
- **M5.** Every statement in 0167 separated by `--> statement-breakpoint`, including the DO guard and the trigger
  function (ADR-012 §5 item 2).
- **M6 (adopted, DEF-183 pattern; bible §15.11 layering).** The INSERT policy's WITH CHECK also requires
  `actor_person_id IS NULL OR EXISTS (select 1 from persons p where p.id = actor_person_id and p.org_id = app_current_org())`.
  Red leg **L7**: an insert naming another org's person as actor → 42501.
- B6's line numbers are against the S2 tree; re-derive at the S2 commit.
- **Tester deviation, accepted (orchestrator):** L6 uses a raw `TRUNCATE audit_log CASCADE` instead of `applyPurge`
  (which needs a scratch-DB harness). It still proves the append-only trigger does not block TRUNCATE, which is what
  `purge.ts:355` issues. All S3 reds are 42703 today (no `org_id`), so L3/L7 only become 42501 assertions after 0167.

## S4: follow-ups from the executed review of `55077ef` (APPROVED 2026-09-28, orchestrator)
F1, F2, F6, F3's domain half and DEF-480..483 were verified closed by mutants. Open items. **Model** Sonnet, tester
then builder. **Migration** none.
- **G1 (MED, tester).** F3's action half is unpinned: reverting `changed = result.wrote && result.hadAccountBefore`
  (`actions.ts:129`) keeps all 35 tests green. New leg: the ACTION's redirect for a same-account save carries no
  `changed=1` (and, per G5, the no-op sentence).
- **G2 (MED, builder + tester).** The "changed" banner still asserts a write with no DB fact behind it. Now that S3
  records changes, the banner reads the channel's latest `audit_log` row (`action` for payout changes, this org): it
  says "Payout account changed. New settlements bank into <after name>." only when that row exists, was written by
  the VIEWER, and is under 10 minutes old; otherwise no change banner. Legs: a forged URL with no audit row → no
  banner; a real change → banner with the audit row's name.
- **G3 (MED, tester).** S2-R3 needs a positive control: pass a real `changedChannel=` and assert the real account name
  renders (the server-side lookup is otherwise untested).
- **G4 (LOW, builder + pin).** The redirect's `channel=<id>` collides with the settlement form's preselect register
  (`page.tsx:398`). Use `changedChannel=<id>` for the banner.
- **G5 (LOW, builder + pin).** A same-account save must not show the first-set sentence: `?ok=destination&same=1` →
  "No change — <account> is already this channel's payout account."
- **G6 (LOW, builder + tester leg) = DEF-486.** `packages/domain/src/owners/index.ts:99` `/^\d{1,3}(\.\d{1,3})?$/`
  refuses `"0050"` though 50 is in range (the last DEF-481-shaped digit-run cap). Check the value, state the ceiling.
- **Dismissed (orchestrator, reasons recorded):** F8 — `items/index.ts:290`'s header finiteness re-throw is now
  unreachable (price ≤ 10 integer digits, quantity ≤ ~1e11); losing I6's coverage of it is correct, noted here. F9 —
  one `authorize()` per distinct store on load: stores per org are single digits today; revisit if an org passes ~10.
- **BUILDER paths:** `apps/erp/src/app/channel-settlements/{page.tsx,actions.ts}`, `packages/db/src/repo/audit-log.ts`
  (a read), `packages/domain/src/owners/index.ts`. **TESTER paths:** the T-350 test files + a new
  `apps/erp/tests/integration/t350-s4-banner.test.ts`, and an owners test for G6.

## S5: the payout banner is derived ONLY from the audit row (APPROVED 2026-09-29, orchestrator — DONE 2026-09-29)
From the executed review of `abe22f2`: S4's `same=1` re-introduced the URL-only claim one branch over (A), the flag is
unpinned end-to-end (B), the reader ignores `before` so a first set reads as "changed" (C), an unlisted channel falls
through to the first-set sentence (D), and the suppression arm is unpinned (E). Adopting the auditor's acceptance
criterion instead of another per-symptom fix:
- **Rule.** After a payout save the action redirects to `?ok=destination&changedChannel=<id>` and NOTHING else about
  what happened. The page reads that channel's latest `audit_log` payout row (viewer is the actor, < 10 min, this
  org) and derives the sentence from its `before`/`after`:
  - `before.moneyAccountId` null → "Payout account set. <after name> is where this channel's settlements bank.";
  - otherwise → "Payout account changed. New settlements bank into <after name>.";
  - no qualifying row (a same-account save writes none; a forged or stale link has none; a failed read) → **no
    banner**. A same-account save simply returns to the page.
  - `ok=destination` never falls back to `OK_MESSAGE.destination`; that entry is removed.
- **Every sentence arm has a leg that goes red when that arm is deleted** (set, changed, no-row, stale, other actor,
  failed read, unknown/unlisted channel), plus one action→redirect→render round-trip leg for each of set / changed /
  same-account. The spec's G1 prose is corrected: the pinned revert is `changed = result.hadAccountBefore`.
- F (the repo-level `orgId` filter is test-unpinned) → add one leg; RLS already proven.
- **BUILDER paths:** `apps/erp/src/app/channel-settlements/{page.tsx,actions.ts}`. **TESTER paths:** the T-350 test
  files (render + integration) and `t350-s4-banner.test.ts`.

### S6 — follow-ups from the executed post-commit review of `fa83e01` (APPROVED 2026-09-29, orchestrator)
S4's three MEDIUMs are closed by verification: every S5 banner arm and all three round-trips die under mutation;
`same=1` and the unpinned `same` flag are structurally gone (the action sets no flag; the banner reads the audit row).
- **G1 (MED, tester).** S5 item F was never done: `packages/db/src/repo/audit-log.ts:89`'s `eq(auditLog.orgId, orgId)`
  is unpinned. The auditor deleted it and every banner/audit test stayed green (each fixture has ONE org). Add a leg
  with TWO orgs, the other org holding a newer payout audit row for the same channel id shape: `latestForEntity`
  returns this org's row. Must go red with the filter deleted. Run it as a role that can SELECT both orgs' rows (or
  RLS masks the filter's absence) — say which.
- **G2 (LOW, builder + tester pin).** `packages/domain/src/channel-settlements/index.ts:743`: `before.moneyAccountId`
  comes from the account LOOKUP (`oldAccount?.id ?? null`); key it off `config.destinationMoneyAccountId` and keep
  the lookup for the name only. Unreachable today (no hard-delete of `money_accounts`); fix is one line.
- **G3 (LOW, tester).** One unreproduced cold-run red of `t350-channel-payout-change.test.ts > C1` (5/6 and 10/10
  green since; text lost). Reproduce cold (`--no-cache`, full reporter, all four slice files, ×5) or record "not
  reproduced".
