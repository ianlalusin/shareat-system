import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-582 - `/admin/pos-tablets` as cards (docs/tasks/582-pos-tablets-cards.md). Data layer mocked, markup asserted.
 * The approval lock lives on each tablet login's own card (linked or not); Register a tablet and Add a cash register are behind FormModal
 * buttons, never an always-open form; a lock is a word plus a padlock, never colour alone.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { view: Record<string, unknown>; tills: Record<string, unknown> } = { view: {}, tills: {} };

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/pos-tablets',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error('notFound'); },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/lib/flash', () => ({ withFlash: vi.fn(async (p: Promise<unknown>) => p), redirectWithFlash: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({ requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'admin-1' }, refusal: null })) }));
vi.mock('../src/app/staff/lib', async () => ({ staffStoresFor: vi.fn(async () => [STORE]) }));
vi.mock('../src/app/admin/pos-tablets/actions', () => ({ registerTabletAction: vi.fn(), revokeTabletAction: vi.fn(), clearLockAction: vi.fn(), createTillAction: vi.fn(), linkTillAction: vi.fn(), setTillPrinterAction: vi.fn(), savePresetAction: vi.fn(), retirePresetAction: vi.fn() }));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return { ...actual, loadPosTablets: vi.fn(async () => H.view), loadTills: vi.fn(async () => H.tills), loadCopyStores: vi.fn(async () => null), loadDiscounts: vi.fn(async () => ({ presets: [], canManage: false })) };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function render(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}

const link = {
  id: 'link-1', terminalNo: 1, deviceId: '5561b32b-3c27-42a4-b80a-193f3d0abeda', terminalPersonId: 'term-1', terminalPersonName: 'Terminal Lipa',
  createdAt: new Date('2026-11-01T01:00:00Z'), createdByName: 'Admin', revokedAt: null, revokedByName: null,
};
const login = (personId: string, displayName: string, capped: boolean) => ({ personId, displayName, capped, cappedAt: capped ? new Date('2026-11-01T02:00:00Z') : null });
const cards = (html: string): string[] => html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? [];
const outsideDialogs = (html: string): string => html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');

beforeEach(() => {
  H.tills = { terminals: [], freePairings: [] };
  H.view = { active: link, revoked: [], terminals: [login('term-1', 'Terminal Lipa', false), login('term-2', 'Terminal Spare', false)] };
});

describe('T-582 the lock sits on each tablet login card', () => {
  it('a locked LINKED tablet: Approvals locked, its lock line and its own Clear the lock inside its card', async () => {
    H.view = { active: link, revoked: [], terminals: [login('term-1', 'Terminal Lipa', true), login('term-2', 'Terminal Spare', false)] };
    const html = await render();
    const linked = cards(html).find((c) => c.includes('data-active-link'))!;
    expect(linked).toContain('Terminal 1');
    expect(linked).toContain('Approvals locked');
    expect(linked).toContain('data-locked');
    expect(linked).toMatch(/Locked since/);
    expect(linked.match(/Clear the lock/g)).toHaveLength(1);
    expect(linked).toMatch(/name="personId"[^>]*value="term-1"/);
    expect(linked).toContain('<svg'); // the padlock: a word AND an icon, never colour alone
    expect(html.match(/Clear the lock/g)).toHaveLength(1);
  });

  it('a locked login with NO linked tablet keeps its Clear the lock, in its own card', async () => {
    H.view = { active: null, revoked: [], terminals: [login('term-2', 'Terminal Spare', true)] };
    const html = await render();
    const own = cards(html).find((c) => c.includes('Terminal Spare'))!;
    expect(own).toContain('No tablet is linked to this login.');
    expect(own).toContain('Approvals locked');
    expect(own).toContain('data-locked');
    expect(own.match(/Clear the lock/g)).toHaveLength(1);
    expect(own).toMatch(/name="personId"[^>]*value="term-2"/);
    expect(html).toContain('No tablet is linked to SharEat Lipa yet.');
  });

  it('an unlinked login beside a linked tablet gets its own card; unlocked reads Approvals ready and has no Clear the lock', async () => {
    const html = await render();
    const all = cards(html);
    expect(all.find((c) => c.includes('data-active-link'))).toContain('Approvals ready');
    const own = all.find((c) => c.includes('Terminal Spare'))!;
    expect(own).toContain('Approvals ready');
    expect(html).not.toContain('Clear the lock');
    expect(html).not.toContain('data-locked');
  });

  it('the linked card carries its tablet tail, who it signs in as, and Revoke', async () => {
    const linked = cards(await render()).find((c) => c.includes('data-active-link'))!;
    expect(linked).toContain('...beda');
    expect(linked).toContain('Signs in as');
    expect(linked).toContain('Terminal Lipa');
    expect(linked).toContain('Revoke tablet link');
  });

  it('the Approval lock section and the Linked tablets section are gone; the muted line says what the lock is', async () => {
    const html = await render();
    expect(html).not.toContain('>Approval lock<');
    expect(html).not.toContain('Linked tablets');
    expect(html).toMatch(/Five wrong manager PINs in a day lock a tablet.{1,8}s refund approvals\. The lock lifts by itself after 24 hours\./);
  });

  it('no linked tablet and no login: one empty card with the instruction', async () => {
    H.view = { active: null, revoked: [], terminals: [] };
    const html = await render();
    expect(outsideDialogs(html).match(/data-no-terminal/g)).toHaveLength(1); // the page card; the Register modal repeats the instruction
  });
});

describe('T-582 forms are behind modal buttons', () => {
  it('Register a tablet and Add a cash register are FormModal triggers; no form field is on the page outside a dialog', async () => {
    const html = await render();
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Register tablet<\/button>/); // T-589 B4a: a primary trigger shows its words
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>(?:<[^>]+>)*Add cash register<\/button>/); // T-589 B4a: a primary trigger shows its words
    expect(html).toContain('Register a tablet');
    expect(html).toContain('Add a cash register');
    const open = outsideDialogs(html);
    expect(open).not.toContain('name="deviceId"');
    expect(open).not.toContain('name="terminalNo"');
    expect(html).toContain('name="deviceId"'); // inside the dialog, mounted
  });

  it('with no tablet login the Register modal holds the instruction instead of the form', async () => {
    H.view = { active: null, revoked: [], terminals: [] };
    const html = await render();
    expect(html).not.toContain('name="deviceId"');
    expect(html).toMatch(/system administrator/);
  });
});

describe('T-582 cash registers say cash register, as cards', () => {
  it('words a person reads', async () => {
    H.tills = { terminals: [{ id: 'till-1', terminalNo: 1, pairingId: null, pairingLabel: null, receiptPaperMm: 58, receiptCopies: 1 }], freePairings: [] };
    const html = await render();
    const s = html.slice(html.indexOf('data-tills') + 'data-tills'.length); // the data-tills hook is a code name and stays
    expect(s).toContain('Cash register 1');
    expect(s).toContain('No tablet');
    expect(s).toContain('aria-label="Tablet for cash register 1"');
    expect(s).toContain('Cash register number (1 to 99)');
    expect(s.replace(/<[^>]*>/g, ' ')).not.toMatch(/\btills?\b/i); // words only: ids like till-1 are code
    expect(s.match(/aria-label="[^"]*"/g)!.join(' ')).not.toMatch(/\btills?\b/i);
  });
});
