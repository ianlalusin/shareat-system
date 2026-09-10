# Migrations — read this before you add 0141

**Every migration in this folder is written by hand. `npm run db:generate` is retired and will
tell you so.** The convention, as a checklist with the guard behind each step, is
[`docs/decisions/ADR-012-hand-authored-migrations.md`](../../../docs/decisions/ADR-012-hand-authored-migrations.md) §5.
The history — the same discovery made three times because nothing in this folder said so — is
DEF-073 → DEF-121 → DEF-242 in `docs/DEFECTS-REGISTER.md`.

## Why `meta/` has snapshots only up to 0019

drizzle-kit writes a `NNNN_snapshot.json` only when *it* generates the migration. The last one it
generated was 0019, on 2026-08-26. Everything since (idx 20–140, 104 migrations) was hand-authored
with no snapshot, and so were 8 of the first 20. `drizzle-kit generate` takes the **last snapshot
file** as its baseline, so today it diffs the whole schema against the 0019-era one and opens with a
false rename question about `expense_categories` before it reaches whatever you changed.
**Do not add snapshot files** — one snapshot with none for its neighbours is exactly what produced
that prompt.

## Why drizzle-kit can never write `meta/_journal.json` here

`_journal.json`'s `when` is on a deliberate **one-day-per-index grid** from idx 60 (DEF-091: a
reserved index block must also reserve a `when` block, or two lanes collide on the shared dev
database). That keeps the journal head months in the future — 0140 is dated 2026-12-25.
drizzle-kit stamps a generated entry with the **wall clock**, which sorts *below* the head, and
drizzle's migrator applies only entries that sort above the last applied one — so a generated
migration is **silently skipped** (DEF-039). No drizzle-kit option changes that, and no snapshot
would either. `packages/db/tests/migration-journal.test.ts` enforces the grid.

## The checklist, short form (ADR-012 §5 has the reasons)

1. **Number** — next free idx after the journal head, or your lane's reserved block.
2. **File** — `NNNN_<task>_<what>.sql`; header comment names the task/DEF, spec §, and *why*.
   Statements separated by `--> statement-breakpoint`. 0140's header is the model.
3. **Transcribe from `schema/`** — the builder holds every rule Drizzle can express; the SQL
   repeats it. What Drizzle cannot express (expression indexes, EXCLUDE, array CHECKs, triggers,
   functions, views, RLS + policies) is hand-added **and the schema file gets a
   `// NOTE: … hand-added in migration NNNN` comment** beside it.
4. **RLS on every new table** — `ENABLE ROW LEVEL SECURITY` plus policies through
   `app_current_org()`, never raw `current_setting(...)` (DEF-077). Register the table in
   `src/rls/registry.ts` and classify it in `src/cutover/classification.ts`; the build refuses
   until both are done.
5. **Journal** — append `{ idx, version: "7", when, tag, breakpoints: true }` with
   `when = previous.when + 86_400_000 × (idx − previous.idx)`. Never the wall clock.
6. **Never edit an applied migration** (RULES §1 rule 9). 0000–0140 are applied on seven
   databases. A mistake gets a new migration.
7. **Prove it** — `npm run test` runs the journal guards; CI applies the whole folder to an empty
   `postgres:18` on every push. Locally, prove it on a *scratch* database, never a shared one.

## What is in this folder

| Path | What | Who reads it |
|---|---|---|
| `NNNN_*.sql` | The migrations, applied in journal order | `migrate.ts` (drizzle-orm's migrator), CI, the journal test (tag ↔ file, both directions) |
| `meta/_journal.json` | `idx` / `when` / `tag` per migration; `when` on the grid above | the migrator (gates on `when`), the journal test |
| `meta/*_snapshot.json` | drizzle-kit's historical baselines, ending at 0019 | nothing that runs here; keep as history, do not extend |
| this README | you | nobody else — the migrator reads only the journal and `<tag>.sql`, the journal test only `.sql` |
