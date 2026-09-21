/**
 * T-332 slice A — `docs/tasks/332-store-payday-settings-and-the-sixteen-day-check.md` §4.1.
 * Closes the `createStore` half of DEF-249: a brand-new store must come up WITH a live
 * `store_attendance_config` row, seeded in the same transaction that inserts the store.
 *
 * ⭐ **Case 1 and case 2 are deliberately separate `it()`s, not one.** `createStore`
 * (`packages/domain/src/stores/service.ts`) has exactly one production caller path that matters
 * here for two different doors: `/admin/stores`'s `createStoreAction` calls it directly (case 1),
 * and `bootstrapOrganization` — what BOTH `/setup` and `scripts/bootstrap-org.ts` call — calls the
 * same function (case 2). A fix landed in `scripts/bootstrap-org.ts` instead of in `createStore`
 * itself would make case 2 pass while case 1 stays red. Merging the two into one `it()` would blur
 * which door actually failed in the red output, so they stay apart on purpose.
 *
 * ⭐ **Every assertion reads the row back through a RAW SQL query, never through
 * `attendanceConfigRepo.findLive` or any other `@shareat/domain`/`@shareat/db` helper.** A read
 * through the same domain code the fix lives in can share the fix's own misunderstanding — that is
 * exactly DEF-109/111/115's shape, three defects that shipped green because one author wrote both
 * the fix and the test that judged it. The read here is independent of both packages.
 *
 * ⚠️ **`effective_from` — RULED for this slice.** It asserts Manila's business date, fetched via
 * raw SQL at test time (`(now() at time zone 'Asia/Manila')::date`), never a round-tripped JS
 * `Date`. A brand-new store has no already-worked day behind it, so "today" and "the store's
 * creation date" are the same value here — that divergence only matters for the backfill (§4 item
 * 2, out of this slice's scope), which closes on its own terms per `scheduler/index.ts:346` and
 * `sweep.ts:138` (no `effective_from` filter, `status = 'open'` only).
 *
 * ⚠️ **Case 3's limit, stated rather than left implicit.** It proves a second `seedAttendanceConfig`
 * call for an already-seeded store stays a no-op — the invariant `/settings/attendance` actually
 * depends on (exactly one live row). It does NOT prove `createStore`'s fix calls the idempotent
 * `seedAttendanceConfig` rather than `attendanceConfigRepo.insertConfig` directly: either
 * implementation already has one live row by the time case 3's second call runs, and
 * `seedAttendanceConfig` would find that row via `findLive` and return it either way. There is no
 * black-box way to tell those two implementations apart from outside, and slice A's contract does
 * not need to — the row count is what matters, not which function produced it.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createStore } from '../../src/stores/service';
import { bootstrapOrganization } from '../../src/organizations';
import { seedAttendanceConfig } from '../../src/attendance/config';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}
const sql = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

beforeEach(async () => {
  // ⛔ `organizations` included so `bootstrapOrganization`'s "first run happens once, ever" check
  // (organizations/index.ts:344) is genuinely true at the start of every test, not just the first.
  await sql`
    truncate table store_attendance_config, person_store_scope, person_grants, person_roles,
      person_credentials, stock_locations, location_types, sales_channels, stores, persons,
      fiscal_periods, expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function manilaToday(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select (now() at time zone 'Asia/Manila')::date::text as today`;
  return row!.today;
}

async function makeOrg(hint: string): Promise<string> {
  const code = uid(hint);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return org!.id;
}

async function makeAdmin(orgId: string): Promise<{ id: string; actor: Actor }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  return { id: p!.id, actor: { personId: p!.id, orgId } };
}

interface ConfigRow {
  id: string;
  payroll_period_type: string;
  semi_monthly_cutoff_day: number;
  payout_mode: string;
  payout_lag_days: number;
  payout_days: number[];
  effective_from: string;
  superseded_at: string | null;
  org_id: string;
  store_id: string;
  created_by: string | null;
}

/** The raw, independent read — see file header. */
async function configRowsFor(storeId: string): Promise<ConfigRow[]> {
  return sql<ConfigRow[]>`
    select id, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_lag_days,
           payout_days, effective_from::text, superseded_at, org_id, store_id, created_by
    from store_attendance_config where store_id = ${storeId}`;
}

function expectSeededLiteral(row: ConfigRow, expected: {
  today: string;
  orgId: string;
  storeId: string;
  createdBy: string;
}): void {
  expect(row.payroll_period_type).toBe('semi_monthly');
  expect(row.semi_monthly_cutoff_day).toBe(15);
  expect(row.payout_mode).toBe('lag');
  expect(row.payout_lag_days).toBe(0);
  expect(row.payout_days).toEqual([]);
  expect(row.effective_from).toBe(expected.today);
  expect(row.superseded_at).toBeNull();
  expect(row.org_id).toBe(expected.orgId);
  expect(row.store_id).toBe(expected.storeId);
  expect(row.created_by).toBe(expected.createdBy);
}

describe('T-332 slice A — a new store comes up with a pay-cycle row', () => {
  it('createStore seeds exactly one live config row, every field a literal', async () => {
    const today = await manilaToday();
    const orgId = await makeOrg('c1');
    const admin = await makeAdmin(orgId);

    const result = await withOrgPrincipal(orgId, (tx) =>
      createStore(tx, admin.actor, { code: uid('ST'), name: 'Branch' }),
    );

    const rows = await configRowsFor(result.storeId);
    expect(rows).toHaveLength(1);
    expectSeededLiteral(rows[0]!, { today, orgId, storeId: result.storeId, createdBy: admin.id });
  });

  it('⭐ THE DOOR TEST — bootstrapOrganization\'s first store also gets one', async () => {
    const today = await manilaToday();

    const result = await systemTransaction((tx) =>
      bootstrapOrganization(tx, {
        code: uid('BOOT'),
        name: 'Boot Org',
        adminDisplayName: 'Boot Admin',
        storeCode: uid('BST'),
        storeName: 'Boot Store',
        pin: '135790',
      }),
    );

    const rows = await configRowsFor(result.storeId);
    expect(rows).toHaveLength(1);
    expectSeededLiteral(rows[0]!, {
      today,
      orgId: result.orgId,
      storeId: result.storeId,
      createdBy: result.personId,
    });
  });

  it('a second seed attempt does not create a second live row', async () => {
    const today = await manilaToday();
    const orgId = await makeOrg('c3');
    const admin = await makeAdmin(orgId);

    const result = await withOrgPrincipal(orgId, (tx) =>
      createStore(tx, admin.actor, { code: uid('ST'), name: 'Branch' }),
    );

    const firstRows = await configRowsFor(result.storeId);
    expect(firstRows).toHaveLength(1);
    const firstId = firstRows[0]!.id;

    const second = await withOrgPrincipal(orgId, (tx) =>
      seedAttendanceConfig(tx, {
        orgId,
        storeId: result.storeId,
        effectiveFrom: today,
        createdBy: admin.id,
      }),
    );
    expect(second.id).toBe(firstId);

    const rows = await configRowsFor(result.storeId);
    expect(rows).toHaveLength(1);
  });
});
