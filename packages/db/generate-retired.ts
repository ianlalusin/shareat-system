/**
 * `npm run db:generate` is RETIRED here — on purpose, with the evidence written down.
 *
 *   docs/decisions/ADR-012-hand-authored-migrations.md  ·  docs/DEFECTS-REGISTER.md DEF-242
 *
 * Migrations in this repository are hand-authored from `schema/`. This script exists so the
 * command people reach for first says so, instead of opening a false rename prompt about a
 * table nobody touched — DEF-073, DEF-121 and DEF-242 are the same discovery made three times,
 * because nothing in the tree told the next person.
 *
 * It writes nothing and exits 1. `drizzle-kit` stays installed for `npm run db:studio`.
 * Guarded by packages/db/tests/db-generate-retired.test.ts.
 */
const ADR = 'docs/decisions/ADR-012-hand-authored-migrations.md';

const message = `
⛔  npm run db:generate is RETIRED in shareat-system — migrations are HAND-AUTHORED.
    ${ADR}  ·  DEF-242

    Why drizzle-kit generate cannot be used here (measured 2026-09-10, not assumed):

    1. Its snapshot chain ended at 0019 on 2026-08-26. The 104 migrations since have no
       snapshot, so it diffs today's schema against that baseline and asks a FALSE rename
       question (expense_categories.is_system vs sub_category) before it ever reaches the
       table you changed. With no terminal to answer, it exits 0 having written nothing.

    2. It stamps the journal entry with the wall clock. This journal is on a one-day-per-index
       grid (DEF-091) whose head is months in the future, so a generated entry sorts BELOW the
       head and drizzle's migrator SILENTLY SKIPS it (DEF-039). No drizzle-kit option changes
       this, and a regenerated snapshot would not either.

    3. Every table here also needs what it cannot emit: RLS + policies (122 today), expression
       unique indexes, EXCLUDE constraints, triggers (45). Hand-augmentation was always required.

    How to write the migration by hand — the checklist is ${ADR} §5:
      next free number → header comment (task/DEF, why) → transcribe from schema/ →
      hand-add what Drizzle cannot express and leave a NOTE in the schema file →
      RLS + policies → journal entry with when = previous when + 86 400 000 × (idx step) →
      npm run test (the journal guards) → it applies from zero in CI on every run.
`;

console.error(message);
process.exit(1);
