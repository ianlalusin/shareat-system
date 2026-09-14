# T-298 — DEF-327: the deploy's migrate step connects as the app role, which by design cannot migrate

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-298`) for the commit, date and outcome —
> the roadmap is the maintained record.

Source: measured, not hypothesised — `gh run view 34680033997 --log-failed`.

## What was measured, before any theory

| Fact | Evidence |
|---|---|
| Last SUCCESSFUL Deploy | run `34673471861`, 2026-09-12 04:36:58 UTC — `Migrations applied in 231ms`, `healthy after 1 attempt(s)` |
| Next Deploy | run `34680033997`, 2026-09-12 07:10:31 UTC — **`Migration FAILED: PostgresError: permission denied for database defaultdb`**, code `42501`, `aclchk.c:2793` |
| Both ran against | the same host, the same `.../defaultdb?sslmode=require` |
| `55fc4bd` (added the `orphan-file-sweep` npm script) | committed 2026-09-12 05:23:45 UTC — **after** the last good deploy, **before** the failed one |
| Deploys since | `34699912489` and `34700481646` both **skipped** — CI was red, so `workflow_run` never fired the job. ⚠️ **Corrected 2026-09-13 by system32-85, measured, not the DEF-325 this row originally named**: the red CI is **DEF-328** — `.github/workflows/ci.yml:40` sets `FIREBASE_PROJECT_ID: ci-placeholder` while `:44` sets `NEXT_PUBLIC_FIREBASE_PROJECT_ID: ci`, and `packages/core/src/env.ts:201-209`'s contract check throws `REFUSED TO START` on that disagreement — 3253 times, 109 of 122 integration files, across all three failing runs. DEF-325 never once appears as a CI failure in the logs measured. This does not change anything about DEF-327 below: DEF-328 stops Deploy from *starting*, DEF-327 stops it from *finishing* — both must be fixed before one lands |

## Why nothing has deployed, in one line

`deploy.yml`'s remote heredoc runs `npm run db:migrate` under `set -euo pipefail`, and the migrate
step is **before** the symlink swap and the restart:

```
cd "$RELEASE"
npm run db:migrate            # <- fails 42501
ln -sfn "$RELEASE" /srv/shareat.new
mv -Tf /srv/shareat.new /srv/shareat
sudo /usr/bin/systemctl restart shareat-erp.service
```

So the artifact unpacks, the migration is refused, `set -e` aborts, and `/srv/shareat` still points
at the release built before `55fc4bd`. **That is precisely why the unit's log says
`npm error Missing script: "orphan-file-sweep"`.** The deploy failed SAFE — the comment in the
workflow claims exactly this behaviour and it held — but it failed silently as far as the host was
concerned.

## The cause is already written down in this repository

`docs/ops/README.md` §"⛔ THE CONSEQUENCE THAT WILL BITE: migrations on the box must use the ADMIN
string" — written 2026-09-12, the same day:

> `npm run db:migrate` reads `DATABASE_URL`. `shareat_app_prod` is `NOCREATEDB NOCREATEROLE` and
> owns no table, so it **cannot run a migration** — correctly, and by design. A deploy or a manual
> migrate that inherits the file as written will fail with a permission error.

The doc gave the manual recipe and **the deploy pipeline was never given the same treatment.** The
prediction was correct and unacted-on for one line of YAML.

## Out of scope — hard

- ⛔ Do **not** grant `shareat_app_prod` any DDL right, and do **not** let it own a table. The ops
  doc says why, and the reason is the whole point of the 2026-09-12 role change.
- ⛔ Do not touch `docs/ops/README.md` — lane C owns that file this cycle. Report the paragraph.
- ⛔ Do not touch `packages/db/migrate.ts` without saying why in the spec.

---

## SPEC — lane A (webapps-65, Sonnet 5), 2026-09-13

> **STOP — awaiting APPROVED from system32-85 before any file outside this doc is touched.**

### Goal

Make `npm run db:migrate` succeed when the deploy's remote heredoc runs it, without granting
`shareat_app_prod` any new privilege. One shell-level change, nothing else in `deploy.yml` moves.

### Scope

- `.github/workflows/deploy.yml` — only the `Unpack, migrate, restart` step's remote script.
- `docs/tasks/298-def-327-deploy-cannot-migrate.md` — this file (the DEF-325→DEF-328 correction
  above, and this SPEC).
- `tests/unit/deploy-migrate-uses-system-db-url.test.ts` — new. Argued for below, under Tests.
  **Not created yet** — BUILD creates it after APPROVED, per protocol.

No other file changes. `packages/db/migrate.ts` is deliberately untouched — see below.

### Contract — the exact change

Replace, inside the `Unpack, migrate, restart` step's heredoc, only this:

```bash
cd "$RELEASE"
npm run db:migrate
```

with:

```bash
cd "$RELEASE"
SYSTEM_DB_URL="$(grep -m1 '^SYSTEM_DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2- || true)"
# DEF-196/DEF-203: this file has a documented history of CRLF line endings and a BOM on the box;
# strip a trailing CR and one layer of surrounding quotes before judging the value empty, so a
# decorated-but-present key is never misreported as absent (Change 2, below).
SYSTEM_DB_URL="${SYSTEM_DB_URL%$'\r'}"
case "$SYSTEM_DB_URL" in
  \"*\") SYSTEM_DB_URL="${SYSTEM_DB_URL#\"}"; SYSTEM_DB_URL="${SYSTEM_DB_URL%\"}" ;;
  \'*\') SYSTEM_DB_URL="${SYSTEM_DB_URL#\'}"; SYSTEM_DB_URL="${SYSTEM_DB_URL%\'}" ;;
esac
if [ -z "$SYSTEM_DB_URL" ]; then
  echo "::error::SYSTEM_DATABASE_URL is missing or empty in /srv/shareat-shared/.env.local — migrations need the admin connection string (docs/ops/README.md § THE CONSEQUENCE THAT WILL BITE). Refusing to run db:migrate rather than let it fail inside migrate.ts with an unrelated 'DATABASE_URL is not set'." >&2
  exit 1
fi
DATABASE_URL="$SYSTEM_DB_URL" npm run db:migrate
```

Everything else in the step — the symlink swap, the restart, the release pruning — is
byte-for-byte unchanged.

⭐ **CHANGE 2, folded in 2026-09-13 (system32-85's review):** the capture originally took the raw
bytes after `=` on faith. Two things this exact file is documented to do would corrupt that
capture without ever naming the cause: a **quoted value** (`SYSTEM_DATABASE_URL="postgresql://…"`
— dotenv strips the quotes on the app's own read path, a raw shell `cut` does not, so the override
would carry literal `"` at both ends) and a **CRLF line ending** (`docs/ops/README.md`'s own trap
table: DEF-196, a UTF-8 BOM on this exact file found on the droplet 2026-09-06; DEF-203, a missing
trailing newline that glued two settings into one 184-character line the same day). I may not SSH
to the host to check the live file's actual format (out of scope, hard), so per system32-85's
instruction I took the cheap, defensive direction rather than assume the format needs no
handling: strip a trailing `\r` first, then one matching layer of surrounding `"…"` or `'…'`.
**Verified against six synthetic cases** before writing this into the contract — unquoted,
double-quoted, double-quoted+CRLF, unquoted+CRLF, single-quoted, and the missing-key case — all six
produced the correct bare URL (or, for the missing key, the correct empty string that the `-z`
guard already catches). The ops doc's own manual recipe has neither defence and shares this exact
exposure; this fix does not carry the flaw forward into the automated path.

