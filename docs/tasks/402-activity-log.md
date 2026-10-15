# T-402: Activity log, one immutable log for ERP, POS and the customer app, tagged and graded

**Status:** **S2 DONE 2026-10-14** (security events, denial outbox); **S3 BUILT on lane/t402-s3, NOT merged** (open audit findings, one data-loss race in the purge, see end of doc). Next: fix S3, then S4 viewer, S5. | **S1a+S1b DONE 2026-10-13, live** (PR #23 + deploy fix PR #24, migration 0197). Next: S2 security events, S3 money/data events + envelope, S4 viewer, S5 nightly partitions. | Earlier: SPEC APPROVED WITH CHANGES 2026-10-13 (fresh Opus review applied). Ian: build now. Q1-Q6 unanswered: the **Ian 2026-10-13: Q1-Q6 answered "go with recommendation" — the recommended options are rulings.**
recommended options are built. Drafted 2026-10-13 by the Opus planner.
(≈6.5 lane-days, six slices.) Pulled forward from Phase 7 row A2 (`docs/plans/remaining-build-plan.md:99`),
overriding Q11 (a) for this one item. Migration **0NNN, the next free number at merge** (0194 is deployed, 0195 is
T-392 S3 in PR #21, 0196 is T-401 on a lane). Six questions for Ian below; the recommended option is what gets built.

## Goal

Ian: *"capture every log in ERP, POS and customer app by maintaining an activity log with proper tags like security,
order, money movement etc. and sensitivity like critical."*

**One log, the existing `audit_log`, extended.** Every row carries a **category** and a **sensitivity** that come from
a **fixed event catalogue**, never from the call site, so a label can never be wrong. An admin sees every store; a
manager sees only their own store. Nobody edits a row. Money and order history is kept 10 years; low-sensitivity
noise 2 years. The POS and the customer app (v2, not built yet) write through the same server path with an envelope
that survives offline replay without duplicates.

## Source

- Ian's request and approval of the proposal, 2026-10-13 (this task's brief): extend `audit_log`, catalogue, retention
  10y / 2y, admin all stores / manager own store, new capability, four slices, POS/customer envelope, the in-person
  diner password reset rule.
- `packages/db/schema/audit-log.ts`, `packages/db/src/repo/audit-log.ts` (`append`, `latestForEntity`),
  migration `0167_t350_audit_log_org_scope.sql` (org column, SELECT + INSERT policies, DEF-183 actor check, the
  unconditional append-only trigger; TRUNCATE is not blocked, which the cutover purge relies on), migration 0194
  (same-org composite FKs: `persons_org_id_id_unique`, `stores_org_id_id_unique`).
- The **20 existing `auditLogRepo.append` call sites, 22 distinct actions** (discovery 2026-10-13, all snake_case):
  `reopen_pin_sign_in`; `set_supplier_credit_terms`, `set_supplier_status`, `set_supplier_bank_account`,
  `set_supplier_counterparty_store`; `set_channel_payout`; `set_customer_status`; `change_item_base_unit`,
  `set_item_purchase_unit`, `rename_item`, `retire_item`, `restore_item`; `set_staff_code`; `link_store_to_pos`,
  `unlink_store_from_pos`; `create_tender`, `update_tender`, `reactivate_tender`, `retire_tender`; `edit_sales_day`,
  `reimport_sales_day`, `set_platform_sales`. Sites: `packages/auth/src/credentials-admin.ts:300`;
  `packages/domain/src/ap/index.ts:284,299,331,369`; `channel-settlements/index.ts:791`; `customers/index.ts:116`;
  `items/index.ts:157,223,272,307`; `people/index.ts:138`; `pos/store-link.ts:142,223`; `pos/tenders.ts:140,215,249`;
  `sales-days/edit.ts:90`, `sales-days/import.ts:296`, `sales-days/platform.ts:98`. One reader: `latestForEntity`
  (`apps/erp/src/app/channel-settlements/page.tsx:110`). 72 test files touch `audit_log`. Migrations 0168-0170
  also touch it (0168 REVOKEs UPDATE/DELETE from the app role, T-354), and `packages/db/src/triggers/registry.ts`
  registers its trigger: S1a reads all three before writing DDL.
- Auth (discovery): `signInWithPin` `sessions.ts:85`, `signInWithFirebase` `:265` (**the password check happens in
  Firebase, not here**), `setPin` `:513`, `signOut` `:431`, `endShift` `:454`, `endAllForDevice` `:474`;
  `credentials-admin.ts` `linkFirebaseCredential` `:146`, `unlinkCredential` `:186` (no audit row today);
  `roles.ts` `assignRole` `:101`, `assignRoleAsActor` `:324`, `grantCapabilityAsActor` `:582`, `elevateManager` `:700`
  (none audited); `authorize.ts:106` throws `AuthorizationError` (`errors.ts:46`); `pin-attempts.ts` already keeps
  every PIN miss for 90 days (`ATTEMPT_RETENTION_DAYS`, `:28`). Capabilities: `packages/auth/src/capabilities.ts`
  (`Capability` `:75`, `CAPABILITIES` `:290`, `CAPABILITY_SCOPE` `:402`, `CAPABILITY_AREA` `:623`,
  `CAPABILITY_MATRIX` `:742`, `CAPABILITY_LABEL` `:1074`).
- Scheduled jobs: `packages/domain/src/scheduler/index.ts`, `docs/discovery/34-scheduled-job-pattern.md`, the
  `docs/ops/*.{service,timer}` pairs. Bible §4.2 rule 10 (`PROJECT_BIBLE.md:769`): idempotency keys are UNIQUE
  constraints. ADR-015 (POS and customer on the shared backend, 24 h offline selling). No diner credential table
  exists (`schema/customers.ts` is B2B: "a retail diner is NOT a customer"); diner auth is ADR-015 P3.
- `docs/decisions/CAPABILITY-MATRIX.md` (four roles, scope column, rule 1 "every ✅ has a denial test", §C.2 admins
  hold materialised store rows), T-121 (the typed matrix with a build guard).
- T-303 / T-395 (`packages/db/src/repo/pin-attempts.ts`, `packages/auth/src/sessions.ts` `signInWithPin`, the
  stopped-for-the-day finding), T-304 (server-attested terminal identity, `resolveTerminalIdentity`).
- Bible §4.2 rule 9 (append-only), row 283 (v1 owns the goal, not the method), §1.2d, row 296 (migrations get a PR).
- v1, read as requirements (read-only): `ERP-rebuild/src/lib/server/activity-log.ts`, `src/types/activity-log.ts`
  (≈94 actions; the screen flags, comments on and resolves entries); `POS/src/components/cashier/activity-log.ts`
  (`writeActivityLog`), action enum `POS/src/lib/types.ts:1616`; `CUSTOMER/src/lib/server/loyaltyLog.ts`.

## Research (row 283: research, evaluate, propose)

### v1's goal, and v1's method

| v1 | Goal (kept) | Method's flaw (not kept) |
|---|---|---|
| ERP `activityLog` (`stores/{id}/activityLog`; ≈108 literal actions + ≈10 dynamic, ≈129 call sites in 45 files, no central enum) | "Who changed what, when, in which store" on one screen: tabs by actor type/position, date, action, flagged/resolved status, search, CSV export | Free-text action strings at each call site, and the screen labels only ≈38 of them; no category or severity; no before/after (free `details`/`meta`); fire-and-forget with errors swallowed, so a failed write loses the event silently; flag, resolve and comments are **fields on the log row** (admin flags/resolves, any staff comments with a client-supplied role) and admins can **hard-delete** a row; no retention |
| POS `writeActivityLog` (44-value enum `types.ts:1621`, 40 call sites, dual write per session and per day) | A cashier's voids, discounts, price overrides, receipt edits/voids/refunds and approvals are traceable to a person, with before/after and the session context | The cashier **device writes its own evidence** straight to Firestore, best-effort, errors swallowed; the only grade is an optional `meta.severity` low/medium/high; no cash-drawer or manager-override event exists at all |
| CUSTOMER `loyaltyLogs` (10 call sites in 5 routes; `password_reset` declared, never written) | Every account creation, sign-in, failed sign-in, point earned, redeemed or transferred is explainable | Full phone numbers stored; types drift (callers pass values the type does not declare); a separate log per app. **Password reset today:** the dialog says "ask our manager to reset it"; no reset route exists in CUSTOMER, which matches Ian's in-person rule |

**Goal, stated once:** every consequential act, in any app, is recorded once, by the server, unchangeably, graded by
how much it matters, and readable by exactly the people entitled to it.

### The industry pattern

Security and audit logging practice (OWASP Logging Cheat Sheet, NIST SP 800-92, PCI-DSS req. 10, RFC 5424 severity):
an **event catalogue** (the event type decides its own severity, not the developer at the call), **server-side**
capture, **tamper resistance** (append-only, separate from the writer's control), **who / what / when / where / outcome**
in every record, **no secrets in logs**, **retention by class**, **review by role**, and **aggregation of high-volume
noise** (a failed-authorisation storm is one summarised event, not a million rows).

**Adopted:** all of the above. **Not adopted, and why:**

| Not doing | Why |
|---|---|
| A second log system (an `activity_log` table, an ELK / Loki stack, a SaaS SIEM) | `audit_log` already has the org scope, RLS, the DEF-183 actor check and the append-only trigger. A second store splits the truth and doubles the review. A SIEM is a cost and a credential we do not need at 4 stores |
| Free-text category/sensitivity at the call site | That is v1's flaw. The catalogue decides |
| Logging every POS line item ("item added") | The sale tables already hold the sale. The log records **exceptions and control points** (void, discount, comp, refund, price override, reopen, drawer open). This is also what keeps volume inside the droplet |
| Deleting rows for retention | The trigger refuses DELETE unconditionally and stays that way. Retention drops **whole partitions** of the short-retention class (R7) |
| Hash-chaining rows (tamper-evident chain) | Useful against a DB superuser; our threat is the app role and a careless migration, which RLS + the trigger already stop. Revisit if an external auditor asks |
| Flag / comment / resolve on log rows (v1 screen) | Not in T-402: see R12 and Q1. It needs a separate mutable table, and the Findings engine already does "something is wrong, someone resolves it" |

### Volume (unmeasured; designed for it, measured in Done-when)

Ian's estimate is 5-10k events/day across 4 stores. At ≈1.2 KB per row with indexes that is 6-12 MB/day,
**≈2-4.5 GB a year**, so ≈20-45 GB over the 10-year class on a 4 GB-RAM droplet. Three decisions follow:
1. **Exceptions, not lines** (above). Expected real volume is nearer 1-3k/day.
2. **`authorize()` denials are aggregated** (R9): the first denial per actor, capability and store per day is its own
   row; the rest are one summary row per hour bucket.
3. **Partitioned by year and retention class** (R6), so the 2-year class is dropped without a DELETE and each year's
   indexes stay small. A payload cap (R5) bounds the worst row.

## Rulings

| # | Ruling |
|---|---|
| R1 | **Extend `audit_log`; no second table for events.** New columns: `store_id uuid NULL` (same-org composite FK to `stores (org_id, id)`, 0194's pattern), `category`, `sensitivity`, `severity smallint`, `retention_class`, `recorded_at timestamptz NOT NULL DEFAULT now()`, `device_id uuid NULL` (server-attested terminal person, T-304), `uploaded_by_person_id uuid NULL` (R10: the session
that uploaded an offline event, kept apart from the actor who did it; same-org composite FK), `event_key text NULL` (offline idempotency, R10), `redacted_keys text[] NOT NULL DEFAULT '{}'`, `clock_suspect boolean NOT NULL DEFAULT false`. `occurred_at` keeps its meaning (when it happened; device time for a replayed offline event). Existing columns unchanged. The 22 existing action strings are kept **byte-identical** (`latestForEntity` reads by action) |
| R2 | **The event catalogue is closed, typed and in one file**: `packages/db/src/audit/catalogue.ts`. One entry per action: `action` (dotted, `<area>.<verb>`), `category`, `sensitivity`, `retention` (derived, R7, never written by hand), `scope` (`store` = `store_id` required, `org` = `store_id` must be null), `actor` (`person`, `system` or `either`), `viewers` (`store` or `admin`), `entity`, `owner` (task id), `reserved` (true while no caller exists: POS v2, customer v2, and every S2/S3 entry until its
slice flips it), `clientSources` (the sources allowed to send it through the R10 envelope: `[]` for every server-only
entry; POS may send only `pos.*` and `order`-category entries, the customer app only `customer.*`/`loyalty.*`; never
`security.*`, `auth.*`, `role.*`, `capability.*`, `credential.*`, `manager.*`, `cutover.*` or `data.*`). The writer **refuses an unknown action** (throws `UNKNOWN_AUDIT_ACTION`) and **refuses a scope mismatch**. A build guard test fails if two entries share an action, if a reserved entry has a caller, or if a non-reserved entry has none |
| R3 | **Categories (9):** `security` (sign-in, sessions, PINs, credentials, grants, denials), `order` (POS order exceptions: void, comp, discount, price override, reopen, refund), `money` (cash, tenders, remittances, expenses, AP, settlements, approvals before posting), `menu_price` (menu items, prices, price lists, catalogue), `stock` (counts, adjustments, wastage, transfers, receiving corrections), `staff` (people, positions, pay rates, attendance corrections), `settings` (store and org configuration, POS links, cash policy), `data` (exports, bulk imports, ETL loads, cutover steps), `customer` (diner accounts and loyalty points). One action has exactly one category |
| R4 | **Sensitivity (4), mapped to RFC 5424 severity**, stored as both (CHECK binds them): `critical` = 2 (Critical: a control was breached or overridden: lockout-for-the-day, credential reset of an admin, cutover purge, an export of personal data), `high` = 4 (Warning: grants, credential changes, PIN lockouts, refunds, voids after payment, cash-drawer no-sale, diner password reset), `normal` = 5 (Notice: ordinary changes of record), `low` = 6 (Informational: sign-in success, session expiry, view-only events) |
| R5 | **Redaction, at the writer, always, by key TOKENS.** Before insert, `before`/`after` are walked recursively. Each key is split into lower-case tokens on camelCase boundaries, `_` and `-` (`pinHash` → `pin`,`hash`; `API_KEY` → `api`,`key`). A key is redacted when any token is one of `password`, `passcode`, `pin`, `secret`, `token`, `otp`, `hash`, `salt`, `scrypt`, `cookie`, `authorization`, `jwt`, or when adjacent tokens are `api`+`key`, `private`+`key`, `session`+`id`, `refresh`+`token`. Its value becomes `"[REDACTED]"` and its path is appended to `redacted_keys`. Independently of the key, a string value that looks like a scrypt hash (`scrypt$…`), a JWT (`eyJ…` with two dots) or a session token shape is redacted. The test carries a **false-positive list** that must survive untouched (`pinned`, `isPinned`, `spinach`, `opinion`, `shipping`, `hashtag`, `tokenized`… as whole keys whose tokens are not in the set). **Payload cap:** `before` + `after` ≤ 16 KB serialised; above it the writer stores a diff of changed top-level keys and sets `after.__truncated = true`. Personal identifiers in security events are masked (`i***@shareat.net`, `09** *** 1234`). **Masked, not redacted:** a key whose last tokens are `account`+`number` keeps its last 4 digits (`••••1234`), and the writer adds `<key>Changed: true|false` (before vs after compared **before** masking) beside it, so a change stays visible; this changes `set_supplier_bank_account`, which today stores the full number (`ap/index.ts:309-320`; Q6) |
| R6 | **Partitioning.** `audit_log` becomes a partitioned table: `PARTITION BY LIST (retention_class)`, each class sub-partitioned `BY RANGE (recorded_at)` **per calendar year (Manila)**. **`recorded_at` (server time) is the partition key, never `occurred_at`** (a device clock must not choose a partition). The PK becomes `(id, retention_class, recorded_at)`. Partitions exist for the current year and the next two; S5's job keeps that true. **No DEFAULT partition**: a missing partition is caught by the job's alarm 2 years early, and an insert into a missing partition fails loudly rather than landing somewhere unpurgeable. RLS ENABLE + FORCE, both policies and the append-only trigger are on the parent (row triggers are cloned to partitions); the app role is granted SELECT, INSERT **on the parent only**. ⚠️ **A new partition inherits `shareat_app` SELECT/INSERT from 0169's default privileges** (`0169_t355_def489_default_privileges_read_insert.sql:50` narrows the default only by revoking UPDATE/DELETE) **and has no RLS of its own**, so a query naming the partition would bypass the parent's policies. Therefore **whatever creates a partition (the migration and S5's job) does, in the same transaction:** `REVOKE ALL ON <partition> FROM shareat_app`, `ENABLE` + `FORCE ROW LEVEL SECURITY` with **no policy** (deny-all if reached directly), and `ENABLE ALWAYS TRIGGER audit_log_append_only` on it. The parent's trigger is `ENABLE ALWAYS` too (0168's DEF-487 rule, `0168_t354_def487_immutability_triggers_always.sql:13`). Guards that scan tables learn partitions: the RLS census (`packages/db/tests/integration/rls.test.ts:116`, `relkind = 'r'`) reads `relkind in ('r','p')`, treats a leaf with `relispartition` as its parent (via `pg_inherits`) and asserts the leaf has RLS forced and no app grant; the classification census (`pg_tables`, e.g. `t347-cutover-purge-shells.test.ts:499`) and the same-org FK census (`t398-s1-same-org-fk-census.test.ts`) map a partition to its parent's entry |
| R7 | **Retention classes, derived from the catalogue:** `r10y` = category `money`, `order`, `menu_price` or `customer` (points are value), or sensitivity `critical` or `high`, whatever the category; `r2y` = sensitivity `low` of any other category; everything else (normal `security`/`staff`/`settings`/`stock`/`data`) = `r10y` (Q2: no middle class). **The purge rule:** drop an `r2y` year partition only when its upper bound is more than 2 years and 30 days in the past. **The purge function takes no class argument, names `r2y` literally, and refuses any partition whose name or bound is not an `r2y` year older than that line.** Nothing in this task ever drops, detaches or truncates an `r10y` partition; expiring the 10-year class is a later decision (2036). **The database enforces the class too:** table CHECK `retention_class = 'r10y' OR (sensitivity = 'low' AND category NOT IN ('money','order','menu_price','customer'))`, so no writer bug can file money into the 2-year class. `audit_log_event_keys` rows live exactly as long as their log row (R10) |
| R8 | **Viewing.** Two new capabilities: `view_activity_log` (store, super ✅ admin ✅ manager ✅ staff ✗): rows whose `store_id` is in the actor's store list **and** whose catalogue `viewers = 'store'`. `view_activity_log_restricted` (org, super ✅ admin ✅ manager ✗ staff ✗): additionally org-level rows (`store_id` null) and `viewers = 'admin'` entries (grants, credential changes, authorisation denials, data exports, cutover). The filter is applied **in the domain read and again in SQL**; the screen never filters for security. Reading the log is not itself logged (volume), except an **export** of log rows, which is `data.activity_log_exported` (high, admin viewers) |
| R9 | **`authorize()` denials are aggregated, and written OUTSIDE the refused transaction.** `authorize()` throws (`packages/auth/src/authorize.ts:106`), so anything written in the caller's transaction rolls back with it. Every **failure-path** event (a denial, `auth.signin_refused`, `auth.pin_paused`, `auth.pin_stopped_for_day`, `security.event_replay_conflict`, `security.event_store_mismatch`) is written in its **own `withOrgPrincipal` transaction that commits independently**, the T-395 pattern (`packages/auth/src/sessions.ts:91-95`, DEF-626). The first denial per `(org, actor, capability, store, Manila day)` writes `security.authorize_denied` (normal). Later ones that day increment `authz_denial_counts (org_id, actor_person_id, capability, store_id, hour_bucket, count)` in the same separate transaction. S5's hourly roll-up appends one `security.authorize_denied_summary` per bucket, **high** when the bucket's count ≥ 20 **or** the actor's day total for that capability and store reaches ≥ 50 (the daily threshold, so a slow attack under 20 an hour still goes high), else normal; then it deletes the rolled bucket rows. The counter table is not the log and is not append-only. The roll-up runs **per org inside `withOrgPrincipal`**; the app role has DELETE on `authz_denial_counts` with an org-isolation DELETE policy. S2 owns the counter's repo functions (`increment`), S5 owns `rollUp`/`deleteRolled`. A denial is never lost: an un-rolled bucket is rolled at the next run |
| R10 | **Offline envelope and idempotency (POS v2, customer v2; specified here, those apps not built).** The cashier device never writes the log. Each queued event rides **with the sale or document it belongs to**, to the same server path (ADR-015), as `{ eventKey (uuidv7 made on the device), action, entityId, storeId, occurredAt (device ISO time), actorClaim, before, after }`. **(a) Two people, kept apart.** `uploaded_by_person_id` = the live session that uploads the batch. `actor_person_id` = who did it, taken from the **server-verified offline session or shift recorded on the sale it rides with** (the PIN sign-in the terminal made while offline and the server later verifies); `actorClaim` is only matched against that, and a mismatch stores the verified actor and sets `after.__actorClaimMismatch = true`. **(b) Store.** `storeId` must equal the attested terminal's store (T-304 `resolveTerminalIdentity`), else that event is refused and `security.event_store_mismatch` (high) is written (R9 separate transaction). **(c) Allowlist.** The action must list the upload's source in `clientSources` (R2), else refused (`AUDIT_SOURCE_NOT_ALLOWED`). **(d) Server-supplied, never the client:** `org_id`, `device_id`, `source`, `recorded_at`, category/sensitivity/severity/retention. **Idempotency:** `audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)`, PK `(org_id, event_key)`; `payload_sha256` is over the **canonical JSON** (RFC 8785 JCS: sorted keys, no insignificant whitespace, normalised numbers) of `{action, entityId, storeId, occurredAt, before, after}`. Same key + same hash = return the first row's id, insert nothing; same key + different hash = refuse and write `security.event_replay_conflict` (high, separate transaction). **A key lives as long as its log row**: `r10y` keys are never pruned; `r2y` keys are deleted by S5 together with the partition drop that removes their rows (per org, `withOrgPrincipal`, DELETE grant + org DELETE policy). `occurredAt` more than 5 minutes in the future or more than 30 days before `recorded_at` is **accepted** with `clock_suspect = true` (a queued event is never lost) |
| R11 | **Actor rules.** `append` (person) keeps its required `actorPersonId`. New `appendSystem` for `actor: 'system'` entries (cron, ingestor, roll-up) with `actor_person_id` null. A sign-in failure for a **known** account is written under that account's org with actor null and `after.subject` = the masked identifier and person id. A failure for an **unknown** email has no org and cannot pass RLS: it goes to the structured logger (`packages/core` logger, `event=signin.unknown_identifier`), not `audit_log` |
| R12 | **Flag / comment / resolve: not in T-402** (Q1). If Ian wants it later it is a separate mutable `audit_log_notes (audit_log_id, org_id, kind flag/comment/resolve, body, created_by, created_at)`, append-only itself, never touching `audit_log`. The viewer is read-only |
| R13 | **Diner password reset is in person, by a manager only** (Ian, 2026-10-13). The manager, signed in at the store, starts the reset; the diner re-enters their number, the new password and its confirmation on the device. Catalogued now, reserved until customer v2: `customer.password_reset_by_manager` (security, **high**, store, viewers store, actor = the manager, `after` = masked number + diner id, never the password) and `customer.password_reset_refused` (security, high: number mismatch or confirmation mismatch). There is **no** self-service reset event, because there is no self-service reset |
| R14 | **Store attribution is required where it exists.** A `scope: 'store'` entry refuses a null `store_id`. The 20 migrated callers pass the store they already hold; where a caller has none (an org setting) its entry is `scope: 'org'` |
| R15 | **Cutover events survive the cutover.** `audit_log` stays `purge` (`classification.ts:170`), but the purge step first **`pg_dump`s `audit_log` (every partition, data only) into the backups directory** (T-393's location and mode) and records the dump's sha256; only then TRUNCATEs. The `cutover.*` events (purge, opening entry and every step after) are written **after** the purge step, so the go-live record is the first thing in the production log, never truncated by it |

## The event catalogue (seed; S1b writes it in full)

**Size: ≈95 entries at S1b** (22 existing actions + ≈33 new built across S2/S3 + ≈40 reserved for POS v2 and
customer v2: v1 POS's 44 actions and CUSTOMER's 8 log types are the checklist, merged and graded). S1b's test pins the
exact count. Existing actions keep their snake_case strings byte-identical; new actions are dotted `<area>.<verb>`.

| Category | Built in this task (S2 / S3) | Reserved (POS v2 / customer v2) |
|---|---|---|
| security (S2, 15 new + existing `reopen_pin_sign_in`) | `auth.signin_succeeded` (low; Firebase token accepted) · `auth.signin_refused` (normal; a valid token with no live credential, a disabled person, or a token that fails verification: **the password itself is checked by Firebase, so a wrong password is not visible to the server**) · `auth.pin_signin_succeeded` (low) · `auth.pin_paused` (high, tier-1 pause) · `auth.pin_stopped_for_day` (critical, T-395) · `session.ended` (low; sign-out, end of shift) · `session.ended_all` (high; `endAllForPerson`/`endAllForDevice`) · `credential.linked`, `credential.unlinked` (high, admin viewers) · `credential.pin_set` (high) · `role.assigned` (high, admin viewers) · `capability.granted` (high, admin viewers) · `manager.elevated` (critical, admin viewers) · `security.authorize_denied`, `security.authorize_denied_summary` (R9), `security.event_replay_conflict` (R10). **Individual PIN misses are NOT copied into `audit_log`**: `pin_attempts` is already that attempt log (90 days); the log records the pause, the stop and the reopen | `customer.password_reset_by_manager`, `customer.password_reset_refused` (R13), `customer.signin_failed`, `customer.account_locked` |
| security (customer v2) | | `customer.password_reset_by_manager`, `customer.password_reset_refused` (R13), `customer.signin_failed`, `customer.account_created`, `customer.account_locked` |
| money (S3) | Approvals and steps **before** posting: `expense.drafted`, `expense.submitted`, `expense.approved`, `expense.rejected`, `expense.voided` · `sales_day.submitted`, `sales_day.verified`, `sales_day.reopened` · `remittance.recorded`, `remittance.confirmed` · `cash_request.approved`/`rejected` · `ap_invoice.approved`, `ap_payment.recorded` (plus the 4 existing `ap` and the tender/channel actions) | `pos.drawer_opened_no_sale` (high), `pos.drawer_counted`, `pos.shift_closed`, `pos.tender_changed_after_payment` (high) |
| order | (none built in v2 yet) | From v1 POS's 44: `pos.session_voided` (high), `pos.tickets_voided`, `pos.item_unvoided` (high), `pos.discount_applied`/`edited`/`removed`, `pos.bill_discount_applied`/`removed`, `pos.statutory_discount_applied`, `pos.statutory_discount_voided` (high), `pos.item_marked_free` (high), `pos.custom_charge_added`/`removed`, `pos.price_overridden` (high), `pos.package_qty_overridden` (high), `pos.receipt_edited` (high), `pos.receipt_voided` (high), `pos.receipt_refunded` (high), `pos.receipt_deleted` (**critical**; v2 should never allow it, kept so a refusal is logged), the `pos.guest_count_*` and `pos.package_change_*` approvals, `pos.payment_completed` (low). Dropped as line-level noise (the sale tables hold them): ticket served/cancelled, add-on/refill added, customer participant joins, bundle syncs. **New, absent in v1:** `pos.manager_override` (high) |
| data (S3) | `data.export_downloaded` (high, admin viewers; critical when it contains personal data) · `data.bulk_import_applied` (high) · `data.activity_log_exported` (high) · `cutover.*` steps (critical for purge and opening entry) | |
| staff (S2) | the existing `set_staff_code`; `employment.created`, `employment.ended`, `employment.positions_set` (`people/index.ts:83,270,316`) | |
| customer | the existing `set_customer_status` (a B2B customer) | `loyalty.points_earned`, `loyalty.points_redeemed`, `loyalty.points_transferred` (high), `loyalty.points_adjusted` (high), `loyalty.points_expired`, `loyalty.session_linked` |
| menu_price, stock, staff, settings | the existing `items.*`, `people.*`, `pos/store-link`, `tenders` actions get their category here | T-401 menu catalogue actions are added by T-401 when it merges (its own entries, same file) |

## Contract

### 1. Writer (`packages/db/src/repo/audit-log.ts`)

```ts
append(tx, orgId, { actorPersonId, action, storeId, entityId, before, after, source, deviceId?, occurredAt? })
appendSystem(tx, orgId, { action, storeId, entityId, before, after, source })
appendClientEvent(tx, orgId, envelope, attested: { actorPersonId, deviceId, source }) // R10; returns { id, replayed }
```
- `entity`, `category`, `sensitivity`, `severity`, `retention_class` come from the catalogue entry, never the input
  (the input type has no field for them, so a caller cannot pass one).
- Throws `UNKNOWN_AUDIT_ACTION`, `AUDIT_SCOPE_MISMATCH`, `AUDIT_ACTOR_MISMATCH` (a `system` entry through `append` or
  the reverse). Redaction (R5) runs inside, always.
- The row is written **inside the caller's transaction**: no business change commits without its row, and no row
  commits for a rolled-back change.

### 2. Reader (`packages/db/src/repo/audit-log.ts` + `packages/domain/src/activity/viewer.ts`)

`listActivity(tx, orgId, { storeIds | 'all', from, to, categories?, sensitivities?, actorPersonId?, action?, entityId?,
cursor, limit ≤ 100 })` ordered `(occurred_at desc, id desc)`, keyset cursor. The SQL bounds `recorded_at` to
`[from, to + 31 days]` so partition pruning works (`occurred_at ≤ recorded_at` within R10's 30-day window), **UNION
ALL** the `clock_suspect = true` rows with `occurred_at` in range (a partial index on `(org_id, occurred_at) WHERE
clock_suspect`), so a late or skewed event is never invisible; the screen also offers a "clock suspect" filter. `getActivity(id)`
returns one row with before/after. `latestForEntity` keeps its signature and behaviour.

### 3. Migration 0NNN (S1a, hand-authored, ADR-012 §5, its own PR, full suite on a fresh gate DB)

1. Create `audit_log_new` partitioned per R6 with the R1 columns, CHECKs: `category` in the 9, `sensitivity` in the 4,
   `(sensitivity, severity)` in `((critical,2),(high,4),(normal,5),(low,6))`, `retention_class in ('r10y','r2y')`,
   the R7 class CHECK, `source` as today; composite same-org FKs for actor, uploader (0194) and store.
2. Partitions `r10y` and `r2y` × **from the minimum Manila year present in the existing rows** through current year + 2,
   each with R6's REVOKE ALL, ENABLE + FORCE RLS (no policy) and ENABLE ALWAYS trigger in the same transaction.
3. **Copy existing rows**: `INSERT … SELECT` with `category`/`sensitivity`/`severity`/`retention_class` from a
   `VALUES` list of every action present in production **built at rebase time** (the 22 existing actions plus any
   T-401 or later action already deployed; S1b's test asserts the list equals the catalogue's entries for them),
   `recorded_at = occurred_at`, `store_id` backfilled from `after->>'storeId'` / `before->>'storeId'` **only when that
   store is in the row's org**, else null. `set_supplier_bank_account` rows are copied **through the R5 masking** (last
   4 digits + the `Changed` flag computed from the unmasked pair) so no full number survives the copy. The migration
   **RAISEs** if any existing row's action is not in the list (rather than guess a label) and **RAISEs if the copied
   count ≠ the source count**.
4. Drop the old table, rename, re-create the two policies verbatim from 0167 and the append-only trigger on the parent
   `ENABLE ALWAYS`, grants per R6 (SELECT, INSERT on the parent; no UPDATE/DELETE, as 0168/0170; update
   `triggers/registry.ts` for the parent). Indexes on the parent (propagate): `(org_id, occurred_at desc, id desc)`,
   `(org_id, store_id, occurred_at desc)`, `(org_id, actor_person_id, occurred_at desc)`, `(entity, entity_id)`,
   partial `(org_id, occurred_at desc) WHERE sensitivity in ('critical','high')`, partial `(org_id, occurred_at) WHERE
   clock_suspect`.
5. `audit_log_event_keys` (R10; a separate table because a UNIQUE on a partitioned table must include the partition
   keys, so `(org_id, event_key)` cannot be unique on `audit_log` itself, and bible §4.2 rule 10 requires a UNIQUE)
   and `authz_denial_counts` (R9): ordinary tables, RLS ENABLE + FORCE, org isolation; app role SELECT, INSERT, DELETE
   on the first and SELECT, INSERT, UPDATE, DELETE on the second, each with org-isolation policies for every granted
   command.
6. `classification.ts`: `audit_log` stays **purge** at cutover, with R15's dump first (TRUNCATE of the parent
   truncates every partition); the two new tables purge too. `rls/registry.ts`: all three registered.
7. **Rollback, stated:** the migration is not reversible in place (the old table is dropped). The rollback is the
   **restored-backup rehearsal** before deploy (T-393 restore, apply 0NNN, compare per-action row counts old vs new,
   all equal), and on production the pre-deploy backup; the count check in step 3 makes a short copy impossible to
   commit.

### 4. Screen (S4)

`/activity` (nav under Reports, visible with `view_activity_log`): filters store (own stores only; "all stores" only
with the restricted capability), date range (default today, Manila), category, sensitivity, person, action; a
sensitivity chip per row (critical red, high amber), the who / what / store / when line, and a detail drawer with
before / after as a key-by-key diff and the `redacted_keys` listed. **No edit, no delete, no flag.** Export (CSV of
the filtered rows, ≤ 10k) only with `view_activity_log_restricted`, and it writes `data.activity_log_exported`.
375 px first, the reports family's components.

### 5. Maintenance job (S5, `scripts/activity-log-maintenance.ts`, nightly 02:30 Manila + hourly roll-up)

Follows `docs/discovery/34-scheduled-job-pattern.md` (a `scripts/*.ts` runner, a `docs/ops` `.service`/`.timer` pair,
a `scheduler_runs` row), but the partition steps run as the **schema-owner connection** (the one migrations use),
never the app role (the roll-up and key pruning may use the scheduler harness), on the droplet (a script, no
build). Steps: ensure partitions exist to current year + 2 (each created with R6's REVOKE ALL, RLS ENABLE + FORCE and
ENABLE ALWAYS trigger in its creating transaction) · roll up `authz_denial_counts` per org (R9) · for each eligible
`r2y` year partition (R7): delete its `audit_log_event_keys` per org, then drop it · print rows and bytes per
partition. Exit **1** if fewer than 2 future years exist after the run, or if any `r10y` partition would be touched.
Dry-run by default; `--apply` acts. The timer unit file is written by the orchestrator into `docs/ops/` at deploy.

## Invariants (the tests prove each; a mutant named per leg)

**Catalogue and writer (S1b)**
1. An unknown action throws `UNKNOWN_AUDIT_ACTION` and inserts nothing. *Mutant: writer accepts any string.*
2. Category, sensitivity, severity and retention come from the catalogue: a test passing a fake `category` in the
   input does not type-check (`@ts-expect-error`), and the stored row matches the entry. *Mutant: input field honoured.*
3. Severity binds sensitivity (CHECK): an insert of `(high, 2)` as the owner is refused. *Mutant: CHECK dropped.*
4. Retention derivation: a `money` + `low` entry is `r10y`; a `security` + `low` entry is `r2y`; any `critical` is
   `r10y`. *Mutant: retention from sensitivity alone.*
5. Scope: a `store` entry with null store and an `org` entry with a store both throw. *Mutant: scope unchecked.*
6. Redaction: `after = { pin: '1234', nested: { passwordHash: 'scrypt$…' }, Api_Key: 'x', note: 'ok' }` stores
   `[REDACTED]` for the first three, keeps `note`, and `redacted_keys` = their three paths. *Mutants: top-level only;
   case-sensitive match.* Every one of the 20 migrated callers' real payloads passes through with nothing secret left
   (credentials-admin especially).
7. Payload cap: a 40 KB `after` is stored as a diff with `__truncated`. *Mutant: no cap.*
8. Same transaction: a caller that throws after `append` leaves no row. *Mutant: writer opens its own transaction.*
9. Build guard: duplicate action, a reserved entry with a caller, a non-reserved entry with no caller each fail.
10. The 22 existing action strings are unchanged and `latestForEntity` still finds T-350's row. *Mutant: renamed.*

**Storage (S1a, real Postgres)**
11. Append-only survives partitioning: UPDATE and DELETE on the parent and **on a partition directly, as the owner**,
    are refused by the trigger. *Mutant: trigger only on the old table name.*
12. The app role cannot SELECT or INSERT a partition by name, **for a migration-created partition and for one
    created by S5's job** (`has_table_privilege` false; RLS forced, no policy); through the parent it sees only its
    org (org B sees nothing). *Mutants: default-privilege grants left on the partition; RLS not enabled on it.*
13. The migration copies every existing row with its label, refuses an unlisted action, and backfills `store_id` only
    from a same-org store. *Mutants: cross-org store accepted; unlisted action defaulted to `normal`.*
12a. `tgenabled = 'A'` for `audit_log_append_only` on the parent and **every** partition, including one S5 creates.
    *Mutant: trigger left `O` (origin) on a new partition.*
12b. The R7 CHECK: as the owner, inserting a `money` row into `r2y` is refused; a `security`/`low` row into `r2y` is
    accepted. *Mutant: CHECK dropped.*
12c. The RLS, classification and same-org FK censuses pass with partitions present and fail if a partition has an app
    grant or no forced RLS. *Mutant: census scanning `relkind = 'r'` only.*
13a. The copy masks `set_supplier_bank_account` (no 8+ digit account number remains, `Changed` flag correct) and a
    forced count mismatch RAISEs. *Mutant: plain copy.*
14. A row with `recorded_at` next January lands in next year's partition; a device `occurred_at` of last year with
    `recorded_at` today lands in **this** year's partition. *Mutant: partition key `occurred_at`.*

**Security events (S2)**
15. Each built security action in the catalogue is written by its path: Firebase sign-in accepted/refused, PIN
    success, T-395 pause and stopped-for-day, session end and end-all, credential link/unlink, PIN set, role assign,
    capability grant, manager elevation, employment create/end/positions. *Mutant per leg: the call removed (the test fails for that action alone).*
16. A failed sign-in for an unknown email writes no `audit_log` row and one logger line. *Mutant: row with null org.*
17. Denial aggregation, **run inside a caller transaction that then rolls back** (as a real refused action does):
    25 denials of one capability by one actor in one hour leave 1 immediate row + 24 counted after the rollback; the
    roll-up writes one summary of 24 at `high`; a second roll-up writes nothing. 15 denials an hour for 4 hours (60 in
    the day) make the 4th hour's summary `high` by the daily threshold. The same rollback test covers
    `auth.signin_refused`, `auth.pin_paused` and `auth.pin_stopped_for_day`. *Mutants: event written in the caller's
    transaction (vanishes on rollback); every denial a row; roll-up double-counts; hourly threshold only.*
18. **One after-suite scan of ALL of `audit_log`** (every slice's suite, run last in CI): no scrypt hash
    (`scrypt$`), no JWT (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.`), no 4-8 digit value under a key whose tokens include
    `pin`, no unmasked 8+ digit value under an `account`+`number` key, no session-token shape. *Mutant: raw PIN in
    `after`.*

**Money, order, data and the envelope (S3)**
19. Each built S3 action is written at its step, before posting where the step precedes posting. *Mutant per leg.*
20. Envelope replay: the same `eventKey` and payload twice gives one row and `replayed: true`; same key, other payload
    is refused and writes `security.event_replay_conflict`. *Mutants: dedupe on payload only; conflict accepted.*
21. Attestation: an envelope carrying its own `actorPersonId`, `orgId`, `source` or `category` has them ignored (type
    and runtime) and the server's values stored. *Mutant: client actor trusted.*
22. A 40-day-old `occurredAt` is stored with `clock_suspect = true`, never refused, and the reader returns it for
    its `occurredAt` date. *Mutants: refused; reader bound by `recorded_at` only.*
22a. Envelope rules: a `storeId` other than the terminal's store is refused and writes
    `security.event_store_mismatch`; POS sending `role.assigned` or `cutover.purge` is refused
    (`AUDIT_SOURCE_NOT_ALLOWED`); an `actorClaim` differing from the sale's verified offline session stores the
    verified actor and the mismatch flag, and the uploader is stored separately. *Mutants: claimed actor trusted;
    store unchecked; no allowlist.*
22b. Canonical hash: the same event with keys in a different order is a replay, not a conflict. *Mutant: hash over
    raw JSON.*
22c. Cutover (R15): the purge writes the dump and its sha before TRUNCATE, and the `cutover.*` rows exist after the
    purge. *Mutants: event written before the purge; no dump.*

**Viewer (S4)**
23. A manager of store A sees A's `viewers='store'` rows only: not B's, not org-level rows, not `role.granted` at A.
    *Mutants: store filter in the component only; viewers ignored.*
24. Staff with neither capability: the read is refused (`authorize` ✗). A manager calling the export is refused.
    Admin sees all four stores and org rows. **Every ✅ in the two new matrix rows has its ✗ test.**
25. Export writes `data.activity_log_exported` with the filter and row count. *Mutant: export unlogged.*
26. Keyset paging over equal `occurred_at` returns every row once. *Mutant: offset paging / `occurred_at` alone.*

**Retention (S5)**
27. The job drops an `r2y` partition 2 years + 31 days old and keeps one 2 years + 29 days old. *Mutant: bound
    compared to lower edge.*
28. **The job never drops, detaches or truncates an `r10y` partition**, even one dated 2015 created by the test.
    *Mutants: class taken from an argument; `LIKE 'audit_log_%'` match.*
29. Future partitions: after a run, current year + 2 exist for both classes; with creation disabled, exit 1.
30. Event keys are removed only with their `r2y` partition's drop; an `r10y` key from 2015 is never removed.
    *Mutant: age-based key pruning.*

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size | Depends on |
|---|---|---|---|---|---|
| **S1a** | Storage: migration (partitioned table with CHECKs, partitions from the minimum year with REVOKE/RLS/ENABLE ALWAYS, the masked and counted copy, two side tables with grants and policies), schema, classification + RLS registry + trigger registry, the three census guards taught partitions | `packages/db/tests/integration/t402-s1a-storage.test.ts` | `packages/db/migrations/0NNN_t402_activity_log.sql` + `meta/_journal.json`, `packages/db/schema/{audit-log.ts,index.ts}`, `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`, `packages/db/src/triggers/registry.ts`, `packages/db/tests/integration/{rls,t347-cutover-purge-shells,t398-s1-same-org-fk-census}.test.ts` (partition awareness only) | 1.25 | — |
| **S1b** | Writer + catalogue + redaction: catalogue (≈95 entries: 22 existing live, ≈33 S2/S3 entries shipped `reserved` and flipped by their slice, ≈40 POS/customer stay reserved; S1b's test pins the count), `append`/`appendSystem`/`appendClientEvent` storage half, the 20 call sites migrated (add `storeId`), the two capabilities + CAPABILITY-MATRIX.md rows | `packages/db/tests/t402-s1b-catalogue.test.ts`, `packages/db/tests/integration/t402-s1b-writer.test.ts`, `packages/db/tests/integration/t402-after-suite-scan.test.ts` (inv 18) | `packages/db/src/audit/{catalogue,redact,canonical-json}.ts`, `packages/db/src/repo/audit-log.ts`, the 20 caller files (one call each), `packages/auth/src/capabilities.ts`, the existing tests that assert exact `audit_log` rows, `docs/decisions/CAPABILITY-MATRIX.md` (two rows) | 1.0 | S1a |
| **S2** | Security events (flips its entries): sign-in (Firebase, PIN), T-395 pause/stop, sessions, credentials, role/capability grants and elevation, employment changes, `authorize()` denial first-of-day + counter `increment`, all failure-path writes in their own transaction | `packages/auth/tests/integration/t402-s2-security-events.test.ts` | `packages/auth/src/**` except `capabilities.ts`, `packages/db/src/repo/pin-attempts.ts`, `packages/db/src/repo/authz-denial-counts.ts` (`increment`), `packages/domain/src/people/**` | 1.25 | S1b |
| **S3** | Money/data steps before posting (flips its entries); `recordClientEvents` for the R10 envelope (store check, allowlist, verified actor, canonical hash; no HTTP route); R15 cutover dump + ordering | `packages/domain/tests/integration/t402-s3-money-data-events.test.ts`, `packages/domain/tests/integration/t402-s3-envelope.test.ts`, `packages/db/tests/integration/t402-s3-cutover-dump.test.ts` | `packages/domain/src/**` except `people/**` and `activity/viewer.ts`; `packages/domain/src/activity/client-events.ts`; `packages/db/src/cutover/purge.ts` | 1.25 | S1b |
| **S4** | Viewer screen, domain read (with the clock-suspect union), export | `packages/domain/tests/integration/t402-s4-viewer-authz.test.ts`, `apps/erp/tests/t402-s4-activity-page.test.tsx` | `apps/erp/src/app/activity/**`, the Reports nav entry, `packages/domain/src/activity/viewer.ts`, `packages/db/src/repo/audit-log-read.ts` | 1.0 | S1b |
| **S5** | Maintenance job: partitions ahead (with REVOKE/RLS/ENABLE ALWAYS), per-org denial roll-up with hourly and daily thresholds, `r2y` keys + partition drop; measured volume | `packages/db/tests/integration/t402-s5-retention.test.ts` | `scripts/activity-log-maintenance.ts`, `packages/db/src/repo/audit-log-maintenance.ts`, `rollUp`/`deleteRolled` in a new `packages/db/src/repo/authz-denial-rollup.ts`, `package.json` (one script line) | 0.75 | S1a, S2 |

**Total ≈6.5** (S1 split into storage and writer after the review; S5 grew by the partition hardening). **S2, S3 and S4
run in parallel after S1b** (disjoint paths above; S2 and S3 each need their own lane DB). S1a carries the only
migration: its own PR, full suite on a fresh gate DB (row 296 exception), and the restored-backup rehearsal before
deploy. S1a rebases on whatever holds 0195/0196 at merge, takes the next number, and rebuilds the step-3 action list
from production then.

## Out of scope (with reasons)

- **POS v2 and customer v2 apps**, their HTTP routes and offline queues: not built; R10 is their contract.
- **Flag / comment / resolve** (R12, Q1): needs a separate mutable table; Findings already covers follow-up.
- **Alerts** (push/email on a critical event): a later task; the partial index and the sensitivity column make it a
  query. Raising a Finding for `auth.pin_stopped_for_day` already exists (T-395).
- **Backfilling v1's activity logs** into `audit_log`: v1 stays readable in v1 until it is archived; its labels are
  free text and cannot be graded honestly.
- **Expiring the 10-year class**: a 2036 decision; this task can only make it impossible to do early.
- **Hash-chaining / external log shipping**: see Research.
- **Logging reads** (who viewed what), except exports: volume, and no requirement asks for it.
- **Bible and plan edits** (rows for the Q11 override and the retention drop, below): the planner's, not a lane's.

## Done when

- [ ] All invariants (1-30 with 12a-c, 13a, 22a-c) pass, each red leg shown red on HEAD or against its mutant.
- [ ] typecheck clean · affected tests locally · the full suite green in CI on the PR · `build` with the dev server
      stopped · `/activity` smoketested on 9008 at 375 px as admin, as a manager of one store, and as staff (refused).
- [ ] **Deployed, and a real week measured:** rows/day by category and sensitivity, bytes/day per partition, and the
      projected 10-year size, reported to Ian. If bytes/day × 3650 exceeds 40% of the droplet's free disk, stop and
      report before S5's job is enabled.
- [ ] The maintenance job run once in dry-run on production and its output reported.
- [ ] Any spec defect reported, not worked around.

## Risks

1. **The S1a migration rewrites a live table** (rows exist since T-350 and the 19 later callers). It copies under a
   lock; at today's row count that is seconds. Rehearse on a restored backup (T-393) first, with the per-action count comparison; the rollback is that backup
(Contract §3 step 7).
2. **A missing future partition fails every audited business action** (the row is in the caller's transaction).
   Mitigation: 2 years ahead at S1a, the job keeps it, exit 1 alarm. No DEFAULT partition by choice.
3. **Volume is a guess.** If POS v2 logs more than exceptions, the 10-year class grows past the disk. The measured week
   in Done-when is the check; the payload cap and aggregation bound the worst case.
4. **T-401 (0196) adds menu catalogue writers** at the same time: whichever merges second adds its catalogue entries;
   an unknown action throws, so a missed entry fails its tests loudly, not silently in production.
5. **Partition DDL needs the owner role on the droplet**; if the job runs as the app role it can do nothing (safe
   failure, exit 1).
6. **POS v2 transport is not decided.** If its sales arrive through the Firestore inbox rather than HTTP, the envelope
   rides the inbox document and the ingestor calls `recordClientEvents` with `source 'pos'`; the contract is the same.

## Questions for Ian (Open Questions page; the recommended option is built)

| Id | Question | Options | Recommended |
|---|---|---|---|
| **t402-q1** | The old ERP let you flag a log entry, comment on it and mark it resolved. Do you want that on the new screen? | (a) **not now**: the log stays read-only, and anything that needs follow-up becomes a Finding · (b) yes, as notes kept beside the log (adds about a day) | **(a).** The Findings page already does "someone must look at this and close it", and keeping the log untouched is what makes it evidence. |
| **t402-q2** | You set 10 years for money and orders and 2 years for low-importance events. What about ordinary staff, settings and stock changes? | (a) **10 years** like money · (b) a middle class of 5 years | **(a).** They are small; one fewer rule to get wrong. |
| **t402-q3** | Should a store manager see security events for their own store (failed PINs, lockouts, sign-ins of their staff)? | (a) **yes, but not role grants, password resets or blocked-permission attempts**, which stay admin-only · (b) yes, everything at their store · (c) no security events for managers | **(a).** They need to know someone is guessing PINs at their counter; who can grant what is your business. |
| **t402-q4** | When a manager resets a diner's password in person, what goes in the log about the diner? | (a) **the diner's account and a masked number (09** *** 1234)** · (b) the full number | **(a).** Enough to find the diner; nothing a leaked log could misuse. |
| **t402-q6** | Supplier bank account changes are logged with the full account number today. Keep it? | (a) **show only the last 4 digits in the log** (the bank details screen still shows the full number to those allowed) · (b) keep the full number | **(a).** The log is read by more people than the bank details screen; last 4 is enough to see that it changed. |
| **t402-q5** | Successful sign-ins are low importance and kept 2 years. Keep them at all? | (a) **yes, 2 years** · (b) only failures | **(a).** "Who was signed in when the cash went missing" needs the successes. |

## Conflicts with the bible (for the planner to record, not for a lane to resolve)

1. **Q11 (a)** put the activity-log viewer after cutover; Ian pulled it forward on 2026-10-13. Needs a §13 row.
2. **§4.2 rule 9 (append-only)**: dropping `r2y` partitions after 2 years removes rows. Rows are never edited or
   deleted one by one and the trigger stays unconditional, but the retention drop is a deliberate exception that needs
   its own §13 row naming the class and the 2-year-30-day line.
3. **Cutover purge** (`classification.ts:170`): `audit_log` is `purge`, so every row written before go-live is dropped
   at cutover, including security events from the dual run. Consistent with ADR-007 (pilot data), kept as is; named
   here so nobody expects pre-cutover history to survive.
4. **`append`'s "a system caller writes the row directly" comment** (repo header) is superseded by `appendSystem`.

## S1a audit rulings (orchestrator, 2026-10-13; binding)
- **S1a ships only together with S1b, in one PR.** S1a alone would keep logging full supplier bank numbers through the live writer.
- The action list in repo/audit-log.ts and in 0197 is rebuilt from a repo-wide scan (the menu_* actions and dual_run.compare included). A unit test fails if any written action is missing from either list. At rebase, also compare it with production's distinct actions.
- The cutover purge truncates audit_log and audit_log_event_keys in one statement.
- The audit_log_event_keys FK includes org_id.
- search_path in the two partition functions is pg_catalog, public.
- set_staff_code is security/high.
- **Deploy:** 0197 holds ACCESS EXCLUSIVE on audit_log for the whole conversion, and the old app's audit writes fail between migrate and restart. Deploy in a quiet window, or with shareat-erp stopped (Ian's call at merge time).

## S1b audit rulings (2026-10-13; binding)
- **Ian:** in an org with no admin, the manager serves as admin, so `view_activity_log_restricted` is lent to that manager (ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER). A manager in an org that has an admin cannot read restricted rows.
- `set_staff_code` is viewed by admins only (it is a credential change). `reopen_pin_sign_in` stays store-viewable.
- appendClientEvent claims the event key before it inserts the row (exactly one row per event), refuses reserved entries, and hashes the REDACTED canonical envelope.
- Redaction also masks account numbers held in arrays or objects, and covers pwd, passwd, apikey, session, accessKey, cvv and card_number keys, plus "Bearer " values under any key.

## S2 audit rulings (Opus planner, 2026-10-14; binding)
**One rule behind all of them: a security event never holds a second connection, never blocks the caller, and never
changes the caller's outcome.** Failure-path and post-commit events go through one in-process outbox.
- **A1 (HIGH #1, outbox).** `security-events.ts` becomes an outbox. `enqueue*()` is SYNCHRONOUS and returns void;
  `authorize()` calls it and throws its refusal without awaiting anything. Denials are coalesced in a Map keyed
  `(org, actor, capability, store, hour_bucket)` -> `{ count, firstAt }`; other events are a plain list. A flush is
  scheduled with `setImmediate` (one in flight at a time; denials arriving during a flush schedule the next one). The
  flush writes ONE `withOrgPrincipal` transaction per org, sequentially, so the outbox holds at most one connection
  and no caller ever waits on it (no deadlock at any pool size). `registerDenial` takes `count`: first-of-day writes
  the row and increments `count - 1`; otherwise increments `count`. An in-process `seenToday` set (cleared when the
  Manila day changes) skips the advisory lock + `audit_log` scan for keys already written today; the scan stays as
  the multi-process truth. Cap: 10,000 distinct keys + 1,000 list events; beyond that, drop and count, one
  `logger.warn` per flush. Accepted loss: what is buffered when the process dies or a flush's DB write fails (one
  `logger.error` per org per flush, entries dropped, no retry). Export `flushSecurityEvents(): Promise<void>` (drains
  and awaits in-flight) for tests. Inv 17 is unchanged in outcome; its tests call `flushSecurityEvents()` first.
- **A2 (HIGH #1, probes).** New `can(tx, actor, capability, ctx): Promise<boolean>` in `authorize.ts` = `decide() ===
  null`, writes nothing. `authorize()` stays the logging gate, so a forgotten mutation check still logs (fail-safe
  direction). Every render probe and every try-A-then-fall-back-to-B check uses `can()`. **The sweep is in S2**, as
  its own commit: 28 files hold `instanceof AuthorizationError` (21 `authorize(` calls in 13 page/layout files; the
  rest in `lib.ts`, `route.ts`, `lib/` and 7 domain files incl. `sales-days/verify.ts`, `ar`, `trade`, `files`,
  `attendance/adjustments`). The builder classifies each site: probe/fallback -> `can()`; real gate or error mapping
  -> unchanged. If S3 is editing the same domain files, the orchestrator sequences the merge. **Enforced** by a
  guard test scanning `apps/erp/src` + `packages/domain/src` for a `catch` that tests `instanceof
  AuthorizationError` and then returns a boolean or calls `authorize(` again; an allow-list must stay empty.
- **A3 (MEDIUM #2).** The flush resolves `storeId` once per key: a non-uuid, unknown or other-org store is recorded
  as `store_id = null` with `after.deniedAtStore = 'unknown'` (the raw string is never stored or logged). Failures
  log once per flush, never per request (A1), so the swallow can no longer amplify logs.
- **A4 (MEDIUM #3).** No silent skip. `elevateManager` takes `orgId` in its input (callers pass `actor.orgId`);
  `endShift` / `endAllForDevice`, when `ended > 0` and the org cannot be resolved, THROW, rolling the change back.
  An unrecorded critical elevation is worse than a refused one.
- **A5 (MEDIUM #4).** `signInWithFirebase(null)` / `signOut(null)`: the success event is enqueued after
  `authTransaction` commits (outbox), never awaited, never thrown to the caller. With a caller `tx` it stays in that tx.
- **A6 (LOW #5).** An event lives where its charge lives: in `runPinSignInWithThrottle` (caller tx), pause/stop are
  written in `throttleTx`, so a rollback removes both. In the null path (charge already committed) they are enqueued.
- **A7 (LOW #6), deferred.** A bad token has no trustworthy org: one logger line, like inv 16. A disabled / ended /
  revoked person is DEF-649's to fix; the orchestrator adds to DEF-649: "its fix writes `auth.signin_refused`,
  reason `employment_ended` / `credential_revoked`". Fix the catalogue's `signin_refused` text now to list only the
  written reasons (`terminal_credential`, `not_a_firebase_credential`).
- **A8 (LOW #7), fix now.** The first-of-day scan adds `recorded_at >= <Manila day start>` (recorded_at >=
  occurred_at always) and `recorded_at < <day end> + interval '1 day'`, so only the current partition is scanned.
- **Tests (tester adds, in `t402-s2-security-events.test.ts` unless named):** (T1) with `withOrgPrincipal` mocked
  to never resolve, a denied `authorize()` still rejects promptly with the same `AuthorizationError` - mutant:
  awaited write; (T2) 5 denied `can()` + flush -> zero `audit_log` and zero counter rows - mutant: `can` calls
  `authorize`; (T3) guard test `packages/auth/tests/t402-s2-no-logging-probes.test.ts` (A2) - mutant: one probe
  restored; (T4) 25 denials in a rolled-back caller tx -> after flush 1 row + 24 counted, and the flush opened one
  transaction for that org - mutant: per-denial write; (T5) non-uuid and other-org `storeId` -> counted under null
  store, raw value nowhere, no `logger.error`; (T6) forced flush DB error -> one `logger.error`, caller's refusal
  unchanged; (T7) key cap: 10,001 keys -> one drop warning, buffer bounded; (T8) `elevateManager` / `endShift` with
  an unresolvable org throw and leave no grant / no ended session; (T9) `signInWithFirebase(null)` with the audit
  write forced to fail still returns the session; (T10) PIN caller-tx path rolled back -> no charge and no pause
  event; (T11) EXPLAIN of the first-of-day query touches one `audit_log` partition - mutant: bound removed.
