# T-245 — The prerequisite counter: measure which walls people actually hit

> **Status**: 📝 **SPEC, round 2 — written by lane E (`ianla-60`) in plan mode, 2026-09-09.**
> Round 1 was sent back: §3's recording mechanism wrote on the caller's own transaction, which
> rolls back on the `throw` that follows it — the row would never have survived to production.
> §12 documents the defect and the fix. Rulings on the three round-1 open questions are folded in
> below (migration slot 139 granted; `requireOpenEmployment` signature change approved; nav
> ownership moved to the orchestrator). Awaiting `APPROVED`. Nothing built yet.

## 0. What this is, in one sentence

Every time a domain function refuses an action because a different fact isn't true yet — not
because the caller's input is malformed — durably record one row, on a connection that survives
whatever happens to the caller's own transaction; read the counts back on a plain admin page; stop
the next refusal from being written without deciding which bucket it's in.

## 1. The classification rule (design question 1)

**A refusal is prerequisite-shaped when clearing it requires a fact to become true somewhere else —
a different record's existence or state, established by a separate action, sometimes by a different
person — before this same action can be retried and succeed.** The test: *"does fixing this mean
going somewhere else / doing something else / being someone else, first — or does it mean correcting
what I just typed into this form?"* The first is a wall; the second is validation.

