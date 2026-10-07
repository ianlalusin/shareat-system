/**
 * T-337 Amendment A1 — R6. `docs/tasks/337-access-defaults-grouped-collapsible.md`, "Amendment A1".
 * `toggleDefaultAction` must redirect with `cap=<capability>&pos=<positionId>` on BOTH the ok and
 * the error path (contract point 1) — no form changes, so this is pure server-action behaviour,
 * tested by mocking `next/navigation`'s `redirect` (to capture the URL instead of throwing Next's
 * own internal signal — same posture as `apps/erp/tests/integration/sign-out-action.test.ts`) and
 * the domain call, never a real database.
 *
 * ⛔ RED until the builder adds the two params to `actions.ts`'s `backToGrid` calls inside
 * `toggleDefaultAction` — today it calls `backToGrid(storeId, { ok/error })` with neither.
 *
 * NEGATIVE: `sameForEveryStoreAction` must NOT gain `cap`/`pos` — Amendment A1 point 1 names
 * `toggleDefaultAction` only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

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

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));

vi.mock('@shareat/db', () => ({
  accessRepo: { activeStoreIdsForOrg: vi.fn(async () => []) },
}));

const setPositionDefault = vi.fn();
vi.mock('@shareat/domain', () => ({
  setPositionDefault: (...args: unknown[]) => setPositionDefault(...args),
  retireStorePosition: vi.fn(),
}));

// `actions.ts` imports `@/lib/constraint-messages` via `apps/erp`'s own tsconfig path, which the
// ROOT `vitest.config.mts` (this project's config) never registers as a resolve alias — only
// `@shareat/*` workspace packages are. Mocking the bare specifier sidesteps that gap rather than
// widening scope into a config file.
vi.mock('@/lib/constraint-messages', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../src/app/admin/access-defaults/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/access-defaults/lib')>();
  return {
    ...actual,
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
    activeDefaultsAtStore: vi.fn(async () => []),
  };
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
    throw new Error('expected the action to redirect, but it returned normally');
  } catch (err) {
    if (!(err instanceof RedirectSignal)) throw err;
    return err.to;
  }
}

function toggleFormData(overrides: Partial<Record<'storeId' | 'positionId' | 'capability' | 'on', string>> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', overrides.storeId ?? '11111111-1111-4111-8111-111111111111');
  fd.set('positionId', overrides.positionId ?? '33333333-3333-4333-8333-333333333333');
  fd.set('capability', overrides.capability ?? 'record_sale');
  fd.set('on', overrides.on ?? 'true');
  return fd;
}

describe('R6 — toggleDefaultAction redirects with cap and pos, on success AND on a thrown domain error', () => {
  // Audit follow-up (2026-09-25): every test in this file re-imports the same module, and under a
  // full `--project unit` run (153 files, concurrent transforms) the FIRST dynamic import of
  // `actions.ts` — which drags in its whole graph (grid/lib/@shareat/db/@shareat/domain/drizzle
  // etc., all needing a fresh transform under load) — routinely exceeded vitest's 5000ms default,
  // even though every assertion was correct (confirmed: the file passes instantly alone). Hoisting
  // the import to `beforeAll` with an explicit, generous timeout imports the module exactly ONCE
  // for the whole file, with room for a cold, contended transform — not a weaker assertion, just
  // enough wall-clock for real (not hung) work.
  let actions: typeof import('../src/app/admin/access-defaults/actions');

  beforeAll(async () => {
    actions = await import('../src/app/admin/access-defaults/actions');
  }, 30_000);

  afterEach(() => {
    setPositionDefault.mockReset();
  });

  it('success path: redirect carries cap=<capability>&pos=<positionId>', async () => {
    setPositionDefault.mockResolvedValue({ affected: 1, skippedSelf: false, wroteDefault: true });
    const { toggleDefaultAction } = actions;
    const to = await expectRedirectTo(() => toggleDefaultAction(toggleFormData({ capability: 'record_sale', positionId: '33333333-3333-4333-8333-333333333333' })));
    const params = paramsOf(to);
    // Audit finding 2: `store` must survive too — a redirect that drops it lands the admin on
    // stores[0] instead of the store they were actually working in.
    expect(params.get('store'), `redirect URL was: ${to}`).toBe('11111111-1111-4111-8111-111111111111');
    expect(params.get('cap'), `redirect URL was: ${to}`).toBe('record_sale');
    expect(params.get('pos'), `redirect URL was: ${to}`).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('error path: redirect STILL carries cap=<capability>&pos=<positionId> when the domain call throws', async () => {
    setPositionDefault.mockRejectedValue(new Error('may not \'grant_capability\''));
    const { toggleDefaultAction } = actions;
    const to = await expectRedirectTo(() => toggleDefaultAction(toggleFormData({ capability: 'void_sales_day', positionId: '44444444-4444-4444-8444-444444444444' })));
    const params = paramsOf(to);
    expect(params.get('store'), `redirect URL was: ${to}`).toBe('11111111-1111-4111-8111-111111111111');
    expect(params.get('cap'), `redirect URL was: ${to}`).toBe('void_sales_day');
    expect(params.get('pos'), `redirect URL was: ${to}`).toBe('44444444-4444-4444-8444-444444444444');
    expect(params.get('error'), 'the error path must still carry its error message too').toBeTruthy();
  });

  it('NEGATIVE: sameForEveryStoreAction\'s redirect has neither cap nor pos', async () => {
    const { sameForEveryStoreAction } = actions;
    const fd = new FormData();
    fd.set('storeId', '11111111-1111-4111-8111-111111111111');
    fd.set('positionId', '33333333-3333-4333-8333-333333333333');
    const to = await expectRedirectTo(() => sameForEveryStoreAction(fd));
    const params = paramsOf(to);
    expect(params.has('cap'), `redirect URL was: ${to}`).toBe(false);
    expect(params.has('pos'), `redirect URL was: ${to}`).toBe(false);
  });

  // Audit finding 3: Amendment A1 point 1 names `toggleDefaultAction` only — every OTHER action's
  // redirect must stay exactly as it is today, with neither param.
  it('NEGATIVE: copyDefaultsAction\'s redirect has neither cap nor pos', async () => {
    const { copyDefaultsAction } = actions;
    const fd = new FormData();
    fd.set('storeId', '11111111-1111-4111-8111-111111111111');
    fd.set('sourceStoreId', '22222222-2222-4222-8222-222222222222');
    const to = await expectRedirectTo(() => copyDefaultsAction(fd));
    const params = paramsOf(to);
    expect(params.has('cap'), `redirect URL was: ${to}`).toBe(false);
    expect(params.has('pos'), `redirect URL was: ${to}`).toBe(false);
  });

  it('NEGATIVE: retireStorePositionAction\'s redirect has neither cap nor pos', async () => {
    const { retireStorePositionAction } = actions;
    const fd = new FormData();
    fd.set('storeId', '11111111-1111-4111-8111-111111111111');
    fd.set('positionId', '55555555-5555-4555-8555-555555555555');
    const to = await expectRedirectTo(() => retireStorePositionAction(fd));
    const params = paramsOf(to);
    expect(params.has('cap'), `redirect URL was: ${to}`).toBe(false);
    expect(params.has('pos'), `redirect URL was: ${to}`).toBe(false);
  });
});
