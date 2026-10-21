import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Staff Positions tab: upsertStorePositionAction returns the user to the Positions tab (view=positions), on success and on error. */
const redirectWithFlash = vi.fn(async (..._a: unknown[]): Promise<never> => {
  throw new Error('redirected');
});
const upsert = vi.fn();

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
  upsertStorePosition: (...a: unknown[]) => upsert(...a),
}));

function form(): FormData {
  const fd = new FormData();
  fd.set('storeId', 'store-1');
  fd.set('name', 'Host');
  return fd;
}

// Warm the actions import graph once (cold it exceeds the unit project's 5s default).
beforeAll(async () => {
  await import('../src/app/staff/actions');
}, 30_000);

beforeEach(() => {
  redirectWithFlash.mockClear();
  upsert.mockReset();
});

describe('upsertStorePositionAction redirect', () => {
  it('success lands on /staff with view=positions and the same store', async () => {
    upsert.mockResolvedValue({ outcome: 'added' });
    const { upsertStorePositionAction } = await import('../src/app/staff/actions');
    await expect(upsertStorePositionAction(form())).rejects.toThrow('redirected');
    const [path, nav, flash] = redirectWithFlash.mock.calls[0] as [string, Record<string, string>, Record<string, string>];
    expect(path).toBe('/staff');
    expect(nav).toEqual({ view: 'positions', store: 'store-1' });
    expect(flash.ok).toContain('Host');
  });

  it('a refusal also lands on view=positions, carrying the error', async () => {
    upsert.mockRejectedValue(new Error('boom'));
    const { upsertStorePositionAction } = await import('../src/app/staff/actions');
    await expect(upsertStorePositionAction(form())).rejects.toThrow('redirected');
    const [path, nav, flash] = redirectWithFlash.mock.calls[0] as [string, Record<string, string>, Record<string, string>];
    expect(path).toBe('/staff');
    expect(nav).toEqual({ view: 'positions', store: 'store-1' });
    expect(flash.error).toBeTruthy();
    expect(flash.ok).toBeUndefined();
  });
});
