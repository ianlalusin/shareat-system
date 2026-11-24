/**
 * T-634 - central charges, unit level (no database): the database and the capability check are replaced by spies, so the ORDER of decisions is visible
 * (authorize first, with the right capability and scope; nothing read or written after a refusal), and the retire / bump / switch rules are checked.
 * The DB-backed versions: integration/t634-central-charges.test.ts and packages/db/tests/integration/t634-charge-options-migration.test.ts (CI runs them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const OPTION = '0190a000-0000-7000-8000-0000000000c1';
const STORE = '0190a000-0000-7000-8000-000000000001';
const OTHER_STORE = '0190a000-0000-7000-8000-000000000002';
type Opt = { id: string; orgId: string; name: string; amount: string; perUnit: boolean; sortOrder: number; status: 'active' | 'retired' };
const state = {
  refuse: new Set<string>(),
  option: undefined as Opt | undefined,
  storesOn: [] as string[],
  latest: undefined as { id: string; status: 'active' | 'retired' } | undefined,
};
const append = vi.fn(async (..._a: unknown[]) => {
  calls.push('audit');
});
const authorize = vi.fn(async (_tx: unknown, _actor: unknown, cap: string, scope: Record<string, unknown>) => {
  calls.push(`authorize:${cap}:${JSON.stringify(scope)}`);
  if (state.refuse.has(cap)) {
    const { AuthorizationError } = await vi.importActual<typeof import('@shareat/auth')>('@shareat/auth');
    throw new AuthorizationError(`test: no ${cap}`, cap as never);
  }
});

vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<typeof import('@shareat/auth')>()), authorize }));
vi.mock('@shareat/db', async (orig) => {
  const real = await orig<typeof import('@shareat/db')>();
  const spy = <T>(name: string, value: () => T) =>
    vi.fn(async () => {
      calls.push(name);
      return value();
    });
  return {
    ...real,
    auditLogRepo: { append },
    posV2Repo: { getPosStore: vi.fn(async () => ({})), bumpStateVersion: vi.fn(async (_tx: unknown, _org: string, storeId: string) => calls.push(`bump:${storeId}`)) },
    posStoreSetupRepo: {
      findChargeOptionByKey: spy('findByKey', () => undefined),
      listChargeOptions: spy('list', () => []),
      insertChargeOption: spy('insertOption', () => ({ id: OPTION })),
      getChargeOptionById: spy('getOption', () => state.option),
      updateChargeOptionRow: vi.fn(async (_tx: unknown, _o: string, _id: string, set: Record<string, unknown>) => calls.push(`updateOption:${JSON.stringify(set)}`)),
      storesWithChargeOn: spy('storesOn', () => state.storesOn),
      latestChargeSwitch: spy('latest', () => state.latest),
      insertChargeSwitch: spy('insertSwitch', () => ({ id: 'preset-new' })),
      setChargeSwitchStatus: vi.fn(async (_tx: unknown, _o: string, _s: string, _p: string, status: string) => calls.push(`switch:${status}`)),
    },
  };
});

const { AuthorizationError } = await import('@shareat/auth');
const { createChargeOption, setChargeOptionStatus, setStoreCharge, updateChargeOption } = await import('../src/pos/charge-options');

const actor = { orgId: '0190a000-0000-7000-8000-0000000000aa', personId: '0190a000-0000-7000-8000-0000000000bb' } as never;
const tx = {} as never;

beforeEach(() => {
  calls.length = 0;
  append.mockClear();
  state.refuse = new Set();
  state.option = { id: OPTION, orgId: 'org', name: 'Leftover', amount: '100.00', perUnit: true, sortOrder: 10, status: 'active' };
  state.storesOn = [];
  state.latest = undefined;
});

describe('authorize first; the org list is manage_menu at ORG scope, so a store manager is refused', () => {
  it('create, update and retire each ask manage_menu with no store, before anything is read; refused = nothing else happens', async () => {
    state.refuse.add('manage_menu');
    await expect(createChargeOption(tx, actor, { name: '', amount: 'not a number' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(updateChargeOption(tx, actor, { chargeOptionId: OPTION, amount: '1' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setChargeOptionStatus(tx, actor, { chargeOptionId: OPTION, status: 'retired' })).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toEqual(['authorize:manage_menu:{}', 'authorize:manage_menu:{}', 'authorize:manage_menu:{}']);
  });

  it('the store switch asks manage_store_settings AT the store first (not manage_menu)', async () => {
    state.refuse.add('manage_store_settings');
    await expect(setStoreCharge(tx, actor, { storeId: STORE, chargeOptionId: OPTION, on: true })).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toEqual([`authorize:manage_store_settings:{"storeId":"${STORE}"}`]);
  });
});

describe('retire refused while on', () => {
  it('names how many stores, and writes nothing (no update, no audit)', async () => {
    state.storesOn = [STORE, OTHER_STORE];
    await expect(setChargeOptionStatus(tx, actor, { chargeOptionId: OPTION, status: 'retired' })).rejects.toMatchObject({
      userMessage: 'Leftover is switched on at 2 stores. Switch it off there first, then retire it.',
    });
    expect(calls.some((c) => c.startsWith('updateOption'))).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('allowed when no store has it on: one update, one audit row', async () => {
    expect(await setChargeOptionStatus(tx, actor, { chargeOptionId: OPTION, status: 'retired' })).toEqual({ outcome: 'changed' });
    expect(calls).toContain('updateOption:{"status":"retired"}');
    expect(append.mock.calls[0]![2]).toMatchObject({ action: 'charge_option.retired', storeId: null, entityId: OPTION, before: { status: 'active' }, after: { status: 'retired' } });
  });
});

describe('an amount change reaches every store', () => {
  it('updates the ONE option row, audits it, and gives each store that has it on a new snapshot version', async () => {
    state.storesOn = [STORE, OTHER_STORE];
    expect(await updateChargeOption(tx, actor, { chargeOptionId: OPTION, amount: '120.5' })).toEqual({ outcome: 'updated', storesOn: 2 });
    expect(calls.filter((c) => c.startsWith('updateOption'))).toEqual(['updateOption:{"amount":"120.50","perUnit":true}']);
    expect(calls.filter((c) => c.startsWith('bump:'))).toEqual([`bump:${STORE}`, `bump:${OTHER_STORE}`]);
    expect(append.mock.calls[0]![2]).toMatchObject({ action: 'charge_option.updated', before: { amount: '100.00' }, after: { amount: '120.50', storesOn: 2 } });
  });

  it('the same amount writes nothing', async () => {
    expect(await updateChargeOption(tx, actor, { chargeOptionId: OPTION, amount: '100' })).toEqual({ outcome: 'unchanged', storesOn: 0 });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('the store switch', () => {
  it('on with no row: inserts one; on again (row off): reuses it; already on: nothing', async () => {
    expect((await setStoreCharge(tx, actor, { storeId: STORE, chargeOptionId: OPTION, on: true })).outcome).toBe('on');
    expect(calls).toContain('insertSwitch');
    calls.length = 0;
    state.latest = { id: 'preset-1', status: 'retired' };
    expect((await setStoreCharge(tx, actor, { storeId: STORE, chargeOptionId: OPTION, on: true })).outcome).toBe('on');
    expect(calls).toContain('switch:active');
    expect(calls).not.toContain('insertSwitch');
    state.latest = { id: 'preset-1', status: 'active' };
    expect((await setStoreCharge(tx, actor, { storeId: STORE, chargeOptionId: OPTION, on: true })).outcome).toBe('unchanged');
  });

  it('a retired charge cannot be switched on', async () => {
    state.option = { ...state.option!, status: 'retired' };
    await expect(setStoreCharge(tx, actor, { storeId: STORE, chargeOptionId: OPTION, on: true })).rejects.toMatchObject({
      userMessage: 'Leftover is retired for all stores, so it cannot be switched on. Bring it back in the list above first.',
    });
    expect(calls).not.toContain('insertSwitch');
  });
});
