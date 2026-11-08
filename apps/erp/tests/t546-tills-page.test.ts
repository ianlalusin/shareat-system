import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-546 R4 (TESTER, written FIRST) - the Tills section of `/admin/pos-tablets`. docs/tasks/546-pos-terminal-printer-settings.md R4, R5 "Screen".
 * Data layer mocked, markup asserted. ASSUMED API:
 *   apps/erp/src/app/admin/pos-tablets/lib.ts   loadTills(actor, storeId) -> { terminals: [{ id, terminalNo, pairingId, pairingLabel, receiptPaperMm, receiptCopies }], freePairings: [{ id, label }] }
 *   apps/erp/src/app/admin/pos-tablets/actions.ts   createTillAction, linkTillAction, setTillPrinterAction (form actions; the integration file runs them for real)
 * The section (`data-tills`) sits under the existing pairings list; a person without the capability still gets the refusal, not the page.
 */
const STORE = { id: 'store-1', name: 'SharEat Lipa', code: 'LIPA' };
const H: { allowed: boolean; tills: Record<string, unknown>; calls: number } = { allowed: true, tills: {}, calls: 0 };

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
vi.mock('../src/app/admin/pos-tablets/actions', () => ({
  registerTabletAction: vi.fn(), revokeTabletAction: vi.fn(), clearLockAction: vi.fn(), createTillAction: vi.fn(), linkTillAction: vi.fn(), setTillPrinterAction: vi.fn(),
}));
vi.mock('../src/app/admin/pos-tablets/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/admin/pos-tablets/lib')>();
  return {
    ...actual,
    loadPosTablets: vi.fn(async () => ({ active: null, revoked: [], terminals: [] })),
    loadTills: vi.fn(async () => {
      H.calls += 1;
      return H.tills;
    }),
  };
});

beforeAll(async () => {
  await import('../src/app/admin/pos-tablets/page');
}, 120_000);

