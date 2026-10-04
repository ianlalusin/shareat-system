/**
 * T-354 / DEF-487 — legs T1-T4: the trigger registry itself (`packages/db/src/triggers/registry.ts`,
 * BUILDER item 3) against a live database.
 *
 * ⚠️ Orchestrator amendment M1 (binds): `triggers/registry.ts` does not exist until the BUILDER
 * lands it. A static `import` of it here would fail at COLLECTION time, which would hide every
 * other leg's red/green in this file. So T1-T4 live in THEIR OWN FILE (the M1 alternative to
 * `await import()` inside each leg), and every leg loads the registry itself with `await import()`
 * and asserts on the caught error when it is missing, rather than letting Vitest's collection
 * step swallow the whole file.
 *
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard (matches every sibling integration file).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** R1's 18 ALWAYS tables + 0175's ready-is-final guard (19), + 0179's direction-fixed guard (20), in the spec's table order (docs/tasks/354-…md, "ALWAYS (18)"). */
const ALWAYS_TRIGGERS = [
  { table: 'journal_entries', trigger: 'journal_entries_posted_immutable' },
  { table: 'journal_lines', trigger: 'journal_lines_posted_immutable' },
  { table: 'stock_movements', trigger: 'stock_movements_append_only_trg' },
  { table: 'stock_usage_records', trigger: 'stock_usage_posted_immutable_trg' },
  { table: 'stock_usage_records', trigger: 'stock_usage_void_terminal_trg' },
  { table: 'count_sessions', trigger: 'count_sessions_commit_once_trg' },
  { table: 'trade_discrepancies', trigger: 'trade_discrepancies_defer_once_trg' },
  { table: 'trade_discrepancies', trigger: 'trade_discrepancies_resolution_terminal_trg' },
  // T-372 S6 (migration 0179): the over/short direction is fixed when the receipt raises the row.
  { table: 'trade_discrepancies', trigger: 'trade_discrepancies_direction_fixed_trg' },
  { table: 'trade_order_messages', trigger: 'trade_order_messages_append_only_trg' },
  { table: 'store_attendance_config', trigger: 'store_attendance_config_immutable' },
  { table: 'attendance_punches', trigger: 'attendance_punches_append_only' },
  { table: 'attendance_days', trigger: 'attendance_days_frozen_immutable' },
  { table: 'attendance_adjustments', trigger: 'attendance_adjustments_append_only' },
  { table: 'etl_source_documents', trigger: 'etl_source_documents_immutable' },
  { table: 'fiscal_periods', trigger: 'fiscal_periods_fill_immutable_trg' },
  { table: 'missed_month_adjustments', trigger: 'missed_month_adjustments_no_update_trg' },
  { table: 'missed_month_adjustments', trigger: 'missed_month_adjustments_no_direct_delete_trg' },
  { table: 'audit_log', trigger: 'audit_log_append_only' },
  { table: 'trade_orders', trigger: 'trade_orders_ready_is_final_trg' }, // 0175 T-372 S2 DEF-511
  // T-375 S1 (migration 0183): the two history guards - a day feed and a POS correction are never edited or deleted.
  { table: 'pos_v1_day_feeds', trigger: 'pos_v1_day_feeds_append_only' },
  { table: 'sales_day_pos_corrections', trigger: 'sales_day_pos_corrections_append_only' },
] as const;

/** The six mirror enqueuers + the money-account seeder — must stay live `'O'` (T5, and R2's list). */
const MUST_STAY_ORIGIN = [
  'employments_mirror_enqueue',
  'employment_positions_mirror_enqueue',
  'persons_mirror_enqueue',
  'store_attendance_config_mirror_enqueue',
  'attendance_days_mirror_enqueue',
  'attendance_credentials_mirror_enqueue',
  'stores_seed_foundation_money_accounts',
];

async function loadRegistry(): Promise<
  { TRIGGER_REGISTRY: Record<string, { table: string; mode: 'always' | 'origin'; kind: string; reason: string }> } | undefined
> {
  try {
    // Relative import, resolved at runtime — the file does not exist until BUILDER lands it.
    // The specifier is built from a variable (not a string literal) so `tsc` does not try to
    // statically resolve a module that is not there yet and fail the whole file with TS2307.
    const registryPath = ['..', '..', 'src', 'triggers', 'registry'].join('/');
    return await import(registryPath);
  } catch {
    return undefined;
  }
}

