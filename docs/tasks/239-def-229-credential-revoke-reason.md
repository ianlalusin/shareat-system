# T-239 — DEF-229: `person_credentials` records who revoked a credential and when, never why

> **BUILT — see §13 "As built".** Lane D (migration lane, Opus 5). Approved 2026-09-08 with both
> open decisions going the spec's way: §4 option A (backfill the sentinel, a fully-validated CHECK)
> and §5's `btrim(…) <> ''` included, with the sibling divergence logged in the register.
> §1–§12 below are the spec **as approved**, left unedited so the plan and the outcome can be
> compared; everything learned during the build is in §13.

## Goal

A revocation on the table that authorises everything should answer three questions, not two.
`attendance_credentials` has required all three since T-185 (`schema/attendance-credentials.ts:144`);
`person_credentials` answers *who* and *when* and has never had a `revoke_reason` column at all. The
gap became live rather than theoretical with T-237, which gave the table its first two real
revocation writers — an administrator's unlink, and `setPin` retiring the PIN it replaces.

Deliberately **not** folded into `0137`: two schema changes for two reasons in one migration is how a
migration becomes hard to reason about (DEF-229's own register row says so).

---

## 1. What the register says, and what I verified before writing this

The register row (`docs/DEFECTS-REGISTER.md:299`) asks for *"a nullable-then-required `revoke_reason`
with the same check shape as the attendance table, plus a backfill decision for rows revoked before
it existed."* Three of those four words survive verification. **"The same check shape" does not** —
see §2, and it is the reason this spec exists rather than a two-line patch.

What I actually established, by reading rather than assuming:

| Claim | How it was established | Result |
|---|---|---|
| The column is absent | `information_schema.columns` on three live databases | absent: `id, person_id, kind, store_id, secret_hash, lookup_hash, external_id, revoked_at, revoked_by, created_at, updated_at` |
| The table's only CHECKs today | `pg_constraint` where `contype='c'` | `person_credentials_kind_check`, `person_credentials_shape_check`. **No revoke check at all** |
| How many rows a backfill would touch | counted, per database (below) | **zero, everywhere I can reach** |
| Every writer of `revoked_at` | grep for `sessionsRepo.revokeCredential` + every `personCredentials` builder ref | **2 in production**, 2 in tests |
| Every raw-SQL reader | grep for the literal `person_credentials` across `*.ts,*.tsx,*.sql,*.mjs,*.js` | §7 — **none of them breaks**, and the reason is specific |

```
--- shareat_dev ---           total 19 · live 19 · revoked 0
--- shareat_test ---          total  0 · live  0 · revoked 0
--- shareat_test_t216b ---    total  9 · live  9 · revoked 0   (my lane DB, at 0137)
```

⚠️ **Production is NOT in that table and I did not try to reach it.** A lane has no business holding
a droplet connection. It matters here because `person_credentials` is classed **`keep`** at cutover
(`packages/db/src/cutover/classification.ts:225`) — pilot revocations are not purged on 1 January, so
whatever production holds it keeps. See §4; the recommendation is correct whether the production
count is 0 or 40, which is why this is not a blocker.

---

## 2. ⛔ The attendance CHECK cannot be copied verbatim — it would break PIN re-issue

This is the finding that shapes the whole task. The attendance constraint is:

```sql
constraint "attendance_credentials_revoke_check" check (
  ("revoked_at" is null and "revoked_by" is null and "revoke_reason" is null)
  or ("revoked_at" is not null and "revoked_by" is not null and "revoke_reason" is not null)
)
```

It binds **all three** columns together. On `person_credentials`, `revoked_by IS NULL` on a revoked
row is **legal and deliberate** — `repo/sessions.ts:138` argues it at length, and T-237 shipped it:

> *"`setPin` retires the PIN it replaces and has no `Actor` to name … NULL there means "no principal,
> by construction" … naming the person themselves would record that the staffer revoked their own
> credential when an administrator re-issued it, and a fabricated attribution is worse than an absent
> one because it reads as evidence."*

So a verbatim copy makes `packages/auth/src/sessions.ts:297` — `revokeCredential(trx, previous.id,
null)` — write a row the table refuses. **Every PIN re-issue would throw**, which is DEF-228 reopened
from the other side. It would be caught (the DEF-228 regression case in
`packages/auth/tests/integration/sessions.test.ts` exercises exactly that path), but it would be
caught after the migration was written, and a migration is not a thing to iterate on.

**`revoke_reason` pairs with `revoked_at`. `revoked_by` stays independently nullable.** The three
questions are not one question: *when* and *why* are always answerable, *who* is answerable only when
there was a human.

### 2a. ⛔ And a NULL-safety trap inside the constraint itself

If §5's non-blank clause is adopted, the obvious spelling is **silently wrong**:

```sql
-- ⛔ WRONG. Passes on exactly the row it exists to refuse.
or ("revoked_at" is not null and btrim("revoke_reason") <> '')
```

A CHECK constraint passes when its expression is TRUE **or NULL**. For a revoked row with
`revoke_reason IS NULL`: the first branch is FALSE, and `btrim(NULL) <> ''` is NULL, so the second is
`TRUE AND NULL` = NULL — and `FALSE OR NULL` is NULL. **The row is accepted.** The constraint would
be decorative, green in every test that only writes good rows, and the whole task would have shipped
nothing.

The correct spelling keeps an explicit `IS NOT NULL` in front:

```sql
or ("revoked_at" is not null and "revoke_reason" is not null and btrim("revoke_reason") <> '')
```

The attendance version is already NULL-safe by accident of using only `is not null` tests; the trap
appears only when the non-blank clause is added. **A test must write a revoked row with a NULL reason
by raw SQL and assert the database refuses it** (§10, case 3) — otherwise this is unfalsifiable.

⭐ **Not reasoned — run.** Both spellings, as two temp tables on `shareat_test_t216b`, four rows each:

```
⛔ NAIVE (no explicit IS NOT NULL)        ✅ SAFE (explicit IS NOT NULL)
  revoked, reason NULL  <- the bug   ACCEPTED     revoked, reason NULL  <- the bug   REFUSED
  revoked, reason "  "  <- blank     REFUSED      revoked, reason "  "  <- blank     REFUSED
  revoked, real reason               ACCEPTED     revoked, real reason               ACCEPTED
  live,    reason NULL               ACCEPTED     live,    reason NULL               ACCEPTED
```

The naive constraint refuses a *blank* reason and waves through a *missing* one — the single row the
whole task exists to prevent, and the one no ordinary test would have written.

---

## 3. The migration and the schema

**`packages/db/migrations/0138_def229_credential_revoke_reason.sql`** — hand-written, per DEF-073/121.
⛔ `drizzle-kit generate` is never run in this repo; the snapshot chain has been dead since 0019.

```sql
ALTER TABLE "person_credentials" ADD COLUMN "revoke_reason" text;--> statement-breakpoint

-- §4 — the backfill. Idempotent, and a no-op on every database reachable from the lane (0 rows).
UPDATE "person_credentials"
   SET "revoke_reason" = 'Revoked before a reason was required — DEF-229.'
 WHERE "revoked_at" IS NOT NULL AND "revoke_reason" IS NULL;--> statement-breakpoint

ALTER TABLE "person_credentials"
  ADD CONSTRAINT "person_credentials_revoke_check" CHECK (
    ("revoked_at" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
  );
```

Journal entry — ⚠️ a reserved NUMBER block reserves the TIMESTAMP too, or Drizzle silently skips one:

```json
{ "idx": 138, "version": "7", "when": 1797996707084,
  "tag": "0138_def229_credential_revoke_reason", "breakpoints": true }
```

`1797996707084` = `0137`'s `1797910307084` + 86 400 000, continuing the file's own spacing.

**`packages/db/schema/sessions.ts`** gains `revokeReason: text('revoke_reason')` beside `revokedBy`,
and the matching `check()` in the table's second argument, carrying §2's reasoning as a comment so
the next person to copy the attendance shape reads why it was not copied.

---

## 4. ⭐ DECISION — the already-revoked rows that have no reason

Both options, as promised, with a recommendation.

**Option A — backfill a recognisable sentinel, then a fully-validated CHECK.** *(the SQL in §3)*
Every row in the table obeys the invariant from the moment the migration commits. A reader never has
to ask whether a NULL means *"this predates the rule"* or *"something wrote a bad row"*. The sentinel
names DEF-229, so it reads as an origin note rather than as a real reason somebody typed.
· Cost: rows carry a sentence nobody wrote.

**Option B — `ADD CONSTRAINT … NOT VALID`.** New and updated rows are checked; existing revoked rows
are grandfathered untouched, no sentinel invented.
· Cost: the table has two classes of row **permanently**, and the distinction is invisible in every
ordinary read. `NOT VALID` is also a live footgun — the natural later tidy-up, `VALIDATE CONSTRAINT`,
fails on exactly the rows nobody remembers, at whatever moment somebody runs it.

**→ Recommendation: A.** The count is **zero in every database I can reach**, so on this machine the
`UPDATE` is a statement that changes nothing — and that is the argument *for* writing it, not against.
It costs one line now and it removes a permanent two-class table for the price of a sentence on rows
that may not exist. If production turns out to hold a handful, a sentinel that names its own defect is
a better artefact than an unexplained NULL.

⚠️ **What A does not attempt.** For a `revoked_by IS NULL` row we could often *infer* the real reason
(a later live PIN at the same store ⇒ it was a `setPin` supersede) and backfill something truer. I am
recommending against: it is inference dressed as a record, on a population that is probably empty, on
the one table where a fabricated audit entry is worst. The generic sentinel is honest about being
generic.

**For the orchestrator:** worth running the same count on the droplet before applying, so the FOR IAN
line can say what it touched instead of assuming zero. The migration is correct either way.

---

## 5. ⭐ SUB-DECISION — `btrim(…) <> ''`, which makes this stricter than the attendance table

Attendance's constraint accepts `''` as a reason; only its domain layer trims and refuses
(`packages/domain/src/attendance/credentials.ts:203`, with a test at
`packages/domain/tests/integration/attendance-credentials.test.ts:469` passing `'  '`). That is the
service layer being the only line of defence for a rule the database could hold — the shape bible
§15.11 warns about (`docs/RULES.md` §6 item 3: *no layer may be the only one for a given risk*).

**→ Recommendation: include the clause here** (a blank reason is not a reason), **and log the
divergence rather than leave it silent.** Two sibling tables whose constraints differ by one clause,
with nothing written down, is a trap for whoever copies the next one. So: log a new register row —
*`attendance_credentials_revoke_check` accepts an empty reason; `person_credentials` does not* — as
`reported`, for someone else's slice. ⚠️ I do not touch `DEFECTS-REGISTER.md`; the orchestrator writes
the row.

If you prefer exact parity with the sibling instead, drop `btrim(…) <> ''` from §3 and the domain's
trim-and-refuse in §6 becomes the only guard. Say which; §2a's trap disappears along with the clause.

---

## 6. Every writer, and what each one supplies

There are **two** in production. Both are named here; there are no others.

| # | Writer | Has an `Actor`? | What it supplies |
|---|---|---|---|
| 1 | `packages/auth/src/credentials-admin.ts:199` — `unlinkCredential`, reached from `/admin/users/[personId]` | yes | **the administrator's typed sentence**, trimmed |
| 2 | `packages/auth/src/sessions.ts:297` — `setPin` retiring the PIN it replaces | ⛔ no, by construction | a fixed system sentence: `'Superseded by a newly issued PIN for this store.'` |

Writer 2 is the precedent that already exists one table over: `enrolFingerprint` revokes with
`'Superseded by a re-enrolment — the match token rotates.'`
(`packages/domain/src/attendance/credentials.ts:148`). A machine-initiated revocation gets a machine
sentence; a human-initiated one gets the human's. Neither is ever NULL.

**Repo signature.** `sessionsRepo.revokeCredential(tx, id, revokedBy)` becomes
`revokeCredential(tx, { id, by, reason })` — the object form its attendance counterpart already uses
(`repo/attendance-credentials.ts:136`). Two adjacent parameters that are both "a nullable string" is
how the wrong one gets passed; four call sites is a cheap moment to fix that. ⚠️ `at` stays
Postgres' own `now()` inside the repo, not a JS `Date` — this file's existing divergence from
attendance, and the better of
the two; not touched.

**Domain.** `UnlinkCredentialInput` gains `readonly reason: string`. `unlinkCredential` trims it and
refuses blank **before** taking the advisory lock, with the shape the attendance domain already uses:

> *"Unlinking a sign-in account needs a reason — a revoked credential nobody can explain is not an
> audit trail."*

---

## 7. Every raw-SQL reader of `person_credentials` — typecheck sees none of these

Grepped as a literal string across `*.ts, *.tsx, *.sql, *.mjs, *.js`, excluding `node_modules` and
`.next`. **The headline: adding a column breaks none of them, and the reason is that nothing in this
repo does `select *` against this table** — every read names its columns, in raw SQL and in the
builder alike.

| Location | What it is | Effect of a new column |
|---|---|---|
| `packages/db/src/repo/stores.ts:259` | raw `select count(*) … where store_id … kind='pin' … revoked_at is null` | none — counts, names no column in its projection |
| `scripts/dev-seed.ts:161` | raw `select id from person_credentials where … revoked_at is null` | none |
| `packages/db/src/rls/registry.ts:344-346` | the RLS `via` predicate, raw SQL over `person_credentials.person_id` | none. ⚠️ `tests/unit/rls-registry.test.ts` checks coverage per **table**, not per column |
| `packages/db/src/cutover/classification.ts:225` | table **name** as a key, class `keep` | none — but it is why §4 matters (revocations survive cutover) |
| `packages/db/src/repo/access.ts:164` | builder `exists(select 1 …)` inside `otherActiveRoleExists` | none |
| `packages/db/src/repo/sessions.ts:44-115` | builder, three explicit projections, no `select *` | none — a new column is simply not selected until asked for |
| `apps/erp/src/app/admin/users/actions.ts:79`, `apps/erp/src/app/staff/actions.ts:65` | ⚠️ regexes matching **index names** as literals in raw driver-error text (DEF-177) | none — no index is renamed. Listed because this is the trap T-237 nearly shipped, and the next person to touch this table must know these exist |
| tests: `credentials-admin.test.ts:135,141,369,396`, `sessions.test.ts:91,131`, `roles.test.ts:102`, `attendance-adjudication/-adjustments/-review.test.ts`, `payroll.test.ts:132`, `first-run-setup.test.ts`, `organizations.test.ts`, `stores.test.ts`, `email-sign-in.test.ts` | `insert into … (person_id, kind, …)` of **live** rows, plus `truncate` | none — a live row satisfies the new check's first branch, which is why no fixture needs editing |

The two that would have broken — a `select *`, or an insert of a revoked row by raw SQL — **do not
exist**. That is the sweep's actual product, and it is why this task touches ten files and not thirty.

---

## 8. The screen

`/admin/users/[personId]` offers **Unlink** only for `kind === 'firebase'`
(`page.tsx:270`); PIN retirement has no button, because it happens inside `setPin`. So there is
exactly one place a human types a reason, and the pattern to copy is two directories over —
`/staff/[employmentId]/credentials` has had a required reason input on its revoke form since T-203
(`page.tsx:117`).

```tsx
<form action={unlinkCredentialAction} className="flex flex-wrap items-center gap-2">
  <input type="hidden" name="personId" value={personId} />
  <input type="hidden" name="credentialId" value={c.id} />
  <input name="reason" required placeholder="Reason to unlink" className={`${INPUT} w-40`} />
  <button type="submit" className={LINK_BTN}>Unlink</button>
</form>
```

⚠️ `flex-wrap` is not decoration: the row is already `flex flex-wrap items-center justify-between`, and
this form is inside it. On a phone in portrait the input must wrap under the label rather than squeeze
the credential's own text to nothing. It is the same treatment the staff form uses, for the same
reason — the browser check at 390 px covers it.

`unlinkCredentialAction` reads `reason` from the `FormData` exactly as `revokeCredentialAction` does
and passes it through; the domain does the trimming and the refusal, so the two screens cannot drift
apart on what counts as blank.

---

## 9. The exact files I may touch

1. `packages/db/migrations/0138_def229_credential_revoke_reason.sql` *(new)*
2. `packages/db/migrations/meta/_journal.json` — one entry appended
3. `packages/db/schema/sessions.ts`
4. `packages/db/src/repo/sessions.ts`
5. `packages/auth/src/credentials-admin.ts`
6. `packages/auth/src/sessions.ts`
7. `apps/erp/src/app/admin/users/actions.ts`
8. `apps/erp/src/app/admin/users/[personId]/page.tsx`
9. `packages/auth/tests/integration/credentials-admin.test.ts`
10. `packages/auth/tests/integration/sessions.test.ts`
11. `docs/ops/access-revocation.md` — its closing bullet currently reads *"A reason recorded against
    the revocation … Logged as DEF-229"* under **"What is deliberately NOT done"**. It moves and
    becomes true.
12. `docs/tasks/239-def-229-credential-revoke-reason.md` — this file, gaining an "As built" section

**Not mine, and I will not touch them:** `docs/DEFECTS-REGISTER.md` (both the DEF-229 row and §5's new
one), `PROJECT_BIBLE.md`, the roadmap, the board. ⚠️ I also do not run `git`, `npm run build`, the dev
server, or full `npm run test:integration`.

---

## 10. Tests — written first, and failing for the right reason first

Integration, on my lane DB via `it.mjs`. ⚠️ `shareat_test_t216b` is at 0137, so it takes `0138` before
any of this can go red for the right reason — re-run `make-test-dbs.mjs` on it rather than diagnosing
a stale read.

| # | Case | Where |
|---|---|---|
| 1 | An unlink stores the administrator's reason, trimmed | `credentials-admin.test.ts` |
| 2 | An unlink with `'   '` is refused, with the domain's sentence — and ⭐ **the credential is still live afterwards**, proving the refusal happened before the write | `credentials-admin.test.ts` |
| 3 | ⛔ **§2a's control.** Raw SQL setting `revoked_at = now()` with `revoke_reason` NULL is refused by the **database**. Without this the constraint could be a no-op and every other case would still pass | `credentials-admin.test.ts` |
| 4 | ⭐ **§2's control.** `setPin` re-issue still succeeds and writes `revoked_by IS NULL` **with** the system sentence — the case a verbatim copy of the attendance check would break | `sessions.test.ts` |
| 5 | A live row still accepts `revoke_reason IS NULL` — the first branch, so the constraint has not quietly become "every row needs a reason" | `credentials-admin.test.ts` |
| 6 | The existing 13 `unlinkCredential` call sites and 2 `sessionsRepo.revokeCredential` call sites, updated for the new shapes | both files |

Case 3 is the one that matters most, and it is the one a normal test suite would never have: every
other case writes rows through code that supplies a reason, so all of them pass against a constraint
that does nothing.

---

## 11. Out of scope, and why

- **`revoked_by NOT NULL`.** Tempting beside a required reason, and wrong — §2. `setPin` has no
  principal, and inventing one is the fabricated attribution `repo/sessions.ts:138` already refused.
- **Showing revoked credentials, with their reasons, on the user page.** The page lists live
  credentials only. A revocation history is a real screen with real questions (how far back, who may
  see it, does it page) and it is not this migration's job.
- **Backfilling *inferred* reasons.** §4.
- **Bringing `attendance_credentials` up to the non-blank bar.** §5 — logged, not done here. Changing
  two tables' constraints in one migration is the thing DEF-229's own register row declined to do.

---

## 12. Done when

Typecheck exit 0 · unit green · the six cases above green on `shareat_test_t216b` via `it.mjs` ·
`0138` applied to `shareat_dev` and the constraint **read back from `pg_constraint`** rather than
trusted from the migrator's exit code (0137's own lesson) · self-reviewed line by line · then handed
to the orchestrator for build, smoketest on 9008, the browser check at 390 px on
`/admin/users/[personId]`, and the register/bible rows.