async function render(): Promise<string> {
  const Page = (await import('../src/app/admin/pos-tablets/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
}
const till = (over: Record<string, unknown> = {}) => ({ id: 'till-1', terminalNo: 1, pairingId: 'pair-1', pairingLabel: 'Counter tablet', receiptPaperMm: 58, receiptCopies: 1, ...over });
const tillsSection = (html: string): string => {
  const i = html.indexOf('data-tills');
  expect(i, 'the Tills section is on the page').toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</section>', i));
};

beforeEach(() => {
  H.allowed = true;
  H.calls = 0;
  H.tills = { terminals: [till(), till({ id: 'till-2', terminalNo: 2, pairingId: null, pairingLabel: null, receiptPaperMm: 80, receiptCopies: 2 })], freePairings: [{ id: 'pair-9', label: 'Spare tablet' }] };
});

describe('R4 the Tills section', () => {
  it('sits under the pairings list, titled Tills, with the columns Till, Tablet, Paper and Copies', async () => {
    const html = await render();
    expect(html.indexOf('data-tills'), 'after "Linked tablets"').toBeGreaterThan(html.indexOf('Linked tablets'));
    const s = tillsSection(html);
    expect(s).toMatch(/Tills/);
    for (const col of ['Till', 'Tablet', 'Paper', 'Copies']) expect(s, col).toMatch(new RegExp(`<th[^>]*>${col}</th>`));
  });

  it('one row per till, in number order, naming its tablet or saying there is none', async () => {
    const s = tillsSection(await render());
    expect(s.indexOf('Till 1')).toBeGreaterThan(-1);
    expect(s.indexOf('Till 2')).toBeGreaterThan(s.indexOf('Till 1'));
    expect(s).toContain('Counter tablet');
    expect(s).toContain('No tablet');
  });

  it('Add till: a number input from 1 to 99 defaulting to the next free number (the first gap)', async () => {
    H.tills = { terminals: [till({ terminalNo: 1 }), till({ id: 't2', terminalNo: 2, pairingId: null, pairingLabel: null }), till({ id: 't4', terminalNo: 4, pairingId: null, pairingLabel: null })], freePairings: [] };
    const s = tillsSection(await render());
    expect(s).toMatch(/name="terminalNo"/);
    const input = s.match(/<input[^>]*name="terminalNo"[^>]*>/)![0];
    // The range travels as the field RULE (POS_TILL_ADD_RULES: live check in the browser, the same rule on the server), as the register form's number does.
    expect(input).toMatch(/inputMode="numeric"/);
    expect(input).toMatch(/value="3"/);
    expect(s).toContain('(1 to 99)');
    expect(s).toContain('Add till');
  });

  it('Add till defaults to 1 when the store has no till', async () => {
    H.tills = { terminals: [], freePairings: [] };
    const s = tillsSection(await render());
    expect(s.match(/<input[^>]*name="terminalNo"[^>]*>/)![0]).toMatch(/value="1"/);
    expect(s).toMatch(/No till/i);
  });

  it('Choose tablet: a select of the free live tablets plus "No tablet"; a till\'s own tablet stays selectable and selected', async () => {
    const s = tillsSection(await render());
    const selects = s.match(/<select[^>]*name="pairingId"[\s\S]*?<\/select>/g)!;
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatch(/<option[^>]*value="pair-1"[^>]*selected[^>]*>Counter tablet/);
    expect(selects[0]).toContain('Spare tablet');
    expect(selects[0]).toMatch(/<option[^>]*value=""[^>]*>No tablet/);
    expect(selects[1]).toContain('Spare tablet');
    expect(selects[1]).not.toContain('Counter tablet');
    expect(selects[1]).toMatch(/<option[^>]*value=""[^>]*selected/);
  });

  it('Printer: paper is a 58 mm / 80 mm radio pair with the till\'s value checked; copies is 1 to 3 with the till\'s value selected', async () => {
    const s = tillsSection(await render());
    const row2 = s.slice(s.indexOf('Till 2'));
    const radios = row2.match(/<input[^>]*type="radio"[^>]*name="receiptPaperMm"[^>]*>/g)!;
    expect(radios.length).toBeGreaterThanOrEqual(2);
    expect(radios.find((r) => /value="80"/.test(r))).toMatch(/checked/);
    expect(radios.find((r) => /value="58"/.test(r))).not.toMatch(/checked/);
    expect(row2).toContain('58 mm');
    expect(row2).toContain('80 mm');
    const copies = row2.match(/<select[^>]*name="receiptCopies"[\s\S]*?<\/select>/)![0];
    expect([...copies.matchAll(/<option[^>]*value="(\d)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(copies).toMatch(/<option[^>]*value="2"[^>]*selected/);
  });

  it('every till form names its store and its till (hidden ids the action re-checks on the server)', async () => {
    const s = tillsSection(await render());
    expect(s.match(/name="storeId"/g)!.length).toBeGreaterThanOrEqual(3);
    expect(s).toMatch(/name="terminalId"[^>]*value="till-1"/);
    expect(s).toMatch(/name="terminalId"[^>]*value="till-2"/);
  });

  it('says there is one tablet per store, and how to replace it; its forms return to /admin/pos-tablets', async () => {
    const s = tillsSection(await render());
    expect(s).toContain('One tablet per store. To replace it, un-pair the old tablet first.');
    expect(s).toMatch(/name="returnTo"[^>]*value="\/admin\/pos-tablets"/);
  });

  it('no Delete: a till is never deleted', async () => {
    expect(tillsSection(await render())).not.toMatch(/delete|remove/i);
  });
});

describe('R4 the gate', () => {
  it('a person without the capability gets the refusal and nothing is loaded', async () => {
    H.allowed = false;
    expect(await render()).toBe('REFUSED');
    expect(H.calls).toBe(0);
  });
});
