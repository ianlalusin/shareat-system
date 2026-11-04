/** T-508 S4 - the `menu.forDevice` wiring: link-resolving loader only, inside withOrgPrincipal(orgId); never loadStoreMenu. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const ORG = 'org-1';
const input = { posStoreId: 'pos-store-1', deviceId: 'dev-1' };

async function build(loadMenuForTerminal: (...a: never[]) => Promise<unknown>) {
  const { makeMenuForDevice } = await import('@/server/pos2/menu');
  const calls: string[] = [];
  const loadStoreMenu = vi.fn();
  const forDevice = makeMenuForDevice({
    orgId: ORG,
    withOrgPrincipal: async (orgId, fn) => { calls.push(`principal:${orgId}`); return fn('TX'); },
    loadMenuForTerminal: ((...a: never[]) => { calls.push('terminal'); return loadMenuForTerminal(...a); }) as never,
    isAuthError: (e) => e instanceof Error && e.name === 'AuthenticationError',
  });
  return { forDevice, calls, loadStoreMenu };
}

describe('makeMenuForDevice', () => {
  it('calls loadMenuForTerminal(tx, orgId, {posStoreId, deviceId}) inside withOrgPrincipal(orgId), never loadStoreMenu', async () => {
    const load = vi.fn(async () => 'MENU');
    const { forDevice, calls, loadStoreMenu } = await build(load);
    expect(await forDevice(input)).toBe('MENU');
    expect(load).toHaveBeenCalledWith('TX', ORG, input);
    expect(calls).toEqual(['principal:org-1', 'terminal']);
    expect(loadStoreMenu).not.toHaveBeenCalled();
  });
  it('an authentication refusal (no link) is null; other errors propagate', async () => {
    const authErr = Object.assign(new Error('x'), { name: 'AuthenticationError' });
    expect(await (await build(async () => { throw authErr; })).forDevice(input)).toBeNull();
    await expect((await build(async () => { throw new Error('boom'); })).forDevice(input)).rejects.toThrow('boom');
  });
});