---

### FOR IAN

`person_credentials` is the table that decides who can sign in to anything. When somebody's account is
unlinked today, the system records **who** did it and **when** — but not **why**. The staff-badge
table two doors down has required a reason since it was built; this one never has. This adds it, and
makes the database refuse a revocation that doesn't carry one, so it can't be skipped later by a screen
that forgets to ask.

Two things I'd like a nod on, neither urgent:

1. **Old revocations that have no reason.** There are none on this machine — I counted, all three
   databases, zero. I'd still write the one line that stamps any that exist on the server with
   *"Revoked before a reason was required"*, so the table has no unexplained gaps. The alternative
   leaves those rows permanently exempt, which is tidier today and a trap later.
2. **A blank reason.** I want the database to reject an empty box, not just the screen. The badge table
   only rejects it in the screen, which means a future code path could write one. I'd rather be
   stricter here and log the badge table's looser rule for someone to fix, than copy the weaker version
   for the sake of matching.

Nothing here changes how anyone signs in. The one visible difference: unlinking an account on the user
page will ask for a short reason first, the same way revoking a staff badge already does.

---

### Model

Spec on **Opus 5** (lane D, the migration lane). ⚠️ The implementation is **Sonnet-able and should be
Sonnet** — it is a hand-written migration, one column, one constraint, two writers and a form input,
against a spec that names every file and every case. The only genuinely subtle parts (§2 and §2a) are
resolved here in writing, and §10 case 3 and case 4 are the controls that catch it if they were
resolved wrongly.