This also covers the segregation-of-duties shape Ian's own AP worked example turned out to hinge on
(discovery 30 §6: *"whoever logs a receipt is not allowed to verify it… a store with one signed-in
person cannot post an expense at all"*): the fix there is not a permission grant on the current actor,
it's an organisational fact (a second qualified person must exist and act) — so it counts. That is
`packages/auth`'s `AuthorizationError` job only when the actor's own role/capability grant is what's
missing; a same-record self-review block thrown by the *domain* layer (bible §7 rule 6: *"no one
approves, pays, adjusts, or scores their own record"*) is prerequisite-shaped by this rule, because
the remedy is "get a different person," not "grant me a capability."

**Three categories the rule correctly excludes, all sampled from the domain layer, not invented:**

1. **Validation on the current request** — `attendance/terminals.ts:62`, `'A terminal needs a label
   — it is how a manager finds it again.'` Fixed by typing a label into the same form. Same shape as
   the task stub's own example, `'createSupplier: a supplier needs a name people will recognise.'`
2. **Not-found / stale reference** — `attendance/credentials.ts:187`, `` `No credential
   ${input.credentialId}.` ``. The caller passed an id that doesn't resolve. That's a bad link or a
   bug, never a business lesson worth a tutorial — nobody learns "enrol a credential first" from
   being told an ID doesn't exist.
3. **Closed-path / immutability** — `attendance/terminals.ts:178`, `` `Terminal ${terminal.label} was
   revoked on ${date} … Provision a new one rather than reviving it.` `` The record reached a
   permanent state; the remedy is a *different* action entirely, not clearing a precondition and
   retrying the *same* one. (Same shape: `attendance/adjudicate.ts:120` and `adjustments.ts:76`,
   both "frozen by pay run — go through payroll instead.")

**Examples the rule correctly includes**, all from the domain layer:

1. `attendance/credentials.ts:110-113` — `'That card is already enrolled to somebody at this
   organisation. Revoke it there first…'` — a different credential's state must change first.
2. `attendance/credentials.ts:233-235` (inside the private helper `requireOpenEmployment`) —
   `'That employment has ended. Enrolling a badge for somebody who has left…'` — Employment's state
   gates Attendance's action; different domain module, different action, must be true first.
3. `attendance/adjustments.ts:64-66` — the self-review block above. A different *person* (an admin
   who isn't the record's subject) must act.
4. `people/index.ts:72-74` — `'This person already has an open employment at this store… End it
   before starting a new one.'` — explicit "before."
5. `sales-days/create.ts:134-137` — the prior business day must be verified before a newer one can be
   created — explicit "before a newer day can be created."

The rule held across 3 domains (attendance, people, sales-days) and ~15 sampled throws without a
single ambiguous case that wasn't resolvable by the "somewhere else / something else / someone else,
first" test.

## 2. Why a table, not logging alone (design question 2) — and why this is NOT the forbidden counter

**Structured logging alone does not satisfy design question 3.** `packages/core/src/logger.ts` is
pino → stdout; there is no error-tracking/log-aggregation service configured anywhere in this repo
(checked: no Sentry, no aggregator). On the production droplet that means SSH + `journalctl`/grep —
a terminal, which design question 3 explicitly asks to avoid. So the read-back needs a queryable,
app-rendered surface, which means Postgres.

**This is not the counter §4.2 rule 7 / bible row 173 forbids, and the distinction is load-bearing:**
the forbidden shape is a *hand-maintained summary* — a value that gets `UPDATE`d/incremented and can
therefore drift from the facts underneath it (row 173's exact counter-example: `dashPresets` only
ever *adds* a receipt to a rolling window with no mechanism to subtract, producing 3×-11× inflation).
What's proposed here is the opposite shape: an **append-only fact log** — every row is immutable once
written, there is no `UPDATE`, and "how many times has X happened this month" is *always*
`SELECT count(*) … WHERE reason_code = … AND occurred_at BETWEEN …` computed at read time, never a
value carried forward. **This is precisely `finding_occurrences`' shape (T-214, bible row 177),
which exists for the identical reason**: *"a `DetectedFinding` is a pure function of current state…
so when a finding first appeared is not recoverable from anywhere"* — a refusal is the same: it is a
discrete event with no other trace anywhere once the request returns, so there is nothing to
*derive* it from after the fact. An append-only observation log is the sanctioned escape hatch from
row 176/rule 7, not an exception to it; row 177 already made this call once and built exactly this
shape.

**Table, not log line, and only one writer** (§4.2 rule 8): a single `INSERT` at the point of refusal
is the whole mechanism. Existing pino logging of the thrown error (if any exists downstream at an
HTTP boundary) is unaffected and unrelated — this is not a second writer for the same fact, it's the
only writer for a fact nothing currently records at all.

**✅ Migration slot 139 — GRANTED by the orchestrator, round 1.** `when` in the generated journal
entry must exceed 1797996707084.

### Schema — `prerequisite_refusals`

```ts
// packages/db/schema/prerequisite-refusals.ts
export const prerequisiteRefusals = pgTable(
  'prerequisite_refusals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    /** Null for a refusal with no store context yet (e.g. no store scope at all). */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** Stable machine key, chosen at the throw site — never the rendered message (that's prose,
     *  free to reword; the reason code is the identity a report groups on). */
    reasonCode: text('reason_code').notNull(),
    /** Denormalised coarse grouping so the read-back page doesn't need to parse reasonCode. */
    domain: text('domain').notNull(),
    /** Nullable — who hit the wall is a bonus, not the point; the count is the point. */
    actorPersonId: uuid('actor_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('prerequisite_refusals_org_occurred_idx').on(t.orgId, t.occurredAt),
    index('prerequisite_refusals_org_reason_idx').on(t.orgId, t.reasonCode),
  ],
);
```

No `updatedAt`, no unique constraint — every refusal is its own row, duplicates are the correct
behaviour. Append-only, matching `audit_log`'s and `finding_occurrences`' pattern (bible §4.2 rule 9).
Message text is deliberately NOT stored — the rendered sentence is free prose owned by the domain
layer; the report groups on `reasonCode`, chosen once at the throw site, exactly `findingKey`'s role
in `finding_occurrences`.

**Cutover classification** (`packages/db/src/cutover/classification.ts` — required, in scope):
`class: 'purge'`, reason modelled on `finding_occurrences`' entry — pilot-period telemetry the
January cutover replaces.

**RLS registry** (`packages/db/src/rls/registry.ts` — required, in scope): `scope: 'org_column'`,
same as `finding_occurrences`.

### Repo (`packages/db/src/repo/prerequisite-refusals.ts`, new)

```ts
export async function record(tx: Tx, input: {
  orgId: string; storeId: string | null; reasonCode: string; domain: string;
  actorPersonId: string | null;
}): Promise<void> { /* single INSERT, nothing else — this function has no opinion about which
                          transaction it runs on; see §3 for why that matters */ }

export interface RefusalCount {
  readonly reasonCode: string;
  readonly domain: string;
  readonly count: number;
  readonly lastOccurredAt: Date;
}
export async function countByReason(
  tx: Tx, orgId: string, since?: Date,
): Promise<RefusalCount[]> { /* SELECT reason_code, domain, count(*), max(occurred_at)
                                  GROUP BY 1,2 ORDER BY count(*) DESC */ }
```

Exported from `packages/db/src/index.ts` as `export * as prerequisiteRefusalsRepo from
'./repo/prerequisite-refusals';` — matching `attendanceCredentialsRepo`'s exact pattern.

## 3. ⛔ The write path — round 1's defect, and the fix (design question 2, continued)

**Round 1 wrote `record(tx, …)` on the caller's own `tx`, immediately before the `throw` that
propagates out of it.** `packages/db/src/client.ts:80` — `transaction(fn)` is `getDb().transaction(fn)`,
plain Drizzle, which **rolls back the whole transaction when `fn` throws**. The INSERT was inside
that same transaction, so it rolled back with it. In production the table would have stayed empty
forever, silently — the exact "green but does nothing" failure mode this project keeps naming as its
own worst pattern, on the one task that exists specifically to stop guessing about frequency.

**The fix: the write goes on its own transaction, opened with `withOrgPrincipal`
(`packages/db/src/rls/principal.ts:111`) — not the caller's `tx`.** This is not new plumbing;
`withOrgPrincipal` is the existing, single blessed way "an application or a job opens a transaction
under an org's principal" (its own docstring), already called directly from domain-layer code
(`packages/domain/src/scheduler/index.ts:433,538`). `transaction()` pulls a **fresh connection from
the same pool** (`packages/db/src/client.ts`'s `postgres(DATABASE_URL, { max: DATABASE_POOL_MAX })`),
so this is a second, independent transaction that commits on its own the moment the `INSERT`
succeeds — its fate is no longer tied to whatever the caller's transaction does next.

**The cost, named rather than hidden**: because the write commits independently and *before* the
`throw` completes, it commits even if the caller's own transaction later aborts for a reason that has
nothing to do with this refusal (a different statement in the same outer transaction hits an
unrelated constraint, say). I am choosing this cost deliberately: **a refusal is a discrete event a
person actually hit, regardless of what happens to the rest of the request afterward** — the counter
exists to answer "how often does anyone hit this wall," not "how often does hitting this wall
correlate with the surrounding operation eventually succeeding." The alternative (a per-request
buffer flushed at the request boundary after the transaction resolves) trades this cost for the one
round 1 was already built to avoid: a buffered event never flushed because nothing at the boundary
runs, which is exactly the swallowing risk that motivated recording before the throw in the first
place. Independent-commit is the smaller, better-understood risk of the two, and it reuses a
mechanism this codebase already trusts for the same class of problem (the scheduler's per-org job
runs).

**Recording must never become a new way for the real refusal to fail or change shape.** A private
helper in `credentials.ts` wraps the independent write in its own `try/catch` — a failure to record
is logged (bible §15.6: never `catch {}`) and swallowed, never rethrown in place of the
`CredentialError` the caller is about to throw regardless:

```ts
// packages/domain/src/attendance/credentials.ts — private, file-local
async function recordPrerequisiteRefusal(input: {
  orgId: string; storeId: string | null; reasonCode: string; actorPersonId: string | null;
}): Promise<void> {
  try {
    await withOrgPrincipal(input.orgId, (freshTx) =>
      prerequisiteRefusalsRepo.record(freshTx, { ...input, domain: 'attendance' }),
    );
  } catch (err) {
    // Observability must never block or replace the real refusal — the `throw` right after
    // this call is what actually reports the wall to the user, unconditionally.
    logger.error({ err, reasonCode: input.reasonCode }, 'failed to record prerequisite refusal');
  }
}
```

Not generalised into a shared `packages/*` module yet — two call sites in one file don't earn an
abstraction (this project's own no-premature-abstraction norm). Slice 2's sweep is where a shared
version, informed by more than one file's needs, belongs.

**§7 invariant 3 restated**, per the orchestrator's correction: not *"a refusal recorded is always
about to be thrown"* (still true, but not the property that matters) but **"a refusal thrown is
durably recorded"** — proven in §5 by a query issued in a brand new transaction after the throwing
one has fully resolved, not by reading back inside the same transaction that has not rolled back yet.

## 4. Slice 1's representative domain area

**`packages/domain/src/attendance/credentials.ts`** — badge/biometric credential enrolment and
revocation. Not `packages/domain/src/stores/` (lane B), not `packages/auth/` (lane D). Checked for
collision: lane B is in the shell, lane D is in `vitest.config.mts` — no overlap. Chosen because:

- It is a complete, coherent feature (one error class, `CredentialError`, 11 throw sites in one file)
  rather than an arbitrary fragment — a legitimate reading of "one representative domain area."
- It contains **two** genuinely distinct prerequisite-shaped throws (not one), the minimum needed to
  prove the mechanism discriminates by `reasonCode` rather than just firing once.
- It also contains three of the excluded categories in the same file (validation at :94/:137/:198,
  not-found at :187/:231, closed-path at :191/:209) — so the guard test (§5) has real negative cases
  to fail on, not just positive ones.

**Census, control printed first** (bible §12/§13 row 181):

```
Known hit: packages/domain/src/attendance/credentials.ts:137:
  throw new CredentialError('A fingerprint enrolment needs at least one captured template.');
```

`grep -rn "throw " packages/domain/src/attendance/*.ts`, counted per-file and summed: credentials.ts
11, adjustments.ts 5, config.ts 4, adjudicate.ts 2, punches.ts 2, terminals.ts 4 = **28 total** across
6 files. Of `credentials.ts`'s 11: **2 prerequisite-shaped** (lines 110, 233), 3 validation, 4
not-found/closed-path/conflict at lines 187/191/209/231 (191 and 209 are the closed-path/race subtype
named in §1).

**Two throw sites wired in slice 1, both calling `recordPrerequisiteRefusal` (§3) immediately before
their `throw`:**

1. `credentials.ts:110` inside `enrolCard` — `orgId`/`storeId` from the already-fetched `employment`
   row, `actorPersonId` from `actor.personId` (both already in scope).
   `reasonCode: 'attendance.credential.already_enrolled_elsewhere'`.
2. `credentials.ts:233` inside the private helper `requireOpenEmployment` — `orgId`/`storeId` from
   the `employment` row it just fetched. `actorPersonId` is not in scope today (the helper takes
   `tx, employmentId, options`, no `actor`) — **adding an optional `actorPersonId?: string` to its
   `options` type** (✅ approved, round 1), threaded from `enrolCard` (passes `actor.personId`); the
   other caller, `listCredentials` at :219, calls with `{ allowEnded: true }` so this throw can never
   fire from there — no change needed at that call site, so it's fine for the field to be `undefined`
   there. `reasonCode: 'attendance.credential.employment_ended'`.

## 5. Read-back (design question 3)

**New page**: `apps/erp/src/app/admin/prerequisite-refusals/page.tsx` — gated the same way
`/admin/stores` and `/findings` are (`requireSession(path)`), rendered with the same `Page` shell
component (`@/components/shell/Page`). Server component, no client JS: calls
`prerequisiteRefusalsRepo.countByReason(tx, actor.orgId)`, renders one table — Reason code | Domain |
Count | Last seen — sorted by count descending. No filters, no acknowledgement, no scoring.

**Nav placement is the orchestrator's, not mine** (round 1 ruling). Requested row, for the
orchestrator to add beside `/admin/users`/`/admin/stores`:

```
{ href: '/admin/prerequisite-refusals', label: 'Prerequisite walls' }
```

⚠️ **`tests/unit/nav-route-reachability.test.ts` check B** fails the build for any non-dynamic route
with no nav entry and nothing reachable linking to it, unless it's listed in `UNLINKED_BY_DESIGN`
with a real reason. My page will be exactly such an orphan **until the nav row above lands** — so
this guard stays red between my commit and the orchestrator's nav edit landing, and I'm naming that
dependency here rather than discovering it as a surprise red at READY.

## 6. The guard (design question 4)

**Unit test**, no DB: `packages/domain/src/attendance/prerequisite-refusal-classification.test.ts`
(colocated with source, per this package's convention — see `shift-day.test.ts`, `sweep.test.ts`).
Reads `credentials.ts`'s source text, counts `throw new CredentialError(` occurrences, asserts that
count equals a checked-in manifest of exactly 11 entries (anchored on the throw's leading message
fragment, not a bare line number). Each entry states `prerequisite-shaped: true/false` and, if true,
its `reasonCode`. A new throw added to this file with no manifest entry fails this test — same shape
as T-241's own guard and the `nav.tsx` guard discovery 30 §8 proposed.

**Integration tests** (extend `packages/domain/tests/integration/attendance-credentials.test.ts`,
which already has an `asOrg(orgId, fn)` helper — `packages/domain/tests/integration/attendance-credentials.test.ts:50-55`
— duplicating the exact logic `withOrgPrincipal` centralises; use it for the outer transaction in
these cases, run via `node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_def219
packages/domain/tests/integration/attendance-credentials.test.ts`, never `npm run test:integration`):

- **The discrimination case**: `enrolCard` with an empty `cardId` (validation throw) → assert **zero**
  rows in `prerequisite_refusals`. Proves the mechanism doesn't fire on every `CredentialError`.
- **⛔ The durability case, and its required red-first sequence** — this is the one that matters:
  1. Two calls to `enrolCard` with the same `cardId`, both inside `asOrg(orgId, …)`; the second
     `throw`s `CredentialError` and its `asOrg(...)` promise rejects.
  2. **Query `prerequisite_refusals` in a brand-new `asOrg(orgId, …)` call, opened AFTER the throwing
     one has fully rejected** — not inside it. Assert one row with `reason_code =
     'attendance.credential.already_enrolled_elsewhere'`.
  3. **Run this test against the round-1 mechanism first** (write on the caller's own `tx`) and
     capture it failing with **zero rows**, not an error — that is the red-first evidence proving the
     defect is real, not theoretical. Paste that output into READY. Then switch to `withOrgPrincipal`
     (§3) and confirm the same test goes green.
- Same pattern for `credentials.ts:233`'s `'attendance.credential.employment_ended'` case (enrol
  against an ended employment).

**⛔ RLS on the new table is NOT exercised by any of the above** — DEF-218 is still open: the
integration harness connects as a superuser that bypasses RLS entirely. T-216 shipped past this once
already (18 green tests, refused in production). **Manual probe required before READY**, same method:
connect to the local dev database (port 5435) as `shareat_app` (not the superuser) and, in one
session each:
1. With no `app.org_id` set (or `role` not switched at all) — attempt a `select`/`insert` against
   `prerequisite_refusals` — **must be refused** (RLS denies, table appears empty or the write errors).
2. With `set_config('role', 'shareat_app', true)` and `set_config('app.org_id', '<a real org id>',
   true)` set first — the same `insert`/`select` — **must succeed**, and a `select` under a
   *different* `app.org_id` must not see the row.

Both outputs, verbatim, go in the READY report.

## 7. Scope — files this task creates or modifies (once APPROVED)

**Create**: `packages/db/schema/prerequisite-refusals.ts`, `packages/db/src/repo/prerequisite-refusals.ts`,
`apps/erp/src/app/admin/prerequisite-refusals/page.tsx`,
`packages/domain/src/attendance/prerequisite-refusal-classification.test.ts`, migration `0139_*`
(generated, not hand-written).

**Modify**: `packages/db/src/index.ts` (new repo export line), `packages/db/src/cutover/classification.ts`
(new entry), `packages/db/src/rls/registry.ts` (new entry), `packages/domain/src/attendance/credentials.ts`
(two throw sites instrumented, `requireOpenEmployment`'s options type, the new private
`recordPrerequisiteRefusal` helper, new imports for `withOrgPrincipal`/`prerequisiteRefusalsRepo`/`logger`),
`packages/domain/tests/integration/attendance-credentials.test.ts` (new cases).

**Not touched**: `apps/erp/src/components/nav.tsx` (orchestrator's, per round 1 ruling — I report the
row in §5, they add it), any other of the 130 sites (slice 2), `packages/domain/src/stores/`,
`packages/auth/`, `docs/DEFECTS-REGISTER.md`/`ROADMAP.html`/`PROJECT_BIBLE.md`/`HANDOFF-TODAY.md`.

## 8. Invariants

1. **No separately-accumulated counter** — every read is `count(*)`/`max()` over
   `prerequisite_refusals`, never a value stored anywhere else (§4.2 rule 7, row 173).
2. **One writer** — only the two instrumented throw sites in `credentials.ts` insert into this table
   in slice 1 (§4.2 rule 8).
3. **A refusal thrown is durably recorded** — proven by a read in a NEW transaction opened after the
   throwing transaction has fully resolved, not inside it (§3, §6).
4. **Recording never blocks or replaces the real refusal** — a failure inside
   `recordPrerequisiteRefusal` is caught, logged, and swallowed; the `CredentialError` throws
   regardless.
5. **The classification manifest and the live source agree**, enforced by §6's unit test.
6. **Validation-shaped and closed-path throws never write a row** — proven by the integration test's
   discrimination case.
7. **RLS-scoped and cutover-classified** — both registry entries present (build guard), and the RLS
   policy itself hand-verified per §6 (DEF-218 means no automated test can prove this one).

## 9. Tests (written before implementation, confirmed to fail for the right reason first)

- Unit: `prerequisite-refusal-classification.test.ts` — fails today because the file doesn't exist;
  once written, fails against a deliberately-wrong manifest (one entry short) to prove it actually
  counts, then passes against the real 11.
- Integration: the discrimination case and the durability case (§6) — written and run against
  `shareat_test_def219` before `record()`/the schema exist (fails with "table does not exist" — the
  right reason), then again in their required red state against the naive same-tx mechanism (§6's
  step 3), then green against the fix.

## 10. Out of scope

The other ~128 throw sites (slice 2). A tutorial reading surface of any kind (a separate, later task
once this counter has run for a month). Any UI beyond the one read-only admin table. Any change to
`packages/auth/` or `packages/domain/src/stores/`. Backfilling history — there is none, same as
`finding_occurrences`. Fixing DEF-218 (out of this task's slice; the manual probe in §6 is the
workaround, not a fix).

## 11. Done when

Guard unit test green · discrimination + durability integration cases green against
`shareat_test_def219`, with the required red-first capture for the durability case pasted into READY
· manual RLS probe (§6) run and both outputs pasted into READY · typecheck clean ·
`cutover-classification` and RLS-registry build guards pass with the new table listed ·
self-reviewed line by line · smoketested on 9008 (create a duplicate card enrolment, see the row via
a direct query — `/admin/prerequisite-refusals` itself only renders once nav makes it reachable per
§5, so the page's own render is smoketested by URL directly if the nav edit hasn't landed yet, named
explicitly rather than silently skipped) · **orchestrator writes**: the nav row (§5),
`docs/ROADMAP.html` line, `docs/DEFECTS-REGISTER.md`/`HANDOFF-TODAY.md` if applicable.

## 12. Round 1 → round 2 change log

**Defect found by the orchestrator**: §3's mechanism recorded on the caller's own transaction,
immediately before the `throw` that aborts it — Drizzle rolls back the whole transaction on a thrown
error (`packages/db/src/client.ts:80`), taking the INSERT with it. The table would have stayed empty
in production, silently, forever. A same-transaction integration test would have gone green for the
wrong reason (it reads before the rollback happens).

**Fix**: write via `withOrgPrincipal` (`packages/db/src/rls/principal.ts:111`) — an independent
transaction on a fresh pooled connection, already the codebase's blessed pattern for this exact need
and already called from domain code (`packages/domain/src/scheduler/index.ts`). Cost named in §3:
the write commits even if the caller's transaction later aborts for an unrelated reason — accepted,
because a refusal is a real event independent of what happens afterward. Wrapped in try/catch so a
recording failure can never block or replace the real thrown error.

**Also added**: the required red-first sequence for the durability test (§6), the manual RLS probe
for DEF-218 (§6), and moved nav ownership to the orchestrator (§5) per round 1's ruling.

## 13. Rulings carried from round 1 (orchestrator `ianla-44`, 2026-09-09)

1. Migration slot 139 — **granted**. `when` must exceed 1797996707084.
2. `requireOpenEmployment` gaining an optional `actorPersonId` — **approved**.
3. Nav placement — **orchestrator's**, not this lane's. Row requested in §5.
