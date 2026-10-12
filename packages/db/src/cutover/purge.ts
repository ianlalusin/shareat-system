/**
 * The cutover purge engine — T-347 (DEF-437), `docs/tasks/347-def-437-cutover-purge-assets.md` §3.1.
 *
 * ⛔ **Moved out of `scripts/cutover-purge.ts` so the test suite runs the SAME code the operator
 * runs**, against a scratch database, rather than a shell of it. `scripts/cutover-purge.ts` is now
 * argument parsing, ceremony (the confirm-database / not-local checks) and the report only.
 *
 * ## Why a shell row cannot be cleared column by column (DEF-437's root cause)
 *
 * Every `keep_shell` CHECK constraint spans MULTIPLE columns (`fixed_assets_valuation_shape_check`,
 * `..._disposal_pair_check`, the `*_reconciled_shape_check` triplets, `prepaid_items`'s own NOT
 * NULLs). Nulling one column at a time — the old script's own loop — leaves the row in an
 * intermediate, half-cleared shape that no CHECK accepts, the instant the SECOND column is nulled.
 * `applyPurge`'s shell step (§3.3 step 4) writes every `clearColumns` NULL and every `set` value in
 * ONE UPDATE per table, so the row moves directly from "fully populated" to "the shell state its
 * own CHECKs accept" with no intermediate state ever committed or even attempted.
 *
 * ## Why the purge set cannot simply be TRUNCATEd (Amendment R1.1)
 *
 * A kept-shell column can reference a purge-class table (`fixed_assets.source_expense_id` →
 * `expenses`, `0019:63`, `ON DELETE restrict`). Postgres refuses to TRUNCATE a table referenced by
 * an untruncated table's FK (`0A000`) — CASCADE would "fix" this by truncating `fixed_assets` too,
 * which is exactly the accident `scripts/cutover-purge.ts`'s own header forbids. `planPurge` finds
 * every such FK from `pg_constraint` (never a hand-list — a hand-list rots the same way the
 * classification itself is designed not to); `applyPurge` drops each one, truncates, clears the
 * column in the SAME shell UPDATE that clears everything else, then re-adds the constraint
 * VALIDATED — so the schema is identical before and after, and a plan `applyPurge` cannot satisfy
 * (an FK into a purge table from a column not in that table's `clearColumns`) is refused before any
 * write (N5).
 *
 * ## Why the shell step must run strictly after the ledger is truncated (Amendment R2.6)
 *
 * `fixed_assets`'s shell UPDATE moves `in_service_on` non-NULL → NULL, firing T-346's
 * `fixed_assets_in_service_b_guard_trg` (`0163`, `WHEN OLD.in_service_on IS DISTINCT FROM
 * NEW.in_service_on`). With `NEW.in_service_on` NULL, ANY posted depreciation entry for the asset
 * raises `... already has depreciation posted ...` — the guard's own loop finds nothing to object to
 * only because `journal_entries` is already empty by the time the shell UPDATE runs. Step order
 * (TRUNCATE before the shell step) is load-bearing, not incidental.
 *
 * ## Why the `fixed_assets` shell UPDATE must name `status` in the SAME statement (Amendment R2.5)
 *
 * The UPDATE names `acquired_on`, `in_service_source` and `status` together, firing
 * `fixed_assets_in_service_a_fill_upd_trg` (`0163`, `UPDATE OF acquired_on, store_id,
 * in_service_source, status`). Only because `status = 'pending_valuation'` is IN that same
 * statement does the fill trigger take its shell branch (`0163:79-83`, forcing both in-service
 * columns NULL unconditionally) rather than re-deriving a non-NULL source from the now-NULL
 * `acquired_on`. A `set` split across two statements would have the first one fail the shape CHECK
 * before `status` ever changes — this is the other reason every shell table's clear is ONE
 * statement, not only `fixed_assets`'s.
 */
import postgres from 'postgres';
import { refuse } from '../refusal';
import {
  CUTOVER_CLASSIFICATION,
  tablesInClass,
  type CutoverEntry,
  type KeepShellEntry,
} from './classification';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** The capability `Sql` and `Tx` share (tagged-template queries, `.unsafe()`) — `planPurge` and the
 *  read-only helpers below accept either; only `applyPurge` needs a real transaction. */
type Executor = postgres.ISql;

