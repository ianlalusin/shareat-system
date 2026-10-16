/**
 * T-384 S1a (TESTER, audit change 1) - the web actions REQUIRE the version (R1: "the web actions ALWAYS pass it").
 * `updateTenderAction` and `setTenderActiveAction` given a blank or missing `version` must refuse with the R1 sentence
 * and never reach the domain (so the row is unchanged and nothing is audited). The domain keeps `expectedVersion`
 * optional (t384-s1-tenders D5). Harness: `t375-s2-tender-action.test.ts`.
 *
 * Red on HEAD of the builder commit: `...(version ? { expectedVersion } : {})` silently drops a blank version and the
 * domain is called unguarded.
 * Mutants: the action defaults a blank version to something; the check runs only for update, not for retire/restore.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paramsOf } from './helpers/flash-jar';

const STALE_SENTENCE =
  'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';

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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'actor-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
// T-412: retiring a tender asks for its name, loaded by the server; this file is about the version rule, so the name is stubbed ('The Name').
vi.mock('@/lib/destructive', async () => (await import('./helpers/destructive-mocks')).destructiveLibMock());
vi.mock('../src/app/settings/pos-link/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/settings/pos-link/lib')>();
  return { ...actual, withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}) };
});

const updateTenderMock = vi.fn(async (..._a: unknown[]) => undefined);
const setTenderActiveMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return {
    ...actual,
    updateTender: (...a: unknown[]) => updateTenderMock(...a),
    setTenderActive: (...a: unknown[]) => setTenderActiveMock(...a),
  };
});

beforeAll(async () => {
  await import('../src/app/settings/pos-link/actions');
}, 120_000);
beforeEach(() => {
  updateTenderMock.mockClear();
  setTenderActiveMock.mockClear();
});

async function run(which: 'updateTenderAction' | 'setTenderActiveAction', fields: Record<string, string | undefined>): Promise<string> {
  const fd = new FormData();
  fd.set('storeId', '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b');
  fd.set('tenderId', 'tender-1');
  fd.set('name', 'Gcash');
  fd.set('posV1Alias', 'Gcash');
  fd.set('isActive', 'false');
  fd.set('confirmName', 'The Name');
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  const mod = await import('../src/app/settings/pos-link/actions');
  try {
    await mod[which](fd);
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

describe.each(['updateTenderAction', 'setTenderActiveAction'] as const)('%s requires a version', (which) => {
  const domainMock = () => (which === 'updateTenderAction' ? updateTenderMock : setTenderActiveMock);

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['spaces only', '   '],
  ])('a %s version -> the R1 sentence as the error, no success, the domain is never called', async (_n, version) => {
    const to = await run(which, { version });
    expect(paramsOf(to).get('error')).toBe(STALE_SENTENCE);
    expect(paramsOf(to).get('ok'), 'no success banner').toBeNull();
    expect(domainMock(), 'a refused submit reaches no write, so the row is unchanged and nothing is audited').not.toHaveBeenCalled();
  });

  it('control: a version present is forwarded as expectedVersion and the action reports success', async () => {
    const to = await run(which, { version: '1700000000000000' });
    expect(domainMock()).toHaveBeenCalledTimes(1);
    expect((domainMock().mock.calls[0]![2] as { expectedVersion?: string }).expectedVersion).toBe('1700000000000000');
    expect(paramsOf(to).get('error')).toBeNull();
    expect(paramsOf(to).get('ok')).not.toBeNull();
  });
});
