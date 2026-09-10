# ADR-012 — Migrations are hand-authored; `npm run db:generate` is retired

| | |
|---|---|
| **Status** | ✅ **ACCEPTED 2026-09-10 — Ian, the same day:** *"document this well … so it won't be rediscovered as it was before your work … on bible see where it fits."* Built on the orchestrator's brief for DEF-242, which delegated the answer to whichever direction the evidence supported; ratified by Ian in chat and carried into the bible on his instruction (rule 14, satisfied by the owner himself) |
| **Raised by** | DEF-242 (2026-09-09), which is DEF-073 (2026-08-27) and DEF-121 (2026-09-01) found a third time |
| **Forced by** | Ian's question on the board: *"repair the generator, or write the convention down?"* — it governs how every future schema change in this project is written |
| **Decides for** | Every migration from 0141 on; `packages/db/package.json`'s `db:generate`; whether `migrations/meta/*_snapshot.json` is ever extended |
| **Does not decide** | The journal's one-day-per-index `when` grid (DEF-091 — kept, and it is the reason this ADR exists) · whether RLS policies should ever be declared in `schema/` (not adopted; §6) · the drizzle-kit version pin |
| **Bible amendment** | ✅ **APPLIED 2026-09-10** on Ian's instruction — §13 **row 191**, §2 rule 8, §15.5. §8 below keeps the text as it was proposed; the row as applied carries Ian's words |

---

## 1. The answer, first

**Write the convention down. Do not repair the generator.** Not because the repair is dangerous —
the dangerous part was measured and it is *not* dangerous — but because the half of the generator
that cannot be repaired is the half that matters, and the half that can be repaired has never once
been maintained in this repository.

The measurement that everyone was afraid of came back clean: a snapshot regenerated from today's
`schema/` would be **truthful** — across 127 tables, 1,636 columns, 518 foreign keys, 312 indexes,
356 checks and 4 views it declares nothing the migrated database lacks and disagrees with it on
nothing real (§3). So committing one would not make the generator lie. It would make it *write a
journal entry the migrator silently skips*, every single time (§2.2), and no drizzle-kit option or
snapshot changes that. That is DEF-039's exact shape, reloaded on the command people reach for
first.

What changes for a lane: nothing about how migrations are written — 104 in a row have been
hand-authored since 0020, and CI proves every one from an empty database on every run. What
changes is that `npm run db:generate` now **says so and exits 1** instead of opening a false
prompt about `expense_categories`, and the checklist lanes have been following from memory is
written down (§5) with the guards that enforce it named.

## 2. What is actually broken — three findings, each verified

### 2.1 The snapshot chain ended at 0019 and was never a chain to begin with

`packages/db/migrations/meta/` holds **12** snapshot files (`0000`, `0001`, `0003`, `0007`,
`0008`, `0010`, `0014`–`0019`); the journal holds **124** entries, idx 0–140 with 17 reserved
gaps (73–79, 90–99). The last snapshot was committed 2026-08-26 (`d404a70`, T-124). Every one of
the **104** migrations since — idx 20 through 140 — was hand-authored with no snapshot, and so were
8 of the first 20. `drizzle-kit generate` takes the last snapshot file as its baseline, so it
diffs today's schema against the 0019-era `expense_categories`, sees `sub_category` gone and
`is_system` new in the same table, and asks whether that is a rename. Reproduced 2026-09-10 with
stdin closed: the prompt appears, the tool **exits 0**, nothing is written.

The snapshots are not gitignored and were never deleted (`git log --diff-filter=D` on the folder
is empty). They were simply never created. DEF-121's open question — pruned or never made — is
answered: never made.

### 2.2 The journal's `when` grid makes every generated entry unappliable — permanently

This project deliberately puts `_journal.json`'s `when` on a **one-day-per-index grid** from idx
60 (DEF-091: a reserved index block must reserve a `when` block too, or two lanes collide on the
shared dev database). `packages/db/tests/migration-journal.test.ts` enforces it. As of
2026-09-10, **90 of 124** entries carry a `when` in the future; the head, 0140, is stamped
**2026-12-25**, and each new migration pushes it another day.

drizzle-kit 0.30.6's writer stamps a generated entry with the wall clock — verified in
`node_modules/drizzle-kit/bin.cjs`, `writeResult`: `when: +new Date()`. Today that is ~106 days
*below* the head. Drizzle's migrator applies a migration only when
`lastApplied.created_at < this.when` (DEF-039), so a generated migration would be **silently
skipped** on any database already at 0140 — no error, exit 0. The journal test catches it, but
only when `npm run test` runs; a lane that runs `db:migrate` on its lane database first gets the
silent skip. There is no drizzle-kit option that controls `when`, and because the head advances a
day per migration while lanes ship several a day, the wall clock will never catch up.

This finding is independent of the snapshots. A perfect baseline does not touch it.

### 2.3 Everything a table here needs that the generator cannot emit

