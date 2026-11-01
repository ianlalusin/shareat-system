import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-505 - `/admin/pos-tablets` (docs/tasks/505-erp-pos-tablet-links.md, tests P8 and P9). Data layer mocked, markup asserted.
 * P8: the route is mapped to `provision_clock_terminal`, sits in the Setup group right after "Clock terminals", and a person without the
 *     capability gets the refusal, not the page. P9: a store with no terminal person says what to do next and shows no register form.
 * Also pinned: a locked tablet shows "Locked since" and one Clear button; an unlocked one shows "Not locked."; a store that already has an
 * active link warns "This replaces the tablet ending ...".
 */
import { ROUTE_CAPABILITY, capabilityForRoute } from '../src/lib/route-capability';
import { GROUPS } from '../src/components/nav';

const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { allowed: boolean; view: Record<string, unknown> } = { allowed: true, view: {} };

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/lib/flash', () => ({ withFlash: vi.fn(async (p: Promise<unknown>) => p), redirectWithFlash: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'admin-1' }, refusal: H.allowed ? null : 'REFUSED' })),
}));
vi.mock('../src/app/staff/lib', async () => ({ staffStoresFor: vi.fn(async () => [STORE]) }));
vi.mock('../src/app/admin/pos-tablets/actions', () => ({ registerTabletAction: vi.fn(), revokeTabletAction: vi.fn(), clearLockAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return { ...actual, loadPosTablets: vi.fn(async () => H.view) };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 30_000);

async function render(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}

const link = (over: Record<string, unknown> = {}) => ({
  id: 'link-1', terminalNo: 1, deviceId: '5561b32b-3c27-42a4-b80a-193f3d0abeda', terminalPersonId: 'term-1', terminalPersonName: 'Terminal Lipa',
  createdAt: new Date('2026-11-01T01:00:00Z'), createdByName: 'Admin', revokedAt: null, revokedByName: null, ...over,
});

beforeEach(() => {
  H.allowed = true;
  H.view = { active: null, revoked: [], terminals: [{ personId: 'term-1', displayName: 'Terminal Lipa', capped: false, cappedAt: null }] };
});

describe('P8 - the route is mapped, in the nav, and gated', () => {
  it('maps /admin/pos-tablets to provision_clock_terminal', () => {
    expect(ROUTE_CAPABILITY['/admin/pos-tablets']).toBe('provision_clock_terminal');
    expect(capabilityForRoute('/admin/pos-tablets')).toBe('provision_clock_terminal');
  });

  it('is in the Setup group, right after "Clock terminals", labelled "POS tablets"', () => {
    const group = GROUPS.find((g) => g.links.some((l) => l.href === '/attendance/terminals'))!;
    const i = group.links.findIndex((l) => l.href === '/attendance/terminals');
    expect(group.links[i + 1]).toEqual({ href: '/admin/pos-tablets', label: 'POS tablets' });
  });

  it('a person without the capability gets the refusal, not the page', async () => {
    H.allowed = false;
    expect(await render()).toBe('REFUSED');
  });
});

describe('P9 and the page states', () => {
  it('P9: no terminal person -> the next-step sentence and no register form', async () => {
    H.view = { active: null, revoked: [], terminals: [] };
    const html = await render();
    expect(html).toContain('data-no-terminal');
    expect(html).toMatch(/Firebase console/);
    expect(html).not.toContain('name="deviceId"');
    expect(html).not.toContain('Register tablet');
  });

  it('a locked tablet shows "Locked since" and one Clear the lock button; an unlocked one shows "Not locked."', async () => {
    H.view = { active: null, revoked: [], terminals: [{ personId: 'term-1', displayName: 'Terminal Lipa', capped: true, cappedAt: new Date('2026-11-01T02:00:00Z') }] };
    const locked = await render();
    expect(locked).toMatch(/Locked since/);
    expect(locked.match(/Clear the lock/g)).toHaveLength(1);
    H.view = { active: null, revoked: [], terminals: [{ personId: 'term-1', displayName: 'Terminal Lipa', capped: false, cappedAt: null }] };
    const free = await render();
    expect(free).toContain('Not locked.');
    expect(free).not.toContain('Clear the lock');
  });

  it('an active link is named by its last four characters, offers Revoke, and the register form warns it replaces that tablet', async () => {
    H.view = { active: link(), revoked: [link({ id: 'link-0', deviceId: '11111111-1111-4111-8111-1111111111aa', revokedAt: new Date('2026-10-31T00:00:00Z'), revokedByName: 'Admin' })], terminals: [{ personId: 'term-1', displayName: 'Terminal Lipa', capped: false, cappedAt: null }] };
    const html = await render();
    expect(html).toContain('...beda');
    expect(html).toContain('Revoke tablet link');
    expect(html).toMatch(/This replaces the tablet ending \.\.\.beda/);
    expect(html).toContain('Earlier tablets (1)');
    expect(html).not.toContain('5561b32b-3c27-42a4-b80a-193f3d0abeda</span>');
  });

  it('with no active link there is no Revoke button and no replace warning', async () => {
    const html = await render();
    expect(html).not.toContain('Revoke tablet link');
    expect(html).not.toContain('This replaces');
    expect(html).toContain('Register tablet');
  });
});