⚠️ **Deliberately NOT handled, and named rather than silently left**: DEF-203's *gluing* failure
mode (two `KEY=value` pairs joined onto one line by a missing newline) is a **write-time** file
corruption, not something a read-time `grep`/`cut` can reliably distinguish from a URL that
legitimately contains `=` in a query parameter — and DEF-203 is already closed procedurally
(`docs/ops/README.md`'s "Method worth reusing": `printf '\n' >> file` before any future append).
Adding heuristics here to guess at re-glued lines would be speculative surface, not a fix for
anything this task's evidence shows is still happening.

### Invariants, with citations

1. **`shareat_app_prod` gets no new privilege, ever.** Enforced by the out-of-scope list above and
   mechanically by the new test's assertion 2 below.
2. **The override never leaks past the one command.** `DATABASE_URL="$SYSTEM_DB_URL" npm run
   db:migrate` is a command-scoped assignment, not `export` and not a standalone line — only that
   child process sees it. Verified under Q3 below, and mechanically by test assertion 4.
3. **An absent or empty admin string fails LOUDLY and NAMES the right file** — never proceeds
   silently, never blames `.env.local`'s `DATABASE_URL`. Verified under Q3 below.
4. **`set -euo pipefail` still aborts before the symlink swap on any failure** — unchanged: the
   guard's `exit 1` and `npm run db:migrate`'s own nonzero exit both still sit before `ln -sfn`.
5. **A quoted or CRLF-decorated admin string is never mistaken for an absent one, and is never
   passed to `postgres()` with the decoration still attached.** Verified above (Change 2) against
   six synthetic cases; mechanically enforced by the new test's CR/quote-stripping assertion.

### The four questions — answered, verified, not assumed

**Q1 — does the command-scoped override actually win over `.env.local`?** VERIFIED against the
installed package, not trusted from the register's citation. `node_modules/dotenv/lib/main.js`
(dotenv `16.6.1`, confirmed installed version), function `populate()`: for each parsed key, it
checks `Object.prototype.hasOwnProperty.call(processEnv, key)` and skips the key entirely unless
`options.override === true`. `packages/db/migrate.ts:11` calls `config({ path: '../../.env.local'
})` with no `override` option, so it defaults to `false`. A command-scoped `DATABASE_URL=...`
sets `process.env.DATABASE_URL` before Node starts, so by the time `migrate.ts` calls `config()`
the key already exists on `process.env` — dotenv leaves it alone. This is the exact mechanism
`~/.claude/skills/orchestrator/tools/make-test-dbs.mjs:9-10` relies on
(`spawnSync(migrateCmd, { env: { ...process.env, DATABASE_URL: urlFor(name) } })`), read and
confirmed to do the same thing. **The fix works for the reason the ops doc assumes.**

⭐ **Corroborated by live reproduction, system32-85, 2026-09-13** (I did not run this myself —
attributing it): a scratch database migrated to `0146`, with a non-superuser, non-BYPASSRLS,
no-table-owning login (`shareat_test_runner`, the structural analogue of `shareat_app_prod`) as
the injected process-env `DATABASE_URL`, still hit `permission denied for database
shareat_test_migrole` (`42501`) — while the admin role against the same database succeeded,
`Migrations applied in 225ms`. Two independent methods (reading the installed dotenv source vs.
reproducing the failure live) now agree: source-level reasoning and behaviour match.

**Q2 — is `SYSTEM_DATABASE_URL` (`doadmin`, `rolbypassrls=t`) the right thing for a deploy to run
DDL as, or does it quietly re-open the 2026-09-12 role change?** Yes it's right, and no it doesn't
— two things that change need separating:
  - **What the role change bought stays untouched.** Every *application request* the running app
    makes still resolves `DATABASE_URL` from `.env.local` on disk, which this fix never edits —
    `shareat_app_prod`, RLS-enforced, unconditionally. The override lives only inside one SSH
    shell's one command and dies with that shell.
  - **DDL was never inside RLS's remit.** `CREATE SCHEMA`, `ALTER TABLE`, `CREATE POLICY` are
    schema operations, not row reads — RLS gates rows. `shareat_app_prod` was built
    `NOCREATEDB NOCREATEROLE`, owning no table, precisely so it *cannot* do this; the ops doc's
    ban on granting it DDL is about not undoing that specific property, not about migrations never
    running elevated. Migrations have always needed an elevated connection — 2026-09-12 made that
    explicit (a second key) where it used to be implicit (one key for everything).
  - **Blast radius, bounded three ways, all verified**: (a) shell-scoped to one command, never
    exported (Q3, Invariant 2); (b) never written to `.env.local` — the running service is never
    touched; (c) identical string, identical idiom to the ops doc's own manual recipe — this
    automates a path that is already trusted, it doesn't open a new one.
  - **Recommendation: use it, scoped exactly as in Contract.** The forbidden alternative (granting
    `shareat_app_prod` DDL/ownership) is strictly worse, and a migration has to run as *something*
    that can alter schema — there is no third option.

**Q3 — what happens if `SYSTEM_DATABASE_URL` is absent, traced precisely and verified rather than
assumed?** Ran both candidate shapes under `bash -euo pipefail` against a file with no
`SYSTEM_DATABASE_URL` line, on this machine, before writing this section — not asserted from the
register's prose:
  - **The naive prefix form** (`DATABASE_URL="$(grep ... | cut ...)" npm run db:migrate` with no
    guard): the failing `grep` does **not** trip `set -e` — a command substitution's exit status
    is absorbed into the value being built for a command-prefix, not the enclosing command's own
    status. Measured: the line printed `DATABASE_URL=""` and continued into `npm run db:migrate`,
    exit 0 for that shell statement. `migrate.ts:15-17` then sees `url === ''`, `!url` is `true`,
    and throws `'DATABASE_URL is not set. Copy .env.example to .env.local first.'` — pointing at
    the wrong file, exactly the register's concern.
  - **A naive standalone-assignment form** (`DATABASE_URL="$(grep ... | cut ...)"` on its own
    line, then `npm run db:migrate` separately): this DOES trip `set -e` — measured, whole script
    exit 1 — but silently: `grep`/`cut` write nothing to stderr on no-match, so the log shows a
    bare abort with **no message at all**.
  - **The guard this spec adds** closes both gaps: `SYSTEM_DB_URL="$(... || true)"` neutralises
    the pipeline's exit status (measured: same missing-key input now yields `SYSTEM_DB_URL=""`
    and the script keeps running to the check), then `if [ -z "$SYSTEM_DB_URL" ]` catches both
    "key absent" and "key present but empty" — the register's fourth DEF-315-class instance —
    under one check, prints a `::error::`-prefixed message naming the real file and the real
    missing key, and exits **before** `npm run db:migrate` is ever invoked. Measured: nonzero
    exit, message printed, migrate never reached. Fail LOUD and fail ACCURATE, as asked.