On a database built from zero by the 124 migrations (§4), drizzle can *see* but `schema/` does
**not declare**: RLS enabled on all **127** tables and **122** policies (TS declares 0 of either),
**6** expression unique indexes (`lower(trim(name))` and friends), **2** EXCLUDE constraints,
**15** plain indexes, **8** self-referencing/late-added foreign keys, **86** CHECK constraints
(array shapes, `NOT VALID` two-person rules), **1** unique constraint and **1** view. And what
drizzle can never see: **45** triggers, the functions behind them, and the `btree_gist` and
`pg_trgm` extensions. Every table migration in this repository has therefore always been
hand-augmented, and the schema files already say so table by table (`employment.ts:132-134`,
`expenses.ts:92-98`, `fiscal-periods.ts:33-35`, `attendance-config.ts:351-353`).

For completeness, the tooling itself is also broken in this repo for anything that *reads* a
database: `drizzle-kit introspect` requires `drizzle-orm/gel-core`, which drizzle-orm 0.38.4 does
not ship, and the programmatic `pushSchema` fails its own validation on Postgres 18's expression
indexes (`expression: null`). Neither is why this ADR decides as it does; both are why the
measurement in §3 had to be done from `pg_catalog` directly.

## 3. The measurement — would a regenerated snapshot lie?

This was the stated risk: *a naively regenerated snapshot can silently disagree with what the SQL
actually did over 120 migrations, and then the generator produces confidently wrong migrations
instead of refusing.* So it was measured, not reasoned about.

**Method.** A scratch database (`shareat_scratch_def242`, created for this and dropped after) was
migrated from zero by `migrate.ts` — 124 applied, head `when` 1798169507084, 127 tables. The TS
schema was serialised through drizzle-kit's own `generateDrizzleJson` (the exact function
`generate` uses). A script then compared that snapshot against `pg_catalog` on the scratch
database, object by object: tables, every column's type, nullability and default presence, primary
keys, foreign-key relationships and their ON DELETE/UPDATE actions, index names, uniqueness, key
columns and partial-index predicates, unique and check constraint names, views.

**Result — the direction that would lie: 0 disagreements.** The comparison flagged 3 items and all
three are notation, not fact: `mirror_outbox.id` is `bigserial` in TS and `bigint` + a sequence
default in Postgres (that is what bigserial *is*), and one partial-index predicate differs only by
a `::numeric` cast. Every table, column, foreign-key relationship, index, check and view the TS
schema declares exists in the migrated database exactly as declared.

