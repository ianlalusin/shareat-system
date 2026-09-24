import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, systemTransaction, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { CANONICAL_POSITION_DEFAULTS, bootstrapOrganization } from '@shareat/domain';
import { gridDataForStore } from '../../src/app/admin/access-defaults/lib';

/**
 * T-336 — G1. The one UI assertion: the grid shows the ticks a fresh store was born with.
 * `docs/tasks/336-per-position-access-defaults.md` §8. A NEW file — other sessions are editing
 * `apps/**` (`docs/tasks/336-...md` §7's own instruction).
 *
 * ⛔ Run ONLY via `it.mjs` against the lane database — never `npm run test:integration`:
 *   node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_t335_tester \
 *     apps/erp/tests/integration/t336-access-defaults-grid-seeded.test.ts --repo C:\Users\ianla\webapps\shareat-system
 */
const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_grants, person_roles,
      position_capability_defaults, employment_positions, employments, positions,
      person_store_scope, stock_locations, location_types, sales_channels, stores, persons,
      fiscal_periods, expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const INPUT = {
  code: 'T336G',
  name: 'T336 Grid Co',
  adminDisplayName: 'T336 Grid Admin',
  storeCode: 'MAIN',
  storeName: 'Main Store',
  pin: '135790',
};

describe('G1 — gridDataForStore shows the ruled ticks for a freshly seeded store', () => {
  it('per position, activeDefaults set-equals the oracle; NEGATIVE: Server does not have record_sale', async () => {
    const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid('G1') }));
    const actor: Actor = { personId: boot.personId, orgId: boot.orgId };

    const grid = await withOrgPrincipal(boot.orgId, () => gridDataForStore(actor, boot.storeId));

    // Fixture sanity FIRST, and loud: if CANONICAL_POSITION_DEFAULTS is missing or empty, the loop
    // below would silently skip every position and pass vacuously — measured, that is exactly what
    // happened on the first draft of this test (module not yet built).
    const oracleKeys = Object.keys(CANONICAL_POSITION_DEFAULTS ?? {});
    expect(oracleKeys.length, 'CANONICAL_POSITION_DEFAULTS is missing or empty').toBeGreaterThan(0);
    const canonicalPositionsInGrid = grid.positions.filter((p) => p.isCanonical);
    expect(canonicalPositionsInGrid.length, 'no canonical positions in the grid').toBeGreaterThan(0);

    for (const position of canonicalPositionsInGrid) {
      const expected = (CANONICAL_POSITION_DEFAULTS as Record<string, readonly string[]>)[position.name];
      expect(expected, `${position.name} is canonical but has no oracle entry`).toBeDefined();
      const actual = [...(grid.activeDefaults.get(position.id) ?? [])].sort();
      expect(actual, `${position.name}: activeDefaults`).toEqual([...expected!].sort());
    }

    const [server] = grid.positions.filter((p) => p.name === 'Server');
    expect(server, 'fixture problem: no Server position in the grid').toBeTruthy();
    const serverCaps = grid.activeDefaults.get(server!.id) ?? new Set();
    expect(serverCaps.has('record_sale'), 'Server should NOT default record_sale').toBe(false);
  });
});