async function livePgTriggers(): Promise<{ tgname: string; table: string; tgenabled: string }[]> {
  return sql<{ tgname: string; table: string; tgenabled: string }[]>`
    select t.tgname, c.relname as table, t.tgenabled::text as tgenabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public'
  `;
}

describe('T1 — registry floor', () => {
  it('TRIGGER_REGISTRY has >=57 entries, exactly 22 with mode:\'always\', and those 22 names equal R1\'s table — was red today: the import fails, triggers/registry.ts does not exist', async () => {
    const mod = await loadRegistry();
    expect(mod, 'triggers/registry.ts does not exist yet').toBeDefined();
    const reg = mod!.TRIGGER_REGISTRY;
    expect(Object.keys(reg).length, 'expected >=57 non-internal triggers classified').toBeGreaterThanOrEqual(57);

    const always = Object.entries(reg).filter(([, e]) => e.mode === 'always');
    expect(always.length, 'expected exactly 22 ALWAYS triggers (R1 + 0175 + 0179 + 0183)').toBe(22);

    const alwaysNames = new Set(always.map(([name]) => name));
    for (const { trigger } of ALWAYS_TRIGGERS) {
      expect(alwaysNames.has(trigger), `${trigger} should be classified 'always'`).toBe(true);
    }
  });
});

describe('T2 — completeness vs live DB', () => {
  it('every non-internal public pg_trigger row is a registry key with matching table, and every registry key exists live — was red today: the import fails', async () => {
    const mod = await loadRegistry();
    expect(mod, 'triggers/registry.ts does not exist yet').toBeDefined();
    const reg = mod!.TRIGGER_REGISTRY;
    const live = await livePgTriggers();

    const missing: string[] = [];
    for (const row of live) {
      const entry = reg[row.tgname];
      if (!entry) {
        missing.push(`${row.tgname} (live on ${row.table}) — not in the registry`);
        continue;
      }
      if (entry.table !== row.table) {
        missing.push(`${row.tgname} — registry says table ${entry.table}, live is on ${row.table}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);

    const liveNames = new Set(live.map((r) => r.tgname));
    const stale = Object.keys(reg).filter((name) => !liveNames.has(name));
    expect(stale, `stale registry entries with no live trigger: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('T3 — mode vs live DB', () => {
  it("for every entry, live tgenabled = 'A' when always and 'O' when origin — was red today: the import fails; once it imports, all 19 targets read 'O'", async () => {
    const mod = await loadRegistry();
    expect(mod, 'triggers/registry.ts does not exist yet').toBeDefined();
    const reg = mod!.TRIGGER_REGISTRY;
    const live = await livePgTriggers();
    const byName = new Map(live.map((r) => [r.tgname, r.tgenabled]));

    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(reg)) {
      const wanted = entry.mode === 'always' ? 'A' : 'O';
      const got = byName.get(name);
      if (got === undefined) {
        offenders.push(`${name} — in registry but not live`);
        continue;
      }
      if (got !== wanted) offenders.push(`${name} — wanted tgenabled='${wanted}' (${entry.mode}), got '${got}'`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('T4 — naming net', () => {
  it('every live trigger whose name matches the history-guard naming pattern is classified always — was red today: the import fails', async () => {
    const mod = await loadRegistry();
    expect(mod, 'triggers/registry.ts does not exist yet').toBeDefined();
    const reg = mod!.TRIGGER_REGISTRY;
    const live = await livePgTriggers();
    const net = /immutable|append_only|no_update|no_direct_delete|commit_once|terminal|defer_once/;

    const offenders: string[] = [];
    for (const row of live) {
      if (!net.test(row.tgname)) continue;
      const entry = reg[row.tgname];
      if (!entry || entry.mode !== 'always') {
        offenders.push(`${row.tgname} — matches the history-guard naming net but is not classified 'always'`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('T5 — over-flip guard (green today, guard against BUILDER over-classifying)', () => {
  it('the six *_mirror_enqueue triggers and stores_seed_foundation_money_accounts are live \'O\'', async () => {
    const live = await livePgTriggers();
    const byName = new Map(live.map((r) => [r.tgname, r.tgenabled]));
    for (const name of MUST_STAY_ORIGIN) {
      expect(byName.get(name), `${name} should still be live 'O' (present at all?)`).toBe('O');
    }
  });
});