/**
 * ⛔ **Never restart this one.** `mirror_version_seq` (`0088:22`) is the monotonic version the
 * Firestore publisher compares against the edge's own `srcVersion` — restarting it at 1 would make
 * every mirror write after the cutover look OLDER than what the edge already holds, and the edge
 * freezes rather than accepting anything new. Named here, once, so no future sequence addition can
 * be reset by accident.
 */
export const SEQUENCES_NEVER_RESET: ReadonlySet<string> = new Set(['mirror_version_seq']);

export interface ForeignKeyToPurge {
  readonly constraintName: string;
  readonly childTable: string;
  /** Amendment R4.3 — every column of the constraint, one row per FK (never one row per column):
   *  a composite FK would otherwise appear once per column and get dropped twice. */
  readonly childColumns: readonly string[];
  readonly parentTable: string;
  /** `pg_get_constraintdef(oid)` — captured so step 5 re-adds the EXACT same constraint. */
  readonly definition: string;
}

export interface ShellPlan {
  readonly table: string;
  readonly entry: KeepShellEntry;
  readonly rowsNow: number;
  /** Rows `dropWhere` would delete outright, if the entry has one — 0 otherwise. */
  readonly droppedCount: number;
}

export interface DateScopedPlan {
  readonly table: string;
  readonly entry: Extract<CutoverEntry, { class: 'date_scoped' }>;
  readonly rowsNow: number;
}

export interface PurgePlan {
  readonly asOf: string;
  /** Purge-class tables due this run (past `notBefore`), children before parents. */
  readonly purgeOrder: readonly string[];
  readonly purgeRowsNow: ReadonlyMap<string, number>;
  readonly keepTables: readonly string[];
  /** Captured now, read-only, so `applyPurge` can prove keep tables end byte-identical without a
   *  second, separately-timed read racing whatever else touches the database. */
  readonly keepTableHashesBefore: ReadonlyMap<string, string>;
  readonly shellPlans: readonly ShellPlan[];
  readonly datePlans: readonly DateScopedPlan[];
  /** Every FK whose child is NOT truncated and whose parent IS — derived from `pg_constraint`,
   *  never hand-listed (Amendment R1.1). */
  readonly foreignKeys: readonly ForeignKeyToPurge[];
  /** Amendment R4.2 — an ALLOWLIST, fail closed: only sequences `pg_depend` shows are OWNED BY a
   *  column of a table in `purgeOrder`. A free-standing sequence (`mirror_version_seq` among them —
   *  it owns no table at all) or one owned by a KEPT table is never restarted, with no denylist to
   *  keep in sync as tables are added. */
  readonly sequencesToReset: readonly string[];
  /** Amendment R4.1 — `SEQUENCES_NEVER_RESET`'s own before-state, so `applyPurge` can prove each one
   *  is byte-identical after (Invariant 7), not merely "the loop above skipped it by name". */
  readonly neverResetSequenceState: ReadonlyMap<string, { lastValue: string; isCalled: boolean }>;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function countRows(sql: Executor, table: string): Promise<number> {
  const [row] = await sql.unsafe<{ c: number }[]>(`select count(*)::int as c from ${quoteIdent(table)}`);
  return row?.c ?? 0;
}

async function countRowsWhereIn(sql: Executor, table: string, column: string, values: readonly string[]): Promise<number> {
  const [row] = await sql.unsafe<{ c: number }[]>(
    `select count(*)::int as c from ${quoteIdent(table)} where ${quoteIdent(column)} = any($1)`,
    [values],
  );
  return row?.c ?? 0;
}

/** ⚠️ `pg_sequences` has NO `is_called` column (verified against live Postgres 18 — its columns
 *  are schemaname/sequencename/sequenceowner/data_type/start_value/min_value/max_value/
 *  increment_by/cycle/cache_size/last_value only). `is_called` lives on the sequence's OWN implicit
 *  relation, read the same way `nextval`/`currval` do — a plain SELECT against it. */
async function sequenceState(sql: Executor, seq: string): Promise<{ lastValue: string; isCalled: boolean }> {
  const [row] = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
    `select last_value::text as last_value, is_called from ${quoteIdent(seq)}`,
  );
  return { lastValue: row!.last_value, isCalled: row!.is_called };
}