**The one caveat worth keeping:** **157 of 518** foreign keys carry a different *name* in the
database from the one drizzle would compute (`pay_rates_org_id_fkey` on disk versus
`pay_rates_org_id_organizations_id_fk` in drizzle's naming), and 2 more were truncated to 63
characters by Postgres. A generated `ALTER` on any of those would `DROP CONSTRAINT` by the wrong
name and fail — loudly, not silently. And the 119 database-only objects in §2.3 are invisible to
the generator in both directions: it would never emit them and never drop them.

So the answer to the stated risk is: **no, it would not lie.** That closes the question honestly
and is precisely why §1 can say the repair is *not dangerous* — and still decide against it.

## 4. Proven from zero, first and last

DEF-073 set the bar for whoever touched this: *"`db:migrate` proven green from an empty database
first and last — the only check that actually covers it."* Done on a scratch database before any
file changed and again after: **124 applied, head 0140, ~2 s.** CI does the same on every run —
`.github/workflows/ci.yml` provisions `postgres:18` empty and runs `npm run db:migrate` before the
integration suite — so every hand-authored migration ever merged has been applied from zero by a
machine. The seven `shareat_*` databases were not touched, and the scratch database was dropped.

## 5. The convention — how a migration is written here

This is what lanes have been doing since 0020, written down once. The guards that enforce each
step are named so nobody has to trust memory.

1. **Number it.** The next free idx after the journal head, or the block your lane reserved.
   Gaps are legitimate (the journal test allows them, T-154); the tag↔file test refuses a missing
   file either way.
2. **Name and head it.** `NNNN_<task>_<what>.sql`, opening with a comment that names the task or
   defect, the spec section, and *why* — 0140's header is the model. Statements are separated by
   `--> statement-breakpoint`.
3. **Transcribe from `schema/`, which is where a table is DEFINED (bible §8).** Every rule Drizzle
   *can* express lives in the builder *and* in the SQL. What it cannot express — expression
   indexes, EXCLUDE, array CHECKs, triggers and functions, views, RLS and policies — is hand-added
   in the migration, **and the schema file carries a `// NOTE: … hand-added in migration NNNN`
   comment beside the thing it cannot say.** That note is what stops a future reader "fixing" the
   builder to match the SQL and losing the correct index (`expenses.ts:92-98` explains that trap).
4. **RLS on every new table.** `ENABLE ROW LEVEL SECURITY` plus policies through
   `app_current_org()` — never raw `current_setting(...)` (DEF-077). The table is registered in
   `packages/db/src/rls/registry.ts` and classified in `packages/db/src/cutover/classification.ts`;
   the build stops you until both are done.
5. **Journal it on the grid.** Append `{ idx, version: "7", when, tag, breakpoints: true }` with
   `when = previous.when + 86_400_000 × (idx − previous.idx)`. Never the wall clock, never a round
   future value off the grid — `migration-journal.test.ts` refuses both, and the migrator silently
   skips what the test would have refused (DEF-039).
6. **Never edit an applied migration** (RULES §1 rule 9). 0000–0140 are applied on seven
   databases. A mistake gets a new migration.
7. **Do not add `meta/*_snapshot.json`.** A snapshot for one migration with none for its
   neighbours is exactly what produced the false prompt; the chain is a historical record ending at
   0019 and stays that way.
8. **Prove it.** `npm run test` runs the journal guards. It applies from zero in CI on every run.
   Locally, prove it on a *scratch* database, never a shared one: create `shareat_scratch_<x>`,
   run `migrate.ts` with `DATABASE_URL` pointed at it (dotenv does not override an env var already
   set), read `count(*)` and `max(created_at)` from `drizzle.__drizzle_migrations`, drop it.

## 6. Rejected, and why

**(a) Regenerate and commit `0140_snapshot.json`, keep `drizzle-kit generate` as the writer.**
Truthful today (§3), but it repairs only the diff. Every use would still produce a journal entry
the migrator skips until somebody hand-corrects `when` (§2.2), would still need every item in
§2.3 hand-added, and would decay back into today's false prompt the first time a hand-authored
migration lands without a snapshot refresh — which is what happened within 20 migrations while
the tool *worked*, and then for 104 more. A repair that reintroduces DEF-039 on every use and
depends on a discipline this repository has never kept is not a repair.

**(b) A read-only diff aid** — a script calling drizzle-kit's API to *print* the SQL for a
`schema/` change and write nothing, plus a committed snapshot kept fresh by a ratchet test.
Considered seriously; it would be a real drafting help for a 30-column table. Not adopted now:
it needs a maintained baseline (a ~790 KB JSON file refreshed on every schema edit, and a test
that goes red when it is not), and the hand-authoring defects actually on record — DEF-039,
DEF-091 (journal `when`), DEF-077 (policy predicate) — are all in the part drizzle cannot draft.
The marginal value is low and the machinery is new. **Revisit** if a lane mis-transcribes a large
table, or if this repo ever declares policies in `schema/` and pins a drizzle-kit that can
introspect Postgres 18 — then the API is usable and the baseline can come from the database
instead of a file.

**(c) A wrapper that runs `generate` and rewrites `when` onto the grid afterwards.** Bespoke,
edits the journal drizzle just wrote, and hides the DEF-039 trap behind a tool that looks
standard. *Boring and standard beats clever and bespoke* (bible §0.2).

## 7. Consequences

- `npm run db:generate` (root and `@shareat/db`) runs `packages/db/generate-retired.ts`: prints
  the three reasons and the checklist pointer, writes nothing, exits 1.
  `packages/db/tests/db-generate-retired.test.ts` fails if anyone points it back at drizzle-kit.
- `drizzle-kit` stays installed: `db:studio` uses it and `drizzle.config.ts` now says that is all
  it serves. `db:migrate` never read snapshots (it is `migrate.ts` on drizzle-orm's migrator) and
  is unchanged.
- DEF-073, DEF-121 and DEF-242 close to this ADR, and `packages/db/migrations/README.md` says
  all of this at the top of the folder the next person opens to add 0141. The trap they each recorded — *the failure
  surfaces as an unrelated question about another table* — can no longer surface, because the
  command no longer reaches drizzle-kit.
- What this does **not** fix: `drizzle-kit introspect`/`pushSchema` remain unusable at this
  version pairing (§2.3). Nothing in the repo depends on them.

## 8. Bible row 191 — as proposed (applied 2026-09-10 on Ian's instruction; the live text is `PROJECT_BIBLE.md` §13)

> | 191 | 2026-09-10 | ⭐ **MIGRATIONS ARE HAND-AUTHORED FROM `schema/`; `npm run db:generate` IS RETIRED AND FAILS CLOSED.** `drizzle-kit generate` cannot serve this journal: it stamps `when` with the wall clock, and the one-day-per-index grid (row on DEF-091) keeps the head months ahead of it, so every generated entry would be silently skipped by the migrator (DEF-039). A regenerated snapshot was **measured truthful** — 0 disagreements across 127 tables, 1,636 columns, 518 foreign keys — and rejected anyway, because the journal half cannot be repaired and the snapshot chain has never once been maintained (dead at 0019, 104 migrations ago). The convention lanes were already following is written down with its guards in **ADR-012 §5**; the trap is that the failure surfaced as a question about an unrelated table, which it no longer can | The command says why and points at the checklist | ADR-012 |