**Q4 — safe to let `0144`, `0145`, `0146` fire unattended the moment this and DEF-328 both land,
or should Ian apply them by hand first?** Read all three in full, then
`node_modules/drizzle-orm/pg-core/dialect.js:44-72` to see how they're actually applied rather
than assume:
  - **The migrator, verified from source**: `CREATE SCHEMA IF NOT EXISTS "drizzle"` and the
    tracking table run first as ordinary autocommit statements — confirmed the exact statement
    DEF-327 dies on today, at the source level, not just from the error text. Then **every
    pending file runs inside ONE Postgres transaction**
    (`session.transaction(async (tx) => { for (migration of migrations) {...} })`) —
    `0144`/`0145`/`0146` all commit together or none do. No partial-apply state between them.
  - **What the three actually do**: `0144` widens a `CHECK` constraint — strictly a superset,
    cannot reject an existing row. `0145` replaces a trigger function's body to change which
    error *message* it raises; its own header states "BEHAVIOUR DOES NOT CHANGE." `0146` creates
    one new, empty, RLS-protected table and adds one nullable column plus two constraints to
    `person_grants`; its own header states "No backfill. There are no defaults yet." None writes,
    rewrites, or deletes an existing row.
  - ⛔ **CORRECTED 2026-09-13, same day, before this line was ever approved on the strength of the
    premise it originally used.** This section first read "production holds zero organizations,"
    quoting `docs/ops/README.md`'s "Status as of 2026-09-12" section directly. **That is false.**
    system32-85, re-deriving that document's claims under T-300, measured
    `/var/log/shareat/budget-reissue.log`: `ok — created 0 · 1 orgs` — a true `count(*)` of
    `organizations` through the system door (`budget-reissue.ts:74` prints `outcomes.length` from
    an unfiltered `select`). **Production holds ONE organisation, "SHAREAT OPC."** I did not run
    that measurement myself and could not (no host access from this lane) — attributing it rather
    than re-asserting it as my own finding. The conclusion below does not lean on either org
    count; it is argued to hold regardless, which is the more defensible shape and would have been
    true yesterday too.
  - **Why the content is low-risk independent of how much data exists, verified rather than
    assumed:**
    - `grep -inE '^\s*(INSERT|UPDATE|DELETE)\b'` across all three migration files returns nothing
      — confirmed myself, not taken on report. They are pure DDL; there is no data-write statement
      in any of the three that could go wrong at any org count.
    - The one place a new constraint IS checked against pre-existing rows is `0146`'s
      `person_grants_position_source_ref_check`. `source_ref` is a column this same migration
      adds, so every existing `person_grants` row has `source_ref IS NULL` regardless of how many
      organisations or grants exist. Worked the truth table myself against the constraint's actual
      text (`0146_t289_position_capability_defaults.sql`):
      `("grant_source" = 'position' AND "source_ref" IS NOT NULL) OR ("grant_source" IS DISTINCT
      FROM 'position' AND ("source_ref" IS NULL OR "grant_source" = 'grant'))`. For every value
      `0140` could have left in `grant_source` on an existing row — `NULL` (migration `0140`'s own
      header: pre-existing active grants were deliberately left `NULL`, not backfilled),
      `'elevation'`, `'owner'`, or `'grant'` — the second branch's `IS DISTINCT FROM` reads as
      `TRUE` (it never returns NULL, unlike `<>`) and `source_ref IS NULL` is `TRUE`, so the whole
      expression is `TRUE` in all four cases. **No existing row can fail this constraint,
      structurally, not by luck.**
    - The parallel FK (`person_grants.source_ref` → `position_capability_defaults.id`) validates
      trivially for the same reason: a NULL foreign-key value is never checked against the
      referenced table, by ordinary SQL FK semantics, regardless of row count.
    - `0146` also drops and re-adds `person_grants_source_check` to admit `'position'` alongside
      the four existing values (`grant_source IS NULL OR grant_source IN ('elevation', 'position',
      'owner', 'grant')`) — confirmed consistent with what `reconcilePositionGrants` will actually
      write, so this isn't a migration that passes today and traps a future insert.
  - **So the content is low-risk on a basis that holds regardless of organisation count — but the
    mechanism is unproven.** No deploy
    and no manual run has ever successfully executed `db:migrate` against production with
    `SYSTEM_DATABASE_URL`; every attempt since the role change has died at the same `CREATE
    SCHEMA` permission error. The first proof that this path works end to end — does the admin
    role actually have `CREATE` on the database, does the restart that follows come up healthy —
    would, if this fix and DEF-328 land together, happen unattended, with three schema changes
    riding along and nobody at a terminal.
  - ⭐ **Production's schema is cleanly at `0143` today — no partial application, checked against
    a real precedent rather than assumed.** `docs/ops/README.md:162` records that an *earlier*
    failed deploy (the `ln: failed to create symbolic link` incident) still left
    `"Migrations applied in 288ms"` in production, because that failure happened **after** the
    migrate step succeeded. DEF-327 is the opposite shape: the failure is the migrate step itself,
    and it fires at the migrator's own bootstrap statement (`CREATE SCHEMA IF NOT EXISTS
    "drizzle"`), before a single file is read. system32-85's live reproduction (2026-09-13)
    confirms this structurally: a run with **zero pending migrations** against the restricted
    role still failed identically to a run with three pending — proving the refusal cannot depend
    on reaching `0144` at all. So unlike the `0130` precedent, nothing here has landed
    part-way; `0144`/`0145`/`0146` are fully intact and fully unapplied.
  - **Recommendation, with the reason**: have Ian run the migration once by hand first, watching,
    with the ops doc's existing recipe, before trusting the automated pipeline for the first time
    — not because `0144`–`0146` are dangerous (argued above that they are not), but because
    proving the admin-string mechanism works belongs in a moment someone can react to, and a
    first-of-its-kind unattended run stacked with a second fix landing at once is exactly what the
    ops doc itself calls out ("the first bootstrap-org on this configuration is therefore still
    the real test, and it should be done with someone watching rather than in passing"). This is a
    one-time caution about the pipeline's *first flight*, not a standing gate — once proven once,
    watched, `0147` onward needs no hand-holding.

### FOR IAN (bible row 200 — plain language; identifiers are supporting detail only)

**What's broken:** every attempt to push a finished update to the live ERP has been quietly
failing at the very last step for about two days. The update gets built and shipped, but applying
it to the live database gets refused, so it never actually takes effect (it fails safely — the
site just keeps running the older version, nobody sees anything break).

**Why:** two weeks ago you tightened the live database so the app's everyday connection can no
longer make structural changes to it — a real security improvement, and it's working exactly as
intended. But the part of the deploy process that updates the database structure was never told
to use the more privileged connection you set up alongside that change — so it's still trying
with the everyday connection, which correctly refuses it.

**What I'm fixing:** one line in the deploy process, so that one step uses the privileged
connection, the same way you'd already do it by hand. Nothing about the everyday connection
changes.

**What you need to decide:** once my fix and a separate fix another session is making (why
automated testing has been failing) are both in, the very next successful deploy will *also*
apply three pending database updates automatically — including the new "position access
defaults" feature. I read all three closely: they only change the *structure* of the database
(new table, wider rules, a clearer error message) — none of them write, change, or delete a
single existing record, in your one live organisation or anywhere else. What I can't vouch for is
that the privileged connection will actually work the very first time it's tried for real — it has
never once succeeded since you tightened the database two weeks ago.
**My recommendation: the first time, run that one database-update step yourself by hand while
watching (the exact steps are already written down in the ops doc), before letting the automated
deploy do it unattended.** If it goes cleanly by hand, there's no reason to keep doing it by hand
after that.

### Tests

`tests/unit/deploy-migrate-uses-system-db-url.test.ts` — new, dependency-free (same rationale as
`tests/unit/app-boundaries.test.ts`: no linter in this project, DEF-027), reads
`.github/workflows/deploy.yml` as text and asserts, scoped to the `Unpack, migrate, restart`
step's heredoc only:

1. No bare, unprefixed `npm run db:migrate` remains — every invocation is
   `DATABASE_URL="$…" npm run db:migrate`.
2. The override is sourced from `SYSTEM_DATABASE_URL`, and the file never grants
   `shareat_app_prod` DDL or ownership as an alternative fix (the out-of-scope ban, made
   mechanical).
3. A `[ -z "$…" ] … exit 1` guard referencing `SYSTEM_DATABASE_URL` exists **before** the
   `npm run db:migrate` line.
4. The override is never `export`ed and never assigned as a standalone line — it stays scoped to
   the one command.
5. **(Change 2)** The captured value is defensively unwrapped — a trailing `$'\r'` strip and a
   `case "$SYSTEM_DB_URL" in` quote-stripping block both exist, before the emptiness check.

This cannot exercise the actual deploy (no GitHub Actions runner, no SSH target from this lane) —
it only proves the YAML keeps the shape DEF-327 requires, so a future edit that "simplifies" the
migrate line back to bare `npm run db:migrate` (how this defect happened the first time), or drops
the quote/CR stripping, turns red here instead of at the next production deploy. All five
assertions were run against the exact candidate script text before either file was written, using
a throwaway script under the scratchpad — not written on faith that the regexes would match.
**Not created yet — BUILD adds it after APPROVED, confirmed red against the current file, then
green after the Contract change.**

### Why `packages/db/migrate.ts` stays untouched

Considered and rejected: a `SYSTEM_DATABASE_URL` fallback inside `migrate.ts` itself. Rejected
because (a) it would apply in every context `migrate.ts` runs — local dev, the lane test-DB
tooling — none of which have or need a `SYSTEM_DATABASE_URL`; (b) the shell-level fix is strictly
narrower, changing behaviour only in the one deploy step that needs it; (c) the out-of-scope list
already asks this be flagged rather than done. Flagged: no change to `migrate.ts` is needed to
close DEF-327. A future task could add defense-in-depth inside the migrator (refusing to attempt a
migration against a role known to lack `CREATE`) — separate, larger, not needed here.

### Out of scope — adds to the list above

- Gating the first production migration behind a manual step is Ian's call (Q4), not this lane's
  to implement in the workflow — I report the recommendation, I don't add a workflow gate.
- `docs/ops/README.md` stays lane C's. If Q2's reasoning belongs there as a paragraph, route it
  through system32-85 — the existing "THE CONSEQUENCE THAT WILL BITE" section already documents
  the mechanism this fix implements, so I'm not proposing new prose, just flagging the option.

### Done-when

- [ ] SPEC approved by system32-85.
- [ ] `.github/workflows/deploy.yml`'s migrate line replaced exactly as in Contract; nothing else
      in the file touched.
- [ ] `tests/unit/deploy-migrate-uses-system-db-url.test.ts` added — confirmed red against the
      pre-fix line, green after the Contract change.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` (unit project, includes the new test) green.
- [ ] READY sent with real command output, not paraphrased.
- ⚠️ **Cannot be in done-when, said plainly**: a green GitHub Actions Deploy run. That needs a
      push to `main`, which only the orchestrator can do — this lane cannot prove the YAML
      executes correctly on the runner or the droplet, only that its shape is correct.
