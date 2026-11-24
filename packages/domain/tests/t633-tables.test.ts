/**
 * T-633 - table numbers from the ERP Tables section (docs/tasks/633-tables-screen.md). Unit level, no database: the range parser is pure, and the
 * database and the capability check are replaced by spies so the ORDER of decisions is visible (authorize first; nothing read or written after a
 * refusal) and the audit row's exact shape is checked. The DB-backed version is `integration/t633-tables.test.ts` (CI runs it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const state = { stand: undefined as { id: string; number: number; status: string } | undefined, openSession: false, refuseAuth: false };
const append = vi.fn(async (..._args: unknown[]) => {
  calls.push('audit');
});

vi.mock('@shareat/auth', async (orig) => {
  const real = await orig<typeof import('@shareat/auth')>();
  return {
    ...real,
    authorize: vi.fn(async () => {
      calls.push('authorize');
      if (state.refuseAuth) throw new real.AuthorizationError('test: no manage_store_settings', 'manage_store_settings');
    }),
  };
});

vi.mock('@shareat/db', async (orig) => {
  const real = await orig<typeof import('@shareat/db')>();
  return {
    ...real,
    auditLogRepo: { append },
    posV2Repo: {
      getStand: vi.fn(async () => {
        calls.push('getStand');
        return state.stand;
      }),
      getPosStore: vi.fn(async () => undefined),
      bumpStateVersion: vi.fn(async () => undefined),
    },
    posStoreSetupRepo: {
      getStandByNumber: vi.fn(async () => {
        calls.push('getStandByNumber');
        return undefined;
      }),
      insertStand: vi.fn(async (_tx: unknown, input: { number: number }) => {
        calls.push(`insert:${input.number}`);
        return { id: `stand-${input.number}` };
      }),
      standHasOpenSession: vi.fn(async () => {
        calls.push('openSession?');
        return state.openSession;
      }),
      retireStand: vi.fn(async () => {
        calls.push('retireStand');
        return true;
      }),
    },
  };
});

const { AuthorizationError } = await import('@shareat/auth');
const { TABLE_ADD_MAX, addPosStands, parseTableNumbers, retirePosStand } = await import('../src/pos/store-setup');

const STORE = '0190a000-0000-7000-8000-000000000001';
const STAND = '0190a000-0000-7000-8000-000000000007';
const actor = { orgId: '0190a000-0000-7000-8000-0000000000aa', personId: '0190a000-0000-7000-8000-0000000000bb' } as never;
const tx = {} as never;
const sentence = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { userMessage?: string }).userMessage;
  }
  return 'no refusal';
};

beforeEach(() => {
  calls.length = 0;
  append.mockClear();
  state.stand = { id: STAND, number: 7, status: 'active' };
  state.openSession = false;
  state.refuseAuth = false;
});

describe('parseTableNumbers (pure)', () => {
  it('"1-20" is the twenty numbers 1 to 20, smallest first; an en dash and spaces are fine', () => {
    expect(parseTableNumbers('1-20')).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(parseTableNumbers(' 3 – 5 ')).toEqual([3, 4, 5]);
  });

  it('"5" is the one number 5; "9-9" is also just 9', () => {
    expect(parseTableNumbers('5')).toEqual([5]);
    expect(parseTableNumbers('9-9')).toEqual([9]);
  });

  it('bad input is refused in words', () => {
    for (const bad of ['', 'ten', '1-', '-3', '1,2', '1-2-3', '5a', '1.5', 12 as unknown as string, undefined as unknown as string]) {
      expect(sentence(() => parseTableNumbers(bad)), String(bad)).toBe('Type one table number, like 5, or a range, like 1-20.');
    }
  });

  it('a reversed range is refused, naming the right way round', () => {
    expect(sentence(() => parseTableNumbers('20-1'))).toBe('The range 20-1 goes backwards. Put the smaller number first, like 1-20.');
  });

  it('numbers outside 1 to 999 are refused', () => {
    for (const bad of ['0', '0-5', '995-1000', '1000']) {
      expect(sentence(() => parseTableNumbers(bad)), bad).toBe('A table number must be a whole number from 1 to 999.');
    }
  });

  it('at most 200 per submit: 200 is fine, 201 is refused with the count', () => {
    expect(TABLE_ADD_MAX).toBe(200);
    expect(parseTableNumbers('1-200')).toHaveLength(200);
    expect(sentence(() => parseTableNumbers('1-201'))).toBe('You can add at most 200 tables at a time. 1-201 is 201 tables.');
    expect(sentence(() => parseTableNumbers('100-999'))).toBe('You can add at most 200 tables at a time. 100-999 is 900 tables.');
  });
});

describe('authorize first', () => {
  it('addPosStands: a refused actor gets the authorization error even for bad input, and nothing is read or written', async () => {
    state.refuseAuth = true;
    await expect(addPosStands(tx, actor, { storeId: STORE, numbers: 'nonsense' })).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toEqual(['authorize']);
  });

  it('retirePosStand: authorize comes before the stand is even read', async () => {
    state.refuseAuth = true;
    await expect(retirePosStand(tx, actor, { storeId: STORE, standId: STAND })).rejects.toBeInstanceOf(AuthorizationError);
    expect(calls).toEqual(['authorize']);
  });

  it('allowed: authorize is the first call of both', async () => {
    await addPosStands(tx, actor, { storeId: STORE, numbers: '1-2' });
    expect(calls[0]).toBe('authorize');
    calls.length = 0;
    await retirePosStand(tx, actor, { storeId: STORE, standId: STAND });
    expect(calls[0]).toBe('authorize');
  });
});

describe('retire refused with an open session', () => {
  it('names the table and writes nothing (no retire, no audit)', async () => {
    state.openSession = true;
    await expect(retirePosStand(tx, actor, { storeId: STORE, standId: STAND })).rejects.toMatchObject({
      userMessage: 'Table 7 has an open bill. Settle or void it on the tablet first, then retire the table.',
    });
    expect(calls).toEqual(['authorize', 'getStand', 'openSession?']);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('the audit row', () => {
  it('retire writes pos.stand_retired with the stand, the store, before/after and source web', async () => {
    expect(await retirePosStand(tx, actor, { storeId: STORE, standId: STAND })).toEqual({ outcome: 'retired', number: 7 });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2]).toEqual({
      actorPersonId: '0190a000-0000-7000-8000-0000000000bb',
      action: 'pos.stand_retired',
      storeId: STORE,
      entityId: STAND,
      before: { number: 7, status: 'active' },
      after: { number: 7, status: 'retired' },
      source: 'web',
    });
  });

  it('add writes one pos.stand_added per new number, from the web', async () => {
    expect(await addPosStands(tx, actor, { storeId: STORE, numbers: '3-4' })).toEqual({ added: 2, existed: 0, retired: 0 });
    expect(append.mock.calls.map((c) => c[2])).toEqual([
      { actorPersonId: '0190a000-0000-7000-8000-0000000000bb', action: 'pos.stand_added', storeId: STORE, entityId: 'stand-3', before: null, after: { number: 3, status: 'active' }, source: 'web' },
      { actorPersonId: '0190a000-0000-7000-8000-0000000000bb', action: 'pos.stand_added', storeId: STORE, entityId: 'stand-4', before: null, after: { number: 4, status: 'active' }, source: 'web' },
    ]);
  });

  it('a stand already retired: nothing written, no audit', async () => {
    state.stand = { id: STAND, number: 7, status: 'retired' };
    expect(await retirePosStand(tx, actor, { storeId: STORE, standId: STAND })).toEqual({ outcome: 'unchanged', number: 7 });
    expect(append).not.toHaveBeenCalled();
    expect(calls).not.toContain('retireStand');
  });
});
