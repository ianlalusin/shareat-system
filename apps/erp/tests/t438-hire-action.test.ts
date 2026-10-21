import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-438 H8 (docs/tasks/438-hire-name-parts-and-staff-pin-only.md N5, N6): `hireAction`'s input rules, with the domain mocked.
 * Assumed form field names (the spec fixes only `personChoice` radios `existing:<id>` and `sameNameConfirmed`): `lastName`,
 * `firstName`, `middleName`. The old `newDisplayName` box and the `new` radio value are gone.
 * RED today: the action only understands `personChoice=new` + `newDisplayName`, so a typed name without it is refused with the
 * old "Pick ... or create new person" sentence and createPerson is never called with parts.
 */
const redirectWithFlash = vi.fn(async (..._a: unknown[]): Promise<never> => {
  throw new Error('redirected');
});
const createPerson = vi.fn(async (..._a: unknown[]) => ({ id: 'person-new' }));
const createEmployment = vi.fn(async (..._a: unknown[]) => ({ id: 'emp-1' }));

// T-440: this wrapper unit harness has no database; real auth-first refusals are covered by PostgreSQL controls.
vi.mock('@shareat/auth', async (orig) => ({ ...(await orig<object>()), can: vi.fn(async () => true) }));

vi.mock('@/lib/flash', () => ({ redirectWithFlash: (...a: unknown[]) => redirectWithFlash(...a) }));
vi.mock('../src/lib/session', () => ({ requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'p1' })) }));
vi.mock('../src/app/staff/lib', () => ({
  listStores: vi.fn(),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@shareat/domain', async (orig) => ({
  ...(await orig<typeof import('@shareat/domain')>()),
  createPerson: (...a: unknown[]) => createPerson(...a),
  createEmployment: (...a: unknown[]) => createEmployment(...a),
}));

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  const base: Record<string, string> = { storeId: 'store-1', employmentStatus: 'probationary', startedOn: '2026-10-17' };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  await import('../src/app/staff/actions');
}, 30_000);
beforeEach(() => {
  redirectWithFlash.mockClear();
  createPerson.mockClear();
  createEmployment.mockClear();
});

async function run(fields: Record<string, string>) {
  const { hireAction } = await import('../src/app/staff/actions');
  await expect(hireAction(form(fields))).rejects.toThrow('redirected');
  return redirectWithFlash.mock.calls[0] as [string, Record<string, string>, { ok?: string; error?: string }];
}

describe('T-438 H8 - hireAction decides what the form meant, and never guesses (N5)', () => {
  it('picked AND typed: refused with "Keep only one", nothing created', async () => {
    // Kills: silent preference for the picked person (or for the typed name).
    const [, , flash] = await run({ personChoice: 'existing:person-9', lastName: 'Reyes', firstName: 'Ana' });
    expect(flash.error).toMatch(/also typed a new name/);
    expect(flash.error).toMatch(/Keep only one\./);
    expect(createPerson).not.toHaveBeenCalled();
    expect(createEmployment).not.toHaveBeenCalled();
  });
  it('neither picked nor typed: refused with the pick-or-type sentence', async () => {
    // Kills: falling through to createPerson with an empty name; the old "create new person" sentence surviving.
    const [, , flash] = await run({});
    expect(flash.error).toBe('Pick a person from the search, or type their last and first name.');
    expect(createPerson).not.toHaveBeenCalled();
  });
  it('last without first, and first without last: refused with the both-names sentence', async () => {
    // Kills: accepting a one-part name.
    for (const f of <Record<string, string>[]>[{ lastName: 'Reyes' }, { firstName: 'Ana' }, { lastName: 'Reyes', middleName: 'Lim' }]) {
      redirectWithFlash.mockClear();
      const [, , flash] = await run(f);
      expect(flash.error).toBe('A new person needs both a last name and a first name.');
    }
    expect(createPerson).not.toHaveBeenCalled();
  });
  it('typed parts reach createPerson as { name: { lastName, firstName, middleName }, sameNameConfirmed }', async () => {
    // Kills: parts concatenated into displayName in the action; the override tick dropped.
    const [, , flash] = await run({ lastName: 'Reyes', firstName: 'Ana', middleName: 'lim', sameNameConfirmed: 'on' });
    expect(createPerson).toHaveBeenCalledTimes(1);
    const input = createPerson.mock.calls[0]![2] as Record<string, unknown>;
    expect(input['displayName']).toBeUndefined();
    expect(input['name']).toMatchObject({ lastName: 'Reyes', firstName: 'Ana', middleName: 'lim' });
    expect(input['sameNameConfirmed']).toBe(true);
    expect(flash.ok).toBe('Hired.');
  });
  it('without the tick sameNameConfirmed is false/absent; a picked person never calls createPerson', async () => {
    await run({ lastName: 'Reyes', firstName: 'Ana' });
    expect((createPerson.mock.calls[0]![2] as Record<string, unknown>)['sameNameConfirmed'] ?? false).toBe(false);
    createPerson.mockClear();
    redirectWithFlash.mockClear();
    await run({ personChoice: 'existing:person-9' });
    expect(createPerson).not.toHaveBeenCalled();
    expect((createEmployment.mock.calls.at(-1)![2] as Record<string, unknown>)['personId']).toBe('person-9');
  });
});