async function tableMd5(sql: Executor, table: string): Promise<string> {
  const [row] = await sql.unsafe<{ h: string }[]>(
    `select md5(coalesce(string_agg(t::text, '' order by t::text), '')) as h from ${quoteIdent(table)} t`,
  );
  return row!.h;
}

/** Topologically order the purge set so children are TRUNCATEd before parents in the report — a
 *  single multi-table TRUNCATE satisfies FKs within the set regardless of listed order, but the
 *  dry-run report reads better children-first, and a genuine cycle is worth refusing loudly rather
 *  than guessing. */
async function derivePurgeOrder(sql: Executor, tables: readonly string[]): Promise<string[]> {
  const set = new Set(tables);
  const edges = await sql<{ child: string; parent: string }[]>`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c
    where c.contype = 'f'
  `;
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const e of edges) {
    if (set.has(e.child) && set.has(e.parent) && e.child !== e.parent) {
      deps.get(e.parent)!.add(e.child);
    }
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, trail: Set<string>): void => {
    if (seen.has(t)) return;
    if (trail.has(t)) {
      throw new Error(`Foreign-key cycle involving ${t}; purge order cannot be derived automatically.`);
    }
    trail.add(t);
    for (const child of deps.get(t) ?? []) visit(child, trail);
    trail.delete(t);
    seen.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return ordered;
}

/**
 * Read-only: order, counts, the shell/date-scoped tables' current shape, and every kept-child →
 * purged-parent FK, each with its captured definition. Never writes. `sql` may be a plain
 * connection or an open transaction — this only ever selects.
 */
export async function planPurge(sql: Executor, asOf: string): Promise<PurgePlan> {
  const purgeOrder = await derivePurgeOrder(
    sql,
    tablesInClass('purge').filter((t) => {
      const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string }).notBefore;
      return !nb || asOf >= nb;
    }),
  );
  const keepTables = tablesInClass('keep');
  const shellTables = tablesInClass('keep_shell');
  const dateTables = tablesInClass('date_scoped');

  const purgeRowsNow = new Map<string, number>();
  for (const t of purgeOrder) purgeRowsNow.set(t, await countRows(sql, t));

  const keepTableHashesBefore = new Map<string, string>();
  for (const t of keepTables) keepTableHashesBefore.set(t, await tableMd5(sql, t));

  const shellPlans: ShellPlan[] = [];
  for (const t of shellTables) {
    const entry = CUTOVER_CLASSIFICATION[t] as KeepShellEntry;
    const rowsNow = await countRows(sql, t);
    const droppedCount = entry.dropWhere
      ? await countRowsWhereIn(sql, t, entry.dropWhere.column, entry.dropWhere.in)
      : 0;
    shellPlans.push({ table: t, entry, rowsNow, droppedCount });
  }

  const datePlans: DateScopedPlan[] = [];
  for (const t of dateTables) {
    const entry = CUTOVER_CLASSIFICATION[t] as Extract<CutoverEntry, { class: 'date_scoped' }>;
    datePlans.push({ table: t, entry, rowsNow: await countRows(sql, t) });
  }

  // Amendment R1.1 — every FK whose PARENT is due to be truncated this run and whose CHILD is not,
  // derived from pg_constraint. `notBefore`-deferred purge tables are correctly excluded (their
  // parent is not being emptied yet, so nothing needs to be cleared or dropped for them today).
  // Amendment R4.3 — grouped by `c.oid` (one row per CONSTRAINT, columns aggregated), so a
  // composite FK is never listed — and so never dropped — twice.
  const purgeSet = new Set(purgeOrder);
  const rawFks = await sql<
    { constraint_name: string; child_table: string; child_columns: string[]; parent_table: string; definition: string }[]
  >`
    select
      c.conname as constraint_name,
      c.conrelid::regclass::text as child_table,
      array_agg(a.attname order by ck.ord) as child_columns,
      c.confrelid::regclass::text as parent_table,
      pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as ck(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = ck.attnum
    where c.contype = 'f'
    group by c.oid, c.conname, c.conrelid, c.confrelid
  `;
  const foreignKeys: ForeignKeyToPurge[] = rawFks
    .filter((r) => purgeSet.has(r.parent_table) && !purgeSet.has(r.child_table))
    .map((r) => ({
      constraintName: r.constraint_name,
      childTable: r.child_table,
      childColumns: r.child_columns,
      parentTable: r.parent_table,
      definition: r.definition,
    }));

  // Amendment R4.2 — the ALLOWLIST: sequences pg_depend shows are owned by a column of a table
  // due to be truncated this run. Fail closed — a sequence with no owning table (mirror_version_seq
  // among them) or owned by a KEPT table never appears here, with nothing to keep in sync as tables
  // are added (unlike a denylist, which rots the moment a new sequence is created and forgotten).
  const seqOwnership = await sql<{ seq: string; owner: string }[]>`
    select s.relname as seq, t.relname as owner
    from pg_class s
    join pg_depend d on d.objid = s.oid and d.deptype = 'a'
    join pg_class t on t.oid = d.refobjid
    where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace
  `;
  const sequencesToReset = seqOwnership
    .filter((r) => purgeSet.has(r.owner) && !SEQUENCES_NEVER_RESET.has(r.seq))
    .map((r) => r.seq);

  // Amendment R4.1 — `SEQUENCES_NEVER_RESET`'s own before-state, captured now so the post-condition
  // can prove each one byte-identical after, not merely assert the reset loop skipped it by name.
  const neverResetSequenceState = new Map<string, { lastValue: string; isCalled: boolean }>();
  if (SEQUENCES_NEVER_RESET.size > 0) {
    const existing = await sql<{ seq: string }[]>`
      select sequencename as seq from pg_sequences
      where schemaname = 'public' and sequencename = any(${[...SEQUENCES_NEVER_RESET]})`;
    for (const r of existing) neverResetSequenceState.set(r.seq, await sequenceState(sql, r.seq));
  }

  return {
    asOf,
    purgeOrder,
    purgeRowsNow,
    keepTables,
    keepTableHashesBefore,
    shellPlans,
    datePlans,
    foreignKeys,
    sequencesToReset,
    neverResetSequenceState,
  };
}

