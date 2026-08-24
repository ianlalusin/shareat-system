# T-119 — Data classification, enforced at build time, and the cutover purge

> **Status:** ✅ **COMPLETE 2026-08-24** — built by the planner after the implementing agent
> stalled twice without producing a file. Guard demonstrated failing on a deliberate probe.
> **Was:** spec ready. **Depends on:** ADR-007 (accepted), bible row 108.
> **Blocks:** nothing today — and that is exactly why it must be built **now**, not in December.
> **Written by:** Opus planner, 2026-08-24.

## Goal

Make every table declare whether it survives the 1 January 2027 cutover, **fail the build if one
does not**, and provide the purge that acts on those declarations.

## Why now, when the purge is four months away

Because the declaration is worthless if it is written after the tables are. Phase 2 will add a dozen
tables over the next two months, each by someone who has the context to classify it **at the moment
they create it** and will not have that context in December.

Build it now and the question gets asked twelve times, cheaply, by the person best placed to answer.
Build it in December and it gets asked once, by whoever is holding the purge script, about tables
they did not design.

---

## Contract

### 1. The registry — one file, three classes, no default

```ts
// packages/db/src/cutover/classification.ts
export type CutoverClass = 'keep' | 'purge' | 'keep_shell' | 'date_scoped';

export const CUTOVER_CLASSIFICATION: Record<string, CutoverEntry> = {
  organizations:  { class: 'keep',  reason: 'Configuration.' },
  journal_entries:{ class: 'purge', reason: 'The books. Replaced by the opening entry.' },
  fiscal_periods: { class: 'date_scoped', reason: '2026 pilot periods go; 2027 stays.',
                    dateColumn: 'starts_on', keepFrom: '2027-01-01' },
  // keep_shell entries name the columns to clear:
  // assets: { class: 'keep_shell', clearColumns: ['cost','accumulated_depreciation','book_value'] }
};
```

**Every entry carries a `reason` in prose.** A classification without a reason is unreviewable in
December, when the person reading it is not the person who wrote it.

**There is no default and no fallback branch.** An unlisted table is an error, never an assumption.

### 2. ⭐ The guard — a unit test, and it must FAIL for an unclassified table

`tests/unit/cutover-classification.test.ts`:

- Enumerate every table from the **Drizzle schema exports** — the schema is the source, so a table
  cannot exist without appearing here.
- Assert every table has exactly one classification.
- Assert every classification refers to a table that exists (a stale entry for a dropped table is
  also a defect).
- Assert every `keep_shell` entry names at least one `clearColumns` value, and that each named
  column exists on that table.
- Assert every `date_scoped` entry names a `dateColumn` that exists.

**A unit test on purpose, not an integration test.** It must fail on a laptop before a migration is
ever generated — the moment the schema changes, not the moment a database is available.

**Prove it fires.** Add a table (or a fake schema export) without classifying it, watch the test
fail, remove it. A guard that has only ever passed proves nothing — that rule has already caught
three real defects on this project.

### 3. The purge — `npm run cutover:purge`

```
npm run cutover:purge -- --confirm-database <name> [--dry-run]
```

| | |
|---|---|
| **`--dry-run` is the DEFAULT** | It reports what it would delete, per table, with row counts, and exits. Deleting requires an explicit flag |
| **`--confirm-database` must match** the connected database name | Typing the name is the ceremony. It is what stands between a rehearsal and an accident |
| **Refuses to run against production unless told twice** | If the URL is not local, require a second explicit flag |
| **One transaction** | Wholly or not at all. A half-purged database is unrecoverable without the backup |
| **FK-ordered** | Derive the order from the FK graph rather than hand-listing it; a hand-list rots exactly like the classification would |
| **Sequences reset** after the delete, so 2027 document numbers start at 1 |
| **Reports before/after counts per table**, and writes them to `docs/reviews/cutover-purge-<date>.md` |

### 4. Post-conditions, asserted inside the same transaction

The purge **rolls back** if any of these fail:

1. Every `purge` table has **zero** rows.
2. Every `keep` table's row count is **unchanged** from before.
3. Every `keep_shell` table's row count is unchanged, and every `clearColumns` column is `NULL`.
4. Every `date_scoped` table retains only rows at or after `keepFrom`.
5. `journal_entries` and `journal_lines` are empty, so **the trial balance ties at zero**.
6. The chart of accounts is **byte-identical** to before — same ids, same codes. *The opening entry
   will reference these ids; a re-seed that changed one would be catastrophic and silent.*

**Assert, do not eyeball.** The whole point is that this runs once, on a day when everyone is busy.

### 5. What it must NOT do

- **Never `DROP` or `TRUNCATE ... CASCADE` blindly.** `CASCADE` follows FKs into tables the operator
  did not name, which is precisely the accident this design exists to prevent.
- **Never touch the ETL tables on 1 January** — ADR-007 §6 keeps them until the opening balance is
  signed off. They carry a `purge` class with an explicit `notBefore: '2027-01-31'`, and the script
  refuses them before that date.
- **Never run without a verified backup.** The script asks; if the answer is anything but an
  explicit confirmation, it stops.

---

## Invariants the tests must prove

**Classification guard — unit, no database**
1. Every schema table is classified.
2. An unclassified table **fails the test** (proven with a deliberate probe, then reverted).
3. A classification naming a non-existent table fails.
4. A `keep_shell` entry with a non-existent column fails.
5. A `date_scoped` entry with a non-existent date column fails.
6. Every entry has a non-empty `reason`.

**Purge — integration, real Postgres**
7. Dry-run is the default: it deletes nothing and reports counts.
8. A mismatched `--confirm-database` refuses and deletes nothing.
9. After a real purge, every `purge` table is empty.
10. Every `keep` table's row count is unchanged.
11. A `keep_shell` row survives with its named columns `NULL` and its other columns intact.
12. A `date_scoped` table keeps only rows at or after `keepFrom`.
13. **The chart of accounts is unchanged, ids included.**
14. A failing post-condition **rolls the whole thing back** — seeded deliberately, and the database
    is verified untouched afterwards.
15. The ETL tables are **refused** before their `notBefore` date.
16. Sequences restart at 1.

## Out of scope

The actual cutover · the opening-balance entry · classifying Phase 2–5 tables that do not exist yet
(each task spec does its own) · any UI · backup tooling itself.

## Done when

- [ ] All 16 invariants pass; 1–6 with **no database**.
- [ ] Invariant 2 **demonstrated failing** with a deliberate probe, then reverted — reported.
- [ ] `npm run typecheck` clean · `test` · `test:integration` green (every existing test still
      passes) · `build` succeeds.
- [ ] `docs/decisions/ADR-007-pilot-then-purge.md` §3's table matches the registry exactly — or the
      difference is reported as a spec defect.
- [ ] Any spec defect **reported, not silently worked around**.

> **The measure of success is a build failure.** If someone adds a table next month and CI does not
> stop them, this task did not work — however green its own tests are.