---

## 13. As built (lane D, 2026-09-08)

Approved with **both decisions going the spec's way**: §4 option A (backfill the sentinel, a
fully-validated CHECK) and §5's `btrim(…) <> ''` included, the orchestrator writing the register row
for the sibling divergence.

### 13.1 What the orchestrator added to §4 that I could not establish from a lane

The production count is **zero by construction, not by assumption**: no organisation exists on
production yet — nobody has completed sign-in — so `person_credentials` has no rows there at all.
That is a better fact than the one the spec had ("unknown from here"), and it did not change the
decision: the backfill statement is written and is a no-op everywhere it has run.

> ⛔ **THE CONSTRUCTION IS GONE — T-300, 2026-09-13. The decision is unchanged, but this is no
> longer the reason for it, and the paragraph above must not be quoted forward.**
>
> Production holds **one** organisation (`SHAREAT OPC`; `select count(*) from organizations` → `1`,
> measured 2026-09-13 as the admin role, the one role RLS cannot filter). It was created between
> 2026-09-06 evening and 2026-09-12 15:57 UTC.
>
> ⚠️ **And `person_credentials` is very unlikely to be empty any more, which is the part that
> matters here.** `bootstrapOrganization` writes the organisation, the first person, that person's
> PIN and the link to their email account **in one transaction** (`docs/ops/README.md` §"Standing
> up an organization", step 4). An organisation existing therefore implies at least one credential
> row, and the clause *"nobody has completed sign-in"* is false on the `/setup` path, which
> requires a verified Firebase sign-in before it will open.
>
> ⭐ **Why the decision survives anyway, and on a better argument than a row count.** §4 option A
> was chosen because the CHECK is **fully validated** — the database enforces it. Any row inserted
> after the constraint exists must satisfy it or the insert is refused; correctness never depended
> on how many rows were there. The count decided only whether the *backfill* had work to do, and a
> backfill that is a no-op and a backfill that rewrites one row reach the same end state.
>
> ⚠️ **What is genuinely not established**, stated rather than assumed: whether
> `0138_def229_credential_revoke_reason.sql`'s backfill ran before or after SHAREAT OPC was created. It does not change the outcome — rows written by
> today's code carry the reason by construction — but nobody should claim from this document that
> production's `person_credentials` is empty. **It almost certainly is not.**

### 13.2 Both traps, executed rather than reasoned about

- **§2 — the sibling's shape.** `sessions.test.ts` now has *"a superseded PIN is revoked with the
  system sentence and NO principal"*, which asserts `revoked_by IS NULL` **and** a non-null reason on
  the same row. Under `attendance_credentials`' triple check that row cannot exist, so the case is
  the standing guard against somebody "tidying" the two constraints into one shape later.
- **§2a — the NULL-blind CHECK.** `credentials-admin.test.ts`' raw-SQL control asserts the DATABASE
  refuses `revoked_at = now(), revoke_reason = null`. ⭐ **Read back from `pg_constraint`, not
  trusted from the migrator's exit code** (0137's lesson), on both databases:
  `CHECK ((((revoked_at IS NULL) AND (revoke_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND
  (revoke_reason IS NOT NULL) AND (btrim(revoke_reason) <> ''::text))))`, `convalidated = true` —
  so it is a validated constraint, not the `NOT VALID` option §4 declined.

