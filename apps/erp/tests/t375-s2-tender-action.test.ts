/**
 * T-375 S2 (RED-3) - `createTenderAction`: a Kind of Cash with a money account chosen must be REFUSED in words, never
 * silently stored without the account. `docs/tasks/375-pos-v1-day-feed.md` S2.
 *
 * TESTER, not BUILDER. The DOMAIN's `createTender` is mocked with a stand-in that applies the domain's own rule
 * (a cash tender with an account refuses with its sentence), so the legs differ only in what the ACTION hands over:
 *   Cash + account chosen  -> redirect carries the error and no "Tender added."
 *                             (red when the action drops the account and calls the domain with null: it then reports ok)
 *   Cash + no account      -> positive control: creates, the domain receives a null account.
 *   Wallet + account       -> positive control: the domain receives the account.
 * Harness: `t376-s1-verify-action-drop.test.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'actor-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
vi.mock('../src/app/settings/pos-link/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/settings/pos-link/lib')>();
  return { ...actual, withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}) };
});

type Input = { kind: string; moneyAccountId?: string | null };
const createTenderMock = vi.fn(async (_tx: unknown, _actor: unknown, input: Input) => {
  if (input.kind === 'cash' && input.moneyAccountId) {
    const { refuse } = await import('../../../packages/domain/src/shared/refusal');
    throw refuse('tenders: cash tender with a money account', 'A cash tender has no money account.');
  }
  return { id: 'tender-1' };
});
// 2026-10-09 (T-384 S1b): the ok sentence now names the tender, read back from the DB (R7). This file has no database
// (tx is `{}`), so the repo read-back is stood in for: it answers with the name the stand-in "saved".
vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  const row = { id: 'tender-1', name: 'Cash', kind: 'cash', isActive: true, posV1Alias: 'Cash', moneyAccountId: null, version: '1' };
  return { ...actual, posV1Repo: { ...actual.posV1Repo, getTenderById: async () => row, getTenderByIdForUpdate: async () => row } };
});
vi.mock('@shareat/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/domain')>();
  return { ...actual, createTender: (...a: unknown[]) => createTenderMock(...(a as [unknown, unknown, Input])) };
});

beforeAll(async () => {
  await import('../src/app/settings/pos-link/actions');
}, 120_000);
beforeEach(() => {
  createTenderMock.mockClear();
});

async function submit(fields: Record<string, string>): Promise<string> {
  const fd = new FormData();
  fd.set('storeId', 'store-1');
  fd.set('name', 'Cash');
  fd.set('posV1Alias', 'Cash');
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const { createTenderAction } = await import('../src/app/settings/pos-link/actions');
  try {
    await createTenderAction(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);

describe('RED-3 - createTenderAction never silently drops a chosen money account', () => {
  it('Kind=Cash with a money account chosen -> an error sentence, no success banner', async () => {
    const to = await submit({ kind: 'cash', moneyAccountId: 'acct-1' });
    expect(param(to, 'ok'), 'must not report success when the chosen account was discarded').toBeNull();
    expect(param(to, 'error')).toBe('A cash tender has no money account.');
  });

  it('control: Kind=Cash with no account creates, handing the domain a null account', async () => {
    const to = await submit({ kind: 'cash', moneyAccountId: '' });
    expect(param(to, 'error')).toBeNull();
    expect(param(to, 'ok')).toBe('Cash added.'); // 2026-10-09 (T-384 S1b R7): was 'Tender added.'
    expect(createTenderMock.mock.calls[0]![2].moneyAccountId ?? null).toBeNull();
  });

  it('control: Kind=Wallet hands the chosen account to the domain', async () => {
    const to = await submit({ kind: 'wallet', moneyAccountId: 'acct-1' });
    expect(param(to, 'ok')).toBe('Cash added.'); // 2026-10-09 (T-384 S1b R7): was 'Tender added.'
    expect(createTenderMock.mock.calls[0]![2].moneyAccountId).toBe('acct-1');
  });
});

// 2026-10-09 (T-384 S1b R4, W1): Kind is chosen, never defaulted. The action hands the domain the RAW kind; a blank is the
// domain's to refuse (the stand-in applies the domain's own unknown-kind rule).
describe('R4 - createTenderAction decides no kind', () => {
  it('a blank kind reaches the domain as "" and the redirect carries the domain sentence, no success banner', async () => {
    createTenderMock.mockImplementationOnce(async (_tx, _actor, input) => {
      if (input.kind !== 'cash' && input.kind !== 'wallet') {
        const { refuse } = await import('../../../packages/domain/src/shared/refusal');
        throw refuse('tenders: unknown kind', 'Choose whether this tender is cash or a wallet.');
      }
      return { id: 'tender-1' };
    });
    const to = await submit({ kind: '', moneyAccountId: '' });
    expect(createTenderMock.mock.calls[0]![2].kind, 'the action did not turn a blank into cash').toBe('');
    expect(param(to, 'ok')).toBeNull();
    expect(param(to, 'error')).toBe('Choose whether this tender is cash or a wallet.');
  });
});