export interface ApplyPurgeOptions {
  /** ⚠️ TEST ONLY. Skips the RLS-bypass preflight (§3.4) so a test can reach and prove the
   *  `set local row_security = off` backstop's OWN failure mode (Amendment R1.4) instead of always
   *  stopping one layer earlier at the preflight. Never set outside a test. */
  skipPreflightForTest?: boolean;
  /**
   * T-390 R8 / DEF-640: the person who performed the purge, PER ORGANIZATION (orgId -> personId). The purge records step C2 as
   * `performed` once per organization, each by its OWN org's person (migration 0194's same-org FK refuses any other), inside its own
   * transaction (so a rehearsal's rollback takes the row with it). An apply refuses, before any write, if an organization has no
   * entry here or if an entry is not a person of that organization.
   */
  performedBy: Readonly<Record<string, string>>;
  /** A rehearsal rolls back, so an organization with no performer is skipped (no C2 row) instead of refused. */
  rehearsal?: boolean;
}

/**
 * The transaction body (§3.3). Order is load-bearing — see this file's header for the two reasons
 * TRUNCATE must precede the shell step, and the one reason the `fixed_assets` shell UPDATE must
 * name `status` in the same statement as everything else.
 */
export async function applyPurge(tx: Tx, plan: PurgePlan, opts: ApplyPurgeOptions): Promise<void> {
  // Step 0 — RLS preflight (§3.4), then the row_security=off backstop (§3.3 step 0). Two separate
  // defences: the preflight gives a legible refusal; row_security=off is what makes a role that
  // somehow reaches this point anyway FAIL LOUDLY instead of silently matching zero rows (G).
  if (!opts.skipPreflightForTest) {
    const [role] = await tx<{ user: string; ok: boolean }[]>`
      select current_user as user, coalesce((rolsuper or rolbypassrls), false) as ok
      from pg_roles where rolname = current_user`;
    if (!role?.ok) {
      throw refuse(
        `cutover purge: role ${role?.user ?? 'current_user'} is subject to row-level security`,
        `REFUSED. ${role?.user ?? 'this role'} is subject to row-level security; the purge would ` +
          'clear nothing and report success.',
      );
    }
  }
  await tx.unsafe('set local row_security = off');

  // Step 0b (DEF-640) — one performer per organization, validated BEFORE any write. A person must belong to the org it performs for.
  const orgIds = (await tx<{ id: string }[]>`select id from organizations order by id`).map((r) => r.id);
  const suppliedIds = [...new Set(Object.values(opts.performedBy))];
  const personOrg = new Map<string, string>();
  if (suppliedIds.length > 0) {
    for (const r of await tx<{ id: string; org_id: string }[]>`
      select id, org_id from persons where id::text = any(${suppliedIds}::text[])`) {
      personOrg.set(r.id, r.org_id);
    }
  }
  const performerProblems: string[] = [];
  const noPerformer: string[] = [];
  const c2Orgs: string[] = [];
  for (const orgId of orgIds) {
    const pid = opts.performedBy[orgId];
    if (!pid) {
      if (!opts.rehearsal) noPerformer.push(orgId);
      continue;
    }
    const owner = personOrg.get(pid);
    if (!owner) performerProblems.push(`person ${pid} (for organization ${orgId}) does not exist`);
    else if (owner !== orgId) performerProblems.push(`person ${pid} belongs to organization ${owner}, not ${orgId}`);
    else c2Orgs.push(orgId);
  }
  for (const orgId of Object.keys(opts.performedBy)) {
    if (!orgIds.includes(orgId)) performerProblems.push(`performer given for unknown organization ${orgId}`);
  }
  if (noPerformer.length > 0 || performerProblems.length > 0) {
    const msg =
      (noPerformer.length > 0 ? `no performer for organization(s): ${noPerformer.join(', ')}. ` : '') +
      performerProblems.join('; ');
    throw refuse(`cutover purge: C2 performer refused - ${msg}`, `REFUSED. Nothing was changed. Step C2 needs one performer per organization: ${msg}`);
  }

  // Step 1 — every kept-child → purged-parent FK must already be cleared, or refuse before writing.
  // Every column of the constraint must be cleared (almost always exactly one, in this schema).
  for (const fk of plan.foreignKeys) {
    const entry = CUTOVER_CLASSIFICATION[fk.childTable] as CutoverEntry | undefined;
    const clearColumns = entry?.class === 'keep_shell' ? entry.clearColumns : [];
    const columnLabel = fk.childColumns.join(', ');
    if (!fk.childColumns.every((c) => clearColumns.includes(c))) {
      throw refuse(
        `cutover purge: ${fk.childTable}.${columnLabel} -> ${fk.parentTable} not in clearColumns`,
        `REFUSED. ${fk.childTable}.${columnLabel} references purged ${fk.parentTable} and is not cleared; classify it`,
      );
    }
  }

  // Step 2 — drop each such FK.
  for (const fk of plan.foreignKeys) {
    await tx.unsafe(`alter table ${quoteIdent(fk.childTable)} drop constraint ${quoteIdent(fk.constraintName)}`);
  }

  // Step 3 — TRUNCATE the purge set (one statement, never CASCADE — DEF-079's own reasoning: FK
  // order does not matter within a single multi-table TRUNCATE), then the date-scoped deletes.
  if (plan.purgeOrder.length > 0) {
    await tx.unsafe(`truncate table ${plan.purgeOrder.map(quoteIdent).join(', ')}`);
  }
  for (const p of plan.datePlans) {
    await tx.unsafe(`delete from ${quoteIdent(p.table)} where ${quoteIdent(p.entry.dateColumn)} < $1`, [
      p.entry.keepFrom,
    ]);
  }

  // Step 4 — the shell step, per table: drop rows that no longer exist, then ONE combined UPDATE
  // clearing every column and writing every `set` value together (this file's header, both reasons).
  for (const p of plan.shellPlans) {
    if (p.entry.dropWhere) {
      await tx.unsafe(`delete from ${quoteIdent(p.table)} where ${quoteIdent(p.entry.dropWhere.column)} = any($1)`, [
        p.entry.dropWhere.in,
      ]);
    }
    const setEntries = Object.entries(p.entry.set ?? {});
    const assignments = [
      ...p.entry.clearColumns.map((c) => `${quoteIdent(c)} = null`),
      ...setEntries.map(([k], i) => `${quoteIdent(k)} = $${i + 1}`),
    ];
    if (assignments.length > 0) {
      await tx.unsafe(
        `update ${quoteIdent(p.table)} set ${assignments.join(', ')}`,
        setEntries.map(([, v]) => v),
      );
    }
  }

  // Step 5 — re-add each FK from its captured definition, validated (never NOT VALID). DDL is
  // transactional, so a failure anywhere above already restored the constraint by rolling back.
  for (const fk of plan.foreignKeys) {
    await tx.unsafe(
      `alter table ${quoteIdent(fk.childTable)} add constraint ${quoteIdent(fk.constraintName)} ${fk.definition}`,
    );
  }

  // Step 6 — sequences restart here, inside the transaction, as the last write (Amendment R1.2),
  // ALLOWLIST-only: exactly the sequences `planPurge` found owned by a table in `purgeOrder`
  // (Amendment R4.2) — never "every sequence except the named exclusion".
  for (const seq of plan.sequencesToReset) {
    await tx.unsafe(`alter sequence ${quoteIdent(seq)} restart with 1`);
  }

  // ---- post-conditions, inside the transaction — a violation rolls everything back -----------
  const problems: string[] = [];

  for (const t of plan.purgeOrder) {
    const c = await countRows(tx, t);
    if (c !== 0) problems.push(`${t} still has ${c} row(s) after TRUNCATE`);
  }

  for (const p of plan.shellPlans) {
    const after = await countRows(tx, p.table);
    if (after !== p.rowsNow - p.droppedCount) {
      problems.push(`${p.table}: expected ${p.rowsNow - p.droppedCount} row(s) after, found ${after}`);
    }
    const nonNullClear = p.entry.clearColumns
      .map((c) => `${quoteIdent(c)} is not null`)
      .join(' or ');
    if (nonNullClear) {
      const [row] = await tx.unsafe<{ c: number }[]>(
        `select count(*)::int as c from ${quoteIdent(p.table)} where ${nonNullClear}`,
      );
      if ((row?.c ?? 0) !== 0) problems.push(`${p.table}: ${row!.c} row(s) still have a clearColumns value set`);
    }
    for (const [col, value] of Object.entries(p.entry.set ?? {})) {
      const [row] = await tx.unsafe<{ c: number }[]>(
        `select count(*)::int as c from ${quoteIdent(p.table)} where ${quoteIdent(col)} is distinct from $1`,
        [value],
      );
      if ((row?.c ?? 0) !== 0) problems.push(`${p.table}.${col}: ${row!.c} row(s) do not match the shell value`);
    }
  }

  for (const fk of plan.foreignKeys) {
    const [row] = await tx<{ convalidated: boolean }[]>`
      select convalidated from pg_constraint where conname = ${fk.constraintName}`;
    if (!row?.convalidated) problems.push(`${fk.constraintName} was not re-added validated`);
  }

  for (const [t, before] of plan.keepTableHashesBefore) {
    const after = await tableMd5(tx, t);
    if (after !== before) problems.push(`${t} changed — a KEEP table must be byte-identical`);
  }

  // Amendment R4.1 (Invariant 7) — proves each never-reset sequence (mirror_version_seq) is
  // byte-identical, `is_called` included, not merely "the reset loop above skipped it by name".
  for (const [seq, before] of plan.neverResetSequenceState) {
    const after = await sequenceState(tx, seq);
    if (after.lastValue !== before.lastValue || after.isCalled !== before.isCalled) {
      problems.push(`${seq} changed — it must never be reset`);
    }
  }

  if (problems.length > 0) {
    throw new Error('POST-CONDITION FAILED — rolling back, the database is unchanged:\n  ' + problems.join('\n  '));
  }

  // T-390 R8: record C2 as PERFORMED, one row per organization, AFTER the post-conditions (cutover_steps is KEEP, so writing it
  // earlier would fail the byte-identical check). A re-run replaces the row (same unique key as `recordStep`). It rolls back with a
  // rehearsal, because it lives in this transaction.
  let purgedRows = 0;
  for (const n of plan.purgeRowsNow.values()) purgedRows += n;
  const tables = plan.purgeOrder.length;
  const note = `Purged ${purgedRows} row${purgedRows === 1 ? '' : 's'} from ${tables} table${tables === 1 ? '' : 's'} as of ${plan.asOf}`;
  for (const orgId of c2Orgs) {
    await tx`
      insert into cutover_steps (org_id, store_id, step_code, completion, note, completed_by)
      values (${orgId}, null, 'C2', 'performed', ${note}, ${opts.performedBy[orgId]!})
      on conflict (org_id, step_code, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set completion = excluded.completion, note = excluded.note,
                    completed_by = excluded.completed_by, completed_at = now()`;
  }
}