### 13.3 One deviation from §9's file list, and it is an addition

`packages/auth/src/index.ts` — an eleventh file. `PIN_SUPERSEDED_REASON` is exported from
`sessions.ts` and re-exported from the barrel so the test asserts **the constant the code writes**
rather than its own copy of the sentence. Caught in self-review: the first draft of the test carried
a duplicate string literal, which would have gone on passing after somebody edited one of the two.
A one-line barrel addition, no behaviour, but §3.3 says say so rather than let it pass unmentioned.

### 13.4 Evidence — what was actually run

| Gate | Result |
|---|---|
| Red first, and the right red | 5 new cases failed as `column "revoke_reason" does not exist`; the blank-reason case failed as *"promise resolved instead of rejecting"* — no validation existed yet. `sessions.test.ts`: 3 failed |
| `credentials-admin` + `sessions` | **46 passed (2 files)** on `shareat_test_t216b` |
| Adjacent suites touching the table | **82 passed (5 files)** — `roles`, `first-run-setup`, `organizations`, `stores`, `email-sign-in` |
| The rest of the credential surface | **95 passed (4 files)** — incl. `attendance-credentials`, `payroll`, `attendance-adjudication` |
| Unit | **77 files, 1163 passed / 1 skipped** |
| Typecheck | ⛔ **exit 2 — and NOT from this task.** Errors in exactly two files, both peers' in-flight work: `apps/erp/tests/filter-row.test.ts` (T-241) and `apps/erp/src/app/attendance/terminals/page.tsx` (T-240). **Zero errors in any file this task touched.** Consequence: the tree cannot be committed until those two land — this slice is not the thing holding it |
| Migration applied | `shareat_test_t216b` and `shareat_dev`, both read back from `pg_constraint` |

⚠️ **Not run by this lane, by protocol:** `npm run build`, the dev server, the browser check at
390 px on `/admin/users/[personId]`, and full `npm run test:integration`. The browser check is the
one that matters here — §8's `flex-wrap` claim about the input dropping under the account on a phone
is reasoned from the row's existing classes and the sibling form, and has **not been seen**.

### 13.5 Logged in passing (§13 row 164), not fixed

- `apps/erp/tests/filter-row.test.ts` passes at runtime while failing typecheck — it constructs
  `FilterRow` without its required `children`. Runtime-green, gate-red: reported to the orchestrator,
  it belongs to whoever owns T-241.
