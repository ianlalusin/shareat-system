/**
 * T-349 S2c (DEF-456) — `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §4c, legs P8 / G1-G3.
 *
 * ⛔ TESTER, not BUILDER. `foldActiveGrants` (`apps/erp/src/app/admin/users/lib.ts:216-243`) picks
 * a `position` row's cover via `others.find(...)`, first array match wins — not "an org-wide
 * (NULL-store) cover wins over a same-store cover" (finding 2). And `setCapabilityGrantAction`'s
 * banner (`actions.ts:202-205`) never names the store axis (finding 3) — every leg below is
 * expected red until the builder lands S2c items 2 and 4.
 *
 * Harness: the S6b harness (`t343-s6b-admin-users-labels.test.ts`'s own header) — a partial
 * `@shareat/auth` mock that spreads the real module (`grantCapabilityAsActor` is the only
 * override), so `CAPABILITY_SCOPE`/`capabilityTitle` the banner renders with are the real ones.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { capabilityTitle } from '../../../packages/auth/src/capabilities';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
}));

vi.mock('@/lib/constraint-messages', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Exactly the S6b harness's own mock — everything else real, including CAPABILITY_SCOPE the
// banner (once built) renders with.
vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  grantCapabilityAsActor: vi.fn(),
}));

vi.mock('../src/app/admin/users/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/users/lib')>();
  return {
    ...actual,
    // Same passthrough t337-access-defaults-actions.test.ts / t343-s6b use — no real transaction.
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  };
});

let actions: typeof import('../src/app/admin/users/actions');
let authModule: typeof import('@shareat/auth');
let lib: typeof import('../src/app/admin/users/lib');

// Hoisted import, per the S6b file's own note: `await import(...)` inside `beforeAll` so every
// `it` reuses the same cached module instead of re-resolving it.
beforeAll(async () => {
  actions = await import('../src/app/admin/users/actions');
  authModule = await import('@shareat/auth');
  lib = await import('../src/app/admin/users/lib');
}, 30_000);

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
    throw new Error('expected the action to redirect, but it returned normally');
  } catch (err) {
    if (!(err instanceof RedirectSignal)) throw err;
    return err.to;
  }
}

function grantFormData(overrides: { capabilities: string[] }): FormData {
  const fd = new FormData();
  fd.set('personId', 'person-1');
  fd.set('granted', 'true');
  for (const c of overrides.capabilities) fd.append('capability', c);
  return fd;
}

// =================================================================================================
// P8 — foldActiveGrants: an org-wide cover wins over a same-store cover, regardless of input order.
// =================================================================================================

describe('P8 — foldActiveGrants: NULL-store cover wins over same-store cover, order-independent', () => {
  const STORE_A = 'store-a';
  const CAP = 'confirm_receipt';

  const positionSource = {
    id: 'pcd-1',
    positionId: 'position-cashier',
    positionName: 'Cashier',
    storeId: STORE_A,
    storeName: 'Store A',
    revokedAt: null,
  };

  function baseRow(overrides: Partial<Parameters<typeof lib.foldActiveGrants>[0][number]>) {
    return {
      id: 'grant-base',
      personId: 'person-1',
      grantName: CAP,
      grantedBy: 'actor-admin-1',
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      revokedAt: null,
      grantSource: 'grant' as const,
      sourceRef: null,
      storeId: null,
      revokeReason: null,
      positionSource: null,
      ...overrides,
    };
  }

  const storeAGrant = baseRow({ id: 'grant-store-a', storeId: STORE_A });
  const nullStoreGrant = baseRow({ id: 'grant-null-store', storeId: null });
  const position = baseRow({
    id: 'grant-position',
    grantSource: 'position' as const,
    storeId: STORE_A,
    sourceRef: positionSource.id,
    positionSource,
  });

  it(
    'forward order [store-A, NULL-store, position]: NULL-store line gets alsoVia, store-A line does not (was red today: first array match wins, store-A comes first)',
    () => {
      const folded = lib.foldActiveGrants([storeAGrant, nullStoreGrant, position]);
      const nullLine = folded.find((f) => f.grant.id === 'grant-null-store');
      const storeALine = folded.find((f) => f.grant.id === 'grant-store-a');
      expect(nullLine?.alsoVia, 'wanted: the NULL-store line folds the position in').toEqual([positionSource]);
      expect(storeALine?.alsoVia, 'wanted: the store-A line folds in nothing — it lost to the org-wide cover').toEqual([]);
    },
  );

  it(
    '⛔ green today (a guard, not a red): [position, NULL-store, store-A] — `others` filters to [NULL-store, store-A] in that order, so even today\'s first-match `.find` happens to pick NULL-store here. The forward-order and reordered legs above are the load-bearing reds.',
    () => {
      const folded = lib.foldActiveGrants([position, nullStoreGrant, storeAGrant]);
      const nullLine = folded.find((f) => f.grant.id === 'grant-null-store');
      const storeALine = folded.find((f) => f.grant.id === 'grant-store-a');
      expect(nullLine?.alsoVia).toEqual([positionSource]);
      expect(storeALine?.alsoVia).toEqual([]);
    },
  );

  it('a different others-order that today WOULD pick store-A first also resolves to the NULL-store cover', () => {
    // `others` derives from array order alone (`grants.filter`) — put store-A ahead of the
    // NULL-store row so today's `others.find` picks it, and the fix must still choose NULL-store.
    const folded = lib.foldActiveGrants([position, storeAGrant, nullStoreGrant]);
    const nullLine = folded.find((f) => f.grant.id === 'grant-null-store');
    const storeALine = folded.find((f) => f.grant.id === 'grant-store-a');
    expect(nullLine?.alsoVia, 'wanted: NULL-store wins even when it sorts after store-A — was red: store-A wins').toEqual([
      positionSource,
    ]);
    expect(storeALine?.alsoVia).toEqual([]);
  });

  // T-349 S2d (D4) — the same-store lookup (`lib.ts:236-238`) accepts `grantSource === 'grant'`
  // only; the pre-S2c fold also accepted `'owner'`. `person_grants_store_shape_check` forbids an
  // `owner`+`store_id` row today (defensive parity, not a reachable production shape), so this is a
  // pure-function fixture, not an integration leg.
  it(
    'P9 — a same-store OWNER row covers the position too, not just a same-store grant — was red today: the owner row is not matched at all, the position stays its own uncovered line',
    () => {
      const ownerSameStore = baseRow({ id: 'grant-owner-store-a', grantSource: 'owner' as const, storeId: STORE_A });
      const folded = lib.foldActiveGrants([ownerSameStore, position]);
      const ownerLine = folded.find((f) => f.grant.id === 'grant-owner-store-a');
      const uncoveredPosition = folded.find((f) => f.grant.id === 'grant-position');
      expect(ownerLine?.alsoVia, 'wanted: the same-store owner row folds the position in').toEqual([positionSource]);
      expect(uncoveredPosition, 'wanted: no separate uncovered position line').toBeUndefined();
    },
  );
});

// =================================================================================================
// G1-G3 — setCapabilityGrantAction's banner names the store axis for a store-scoped capability.
// =================================================================================================

describe('G1-G3 — the picker-grant banner names "at every store they have access to" for a store-scoped capability only', () => {
  let grantCapabilityAsActor: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    grantCapabilityAsActor = authModule.grantCapabilityAsActor as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    grantCapabilityAsActor.mockReset();
  });

  it('G1: one store-scoped capability (confirm_receipt) → "Granted: <Title>, at every store they have access to."', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(grantFormData({ capabilities: ['confirm_receipt'] })));
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(`Granted: ${capabilityTitle('confirm_receipt')}, at every store they have access to.`);
  });

  it('G2 (⛔ green today, a guard): one org-scoped capability (manage_fixed_assets) → "Granted: <Title>." with no store phrase', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(grantFormData({ capabilities: ['manage_fixed_assets'] })));
    const params = new URL(to, 'http://localhost').searchParams;
    const ok = params.get('ok');
    expect(ok, `redirect URL was: ${to}`).toBe(`Granted: ${capabilityTitle('manage_fixed_assets')}.`);
    expect(ok, 'org-scoped must never claim a store axis it does not have').not.toContain('every store');
  });

  it('G3: two capabilities, confirm_receipt then manage_fixed_assets → each phrase names its own scope, joined by "; "', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(grantFormData({ capabilities: ['confirm_receipt', 'manage_fixed_assets'] })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(
      `Granted 2 capabilities: ${capabilityTitle('confirm_receipt')}, at every store they have access to; ${capabilityTitle('manage_fixed_assets')}.`,
    );
  });
});
