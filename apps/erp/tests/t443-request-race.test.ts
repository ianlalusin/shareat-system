import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), allowed: vi.fn(), find: vi.fn() }));
vi.mock('@shareat/domain', async (original) => ({ ...await original<typeof import('@shareat/domain')>(), requestItem: mocks.request }));
vi.mock('@shareat/db', async (original) => {
  const actual = await original<typeof import('@shareat/db')>();
  return { ...actual, itemsRepo: { ...actual.itemsRepo, findOpenRequestByName: mocks.find } };
});
vi.mock('@shareat/auth', async (original) => ({ ...await original<typeof import('@shareat/auth')>(), can: mocks.allowed }));
vi.mock('../src/lib/session', () => ({ requireActor: async () => ({ orgId: 'org-ui', personId: 'person-ui' }) }));
vi.mock('../src/app/items/lib', () => ({ withOrgPrincipal: async (_org: string, fn: (tx: object) => unknown) => fn({}) }));
vi.mock('@/lib/flash', () => ({ redirectWithFlash: async (_path: string, _params: object, flash: object) => { throw Object.assign(new Error('redirect'), { flash }); } }));
import { requestItemAction } from '../src/app/items/actions';
import { CONSTRAINT_MESSAGES, errorMessage } from '../src/lib/constraint-messages';

const wrappedDuplicate = () => new Error('Failed query: insert into item_requests\nparams: private values', {
  cause: Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'item_requests_open_name_key' }),
});
const form = () => { const f = new FormData(); f.set('name', '  Fresh   basil  '); return f; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.allowed.mockResolvedValue(true);
  mocks.request.mockRejectedValue(wrappedDuplicate());
  mocks.find.mockResolvedValue({ name: 'Fresh basil', requestedByName: 'Alex', requestedAt: new Date('2026-10-18T02:00:00Z') });
});

describe('T-443 request race at the action boundary', () => {
  it('after a duplicate race rolls back, names the winning requester and date using a fresh authorised read', async () => {
    await expect(requestItemAction(form())).rejects.toMatchObject({ flash: { error: 'Alex already asked for "Fresh basil" on Oct 18, 2026; it is waiting for a super-admin.' } });
    expect(mocks.find).toHaveBeenCalledWith(expect.anything(), 'org-ui', 'Fresh basil');
  });
  it('does not reveal the requester when permission was removed before the fresh read', async () => {
    mocks.allowed.mockResolvedValue(false);
    await expect(requestItemAction(form())).rejects.toMatchObject({ flash: { error: CONSTRAINT_MESSAGES.item_requests_open_name_key } });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('a cyclic error cause cannot hang the refusal mapper', () => {
    const err: Error & { cause?: unknown } = new Error('Broken request');
    err.cause = err;
    expect(errorMessage(err)).toBe('Broken request');
  });
  it('maps wrapped family-trigger errors to their sentence instead of showing a query dump', () => {
    const err = new Error('Failed query: update items\nparams: private values', {
      cause: Object.assign(new Error('shape refused'), { code: '23514', constraint_name: 'items_variant_guard' }),
    });
    expect(errorMessage(err)).toBe(CONSTRAINT_MESSAGES.items_variant_guard);
  });
});
