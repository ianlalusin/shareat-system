/**
 * ⭐ T-371 C2 — the writer's input type: a `$inferInsert` / `$inferInsert`-partial in which EVERY `numeric` column is a
 * branded `Decimal` and nothing else may stand in for it.
 *
 * `docs/tasks/371-nan-sweep.md` §C2. A constrained numeric column can only be written a value that went through
 * `decimal()` in `@shareat/core/money` (the one mint), so an unparsed string cannot reach a writer under ANY spelling —
 * `str`, `strs`, `amount`, a template literal, `fd.get`, `...input`, `JSON.parse`, a jsonb payload. The compiler finds the
 * callers; there is no list of spellings to go stale.
 *
 * ⚠️ This type says "branded", not WHICH brand: Drizzle's type-level column carries no precision or scale. The SHAPE (a
 * `Decimal<'14,4'>` into a `(14,2)` column would be silently rounded — DEF-272's class) is checked by the guard test
 * (G1), which compares each argument property's `__decimal` literal with the column's `getTableConfig` precision and scale.
 *
 * A bulk write is the same: `.values(rows)` takes `SafeInsert<T>[]`. `null` and `undefined` keep whatever the column
 * allows (nullable, defaulted); only the string case is narrowed.
 */
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Decimal } from '@shareat/core/money';

type NumericPgColumn = { _: { columnType: 'PgNumeric' } };

/** The value type of one column: a `numeric` column's string is narrowed to `Decimal`, everything else is untouched. */
type Narrowed<Column, Value> = [Column] extends [NumericPgColumn]
  ? Value extends string
    ? Decimal
    : Value
  : Value;

type Columns<T extends PgTable> = T['_']['columns'];

/** `T['$inferInsert']` with every `numeric` column a `Decimal`. Optionality and nullability are preserved. */
export type SafeInsert<T extends PgTable> = {
  [K in keyof T['$inferInsert']]: K extends keyof Columns<T>
    ? Narrowed<Columns<T>[K], T['$inferInsert'][K]>
    : T['$inferInsert'][K];
};

/** What an update may set: any subset of the columns, with the same narrowing. */
export type SafeUpdate<T extends PgTable> = Partial<SafeInsert<T>>;
