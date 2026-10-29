/**
 * T-454 S2 (TESTER) - T7: the closed-store guard sits in the CLI path (the apply library and readiness), not only in `extract`.
 * docs/tasks/454-drop-banay-banay.md section 4 S2 and section 6 T7.
 *
 * The database is replaced by a trap: `withOrgPrincipal` throws "DB TOUCHED" and the readiness `tx` is a proxy that throws on any
 * use. So a call that is refused BEFORE any database read or write rejects with the Banay-Banay sentence and never trips the trap.
 *
 * CONTRACT: every entry point that takes a store map calls assertClosedStoresExcluded(input.map) FIRST: applyMasterData (dry run
 * and --apply), applyItems, applySuppliers, applyCustomers, applyPositions, applyStaff, and readiness().
 * Note for the builder: today assertRunTarget sits INSIDE itemsBody/partiesBody, after `organizationsRepo.identityOf(tx)`, i.e. after
 * a database read (scripts/lib/master-data-apply.ts:117, :230). The guard must go at the top of each exported function instead.
 */
import { describe, expect, it, vi } from 'vitest';

const trap = vi.hoisted(() => ({ touched: 0 }));
vi.mock('@shareat/db', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withOrgPrincipal: async () => {
    trap.touched++;
    throw new Error('DB TOUCHED');
  },
}));

import { parseStoreMap } from '../src/master-data/store-map';
import * as apply from '../../../scripts/lib/master-data-apply';
import { readiness } from '../../../scripts/lib/master-data-readiness';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const B = 'iGOW7q2pZbeHWV832UNh';
const ORG = '00000000-0000-4000-8000-000000000001';
const MAP_CSV = [
  'v1_store_id,name,role,org_code,store_code',
  'b9DzsnPbr1BUnY88lyT4,SharEat Lipa,own,SE,LIPA',
  `${B},SharEat Banay-Banay,own,SE,BNBN`,
].join('\r\n');

const base = (doApply: boolean): Any => ({
  snapshot: { items: [], suppliers: [], arCustomers: [], staff: [], staffIdentities: [], stores: [] },
  snapshotSha: 'x',
  map: parseStoreMap(MAP_CSV),
  orgId: ORG,
  orgCode: 'SE',
  answers: {},
  actor: { personId: '00000000-0000-4000-8000-000000000002', orgId: ORG },
  apply: doApply,
});

const REFUSAL = /Banay-Banay[\s\S]*377/;

describe('T7. a map with Banay-Banay as own is refused before any database read or write', () => {
  // mutant killed: guard called from `extract` only, not from the apply path
  it.each([
    ['applyMasterData dry run', () => apply.applyMasterData(base(false))],
    ['applyMasterData --apply', () => apply.applyMasterData(base(true))],
    ['applyItems', () => apply.applyItems(base(true))],
    ['applySuppliers', () => apply.applySuppliers(base(true))],
    ['applyCustomers', () => apply.applyCustomers(base(true))],
    ['applyPositions', () => apply.applyPositions(base(true))],
    ['applyStaff', () => apply.applyStaff(base(true))],
  ])('%s', async (_name, call) => {
    const before = trap.touched;
    await expect(call()).rejects.toThrow(REFUSAL);
    expect(trap.touched).toBe(before);
  });

  it('readiness() refuses it before it reads the database', async () => {
    let used = 0;
    const tx: Any = new Proxy({}, {
      get: () => {
        used++;
        throw new Error('DB TOUCHED');
      },
    });
    await expect(
      readiness(tx, base(false).actor, { orgId: ORG, orgCode: 'SE', map: parseStoreMap(MAP_CSV) } as Any),
    ).rejects.toThrow(REFUSAL);
    expect(used).toBe(0);
  });
});
