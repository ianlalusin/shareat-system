import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-387 S7 - `/staff`: ID card wall (default) plus live roster. Data layer mocked, markup asserted.
 *
 * PINNED HOOKS (the builder must emit these; docs/design/t387 has the looks, not the hooks):
 *  - cards view container `data-view="cards"`, roster container `data-view="roster"`; only the chosen one renders
 *  - a segmented control: links whose hrefs contain `view=cards` and `view=roster`, the active one `aria-current="page"`
 *  - one `data-staff-card` per person (cards view); a live chip `data-live-state="on|break|off"` per person only for a viewer
 *    who holds manage_attendance at the store (no chip, and no `data-live-state` anywhere, otherwise)
 *  - photo `<img src="/files/<fileId>"`; without a viewable photo, the initials of the display name
 *  - Hire: the link to /staff/hire, primary styled (`bg-brand`), above the wall; the Positions card also above the wall
 *  - no schedule band anywhere (t387-q6 = a)
 * Data seams mocked: lib `rosterForStore`/`positionsForStore`, `listStores`/`withOrgPrincipal`,
 * `employmentRepo.photoFileIds`, `todayStateFor`, `canViewPhoto`, `authorize`.
 */
import { AuthorizationError } from '@shareat/auth';

const ORG = 'org-1';
const STORE = 'store-1';
const PERSON = {
  ana: { id: 'emp-ana', name: 'Ana Reyes', file: 'file-ana' },
  ben: { id: 'emp-ben', name: 'Ben Cruz', file: null as string | null },
  cia: { id: 'emp-cia', name: 'Cia Lim', file: 'file-cia-denied' },
};

const H: {
  caps: Set<string>;
  states: Record<string, { state: 'on' | 'break' | 'off'; since?: Date }>;
  viewable: Set<string>;
} = { caps: new Set(), states: {}, viewable: new Set() };

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'viewer-1' })),
  requireSession: vi.fn(async () => ({
    actor: { orgId: 'org-1', personId: 'viewer-1' },
    sessionId: 's1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/staff/actions', () => ({ upsertStorePositionAction: vi.fn() }));
vi.mock('../src/app/staff/PinSignInPanel', () => ({ PinSignInPanel: () => null }));

vi.mock('../src/app/expenses/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/expenses/lib')>();
  return {
    ...actual,
    listStores: vi.fn(async () => [{ id: 'store-1', name: 'Rizal Branch', code: 'RZL' }]),
    withOrgPrincipal: vi.fn(async (_org: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});
vi.mock('../src/app/staff/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/staff/lib')>();
  const row = (p: { id: string; name: string }, startedOn: string, status: string, pos: string) => ({
    id: p.id,
    personId: `person-${p.id}`,
    staffCode: `C-${p.id}`,
    displayName: p.name,
    employmentStatus: status,
    startedOn,
    positions: [{ positionId: `pos-${pos}`, name: pos, isPrimary: true }],
  });
  return {
    ...actual,
    rosterForStore: vi.fn(async () => [
      row(PERSON.ana, '2026-07-11', 'regular', 'Cashier'),
      row(PERSON.ben, '2026-09-27', 'probationary', 'Cook'),
      row(PERSON.cia, '2025-08-11', 'regular', 'Server'),
    ]),
    positionsForStore: vi.fn(async () => [{ id: 'pos-Cashier', name: 'Cashier', isCanonical: true }]),
  };
});
vi.mock('@shareat/auth', async (orig) => {
  const actual = await orig<typeof import('@shareat/auth')>();
  return {
    ...actual,
    authorize: vi.fn(async (_tx: unknown, _actor: unknown, cap: string) => {
      if (!H.caps.has(cap)) throw new actual.AuthorizationError(`no ${cap}`, cap as never);
    }),
    // T-402 S2: render probes use the non-logging can() - same capability set, boolean answer.
    can: vi.fn(async (_tx: unknown, _actor: unknown, cap: string) => H.caps.has(cap)),
  };
});
vi.mock('@shareat/db', async (orig) => {
  const actual = await orig<typeof import('@shareat/db')>();
  return {
    ...actual,
    pinAttemptsRepo: { ...actual.pinAttemptsRepo, statusForStore: vi.fn(async () => ({ locked: [], attempts: [] })) },
    employmentRepo: {
      ...actual.employmentRepo,
      photoFileIds: vi.fn(async (_tx: unknown, ids: string[]) => {
        const files: Record<string, string | null> = {
          [PERSON.ana.id]: PERSON.ana.file,
          [PERSON.ben.id]: PERSON.ben.file,
          [PERSON.cia.id]: PERSON.cia.file,
        };
        return new Map(ids.map((i) => [i, files[i] ?? null]));
      }),
    },
  };
});
vi.mock('@shareat/domain', async (orig) => {
  const actual = await orig<typeof import('@shareat/domain')>();
  return {
    ...actual,
    todayStateFor: vi.fn(async () => {
      if (!H.caps.has('manage_attendance')) throw new AuthorizationError('no manage_attendance', 'manage_attendance' as never);
      return H.states;
    }),
  };
});
// T-435: /staff is read-gated by requirePageAccess (enrol_staff OR manage_attendance); the gate itself is proven in t435-s3-staff.test.ts.
vi.mock('../src/lib/page-access', async () => ({
  requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'viewer-1' }, refusal: H.caps.has('enrol_staff') || H.caps.has('manage_attendance') ? null : 'REFUSED' })),
  StoreNotAvailable: () => 'NOT_AVAILABLE',
}));
// T-435: the picker's store list comes from heldStoresFor (the real scopedStores needs a database); its rule is proven in t435-s3-staff.test.ts.
vi.mock('../src/lib/held-stores', () => ({
  heldStoresFor: vi.fn(async () => [{ id: 'store-1', name: 'Rizal Branch', code: 'RZL' }]),
}));
vi.mock('../src/lib/photo-link', () => ({
  canViewPhoto: vi.fn(async (_actor: unknown, fileId: string | null) => !!fileId && H.viewable.has(fileId)),
}));

// Warm the page's import graph once (cold it takes 5-7s, past the unit project's 5s default).
beforeAll(async () => {
  await import('../src/app/staff/page');
}, 30_000);

async function render(sp: Record<string, string> = {}): Promise<string> {
  const Page = (await import('../src/app/staff/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(sp) })) as never);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T04:00:00Z'));
  H.caps = new Set(['manage_attendance']);
  H.viewable = new Set(['file-ana']);
  H.states = {
    [PERSON.ana.id]: { state: 'on', since: new Date('2026-10-11T00:00:00Z') },
    [PERSON.ben.id]: { state: 'break', since: new Date('2026-10-11T03:00:00Z') },
    [PERSON.cia.id]: { state: 'off' },
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('T-435 - /staff reads through the gate and the Actor-taking loader', () => {
  it('a viewer with neither capability gets the refusal and no roster', async () => {
    H.caps = new Set();
    const html = await render();
    expect(html).not.toContain('Ana Reyes');
  });

  it('rosterForStore is called with the full Actor first, then the store', async () => {
    const lib = await import('../src/app/staff/lib');
    await render();
    const call = (lib.rosterForStore as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    expect(call[0]).toMatchObject({ orgId: 'org-1', personId: 'viewer-1' });
    expect(call[1]).toBe('store-1');
  });
});

describe('T-387 S7 - /staff views', () => {
  it('the default view is the card wall', async () => {
    const html = await render();
    expect(html).toContain('data-view="cards"');
    expect(html).not.toContain('data-view="roster"');
  });

  it('?view=cards is the same wall; ?view=roster is the roster and not the wall', async () => {
    expect(await render({ view: 'cards' })).toContain('data-view="cards"');
    const html = await render({ view: 'roster' });
    expect(html).toContain('data-view="roster"');
    expect(html).not.toContain('data-view="cards"');
  });

  it('a segmented control links both views, the active one marked', async () => {
    const cards = await render();
    expect(cards).toMatch(/href="[^"]*view=cards[^"]*"/);
    expect(cards).toMatch(/href="[^"]*view=roster[^"]*"/);
    expect(cards).toMatch(/<a[^>]*view=cards[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*view=cards/);
    const roster = await render({ view: 'roster' });
    expect(roster).toMatch(/<a[^>]*view=roster[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*view=roster/);
  });

  it('Hire is the primary action, above the wall; the positions card sits above the wall too, in both views', async () => {
    for (const sp of [{}, { view: 'roster' }] as Record<string, string>[]) {
      const html = await render(sp);
      const hire = html.search(/<a[^>]*href="\/staff\/hire[^"]*"[^>]*>/);
      expect(hire).toBeGreaterThanOrEqual(0);
      expect(html.match(/<a[^>]*href="\/staff\/hire[^"]*"[^>]*>/)![0]).toContain('bg-brand');
      const view = html.search(/data-view="(cards|roster)"/);
      const positions = html.indexOf('Positions</h2>');
      expect(positions).toBeGreaterThanOrEqual(0);
      expect(hire).toBeLessThan(view);
      expect(positions).toBeLessThan(view);
    }
  });
});

describe('T-387 S7 - a card', () => {
  it('shows name, primary position, store, tenure and employment status', async () => {
    const html = await render();
    expect((html.match(/data-staff-card/g) ?? []).length).toBe(3);
    expect(html).toContain('Ana Reyes');
    expect(html).toContain('Cashier');
    expect(html).toContain('Rizal Branch');
    expect(html).toContain('3 mo'); // 2026-07-11 -> 2026-10-11
    expect(html).toContain('2 wk'); // 2026-09-27
    expect(html).toContain('1 yr 2 mo'); // 2025-08-11
    expect(html).toMatch(/probationary/i);
    expect(html).toMatch(/regular/i);
  });

  it('the photo is an <img> through /files/<id> only when canViewPhoto is true; otherwise initials', async () => {
    const html = await render();
    expect(html).toContain('<img');
    expect(html).toMatch(/<img[^>]*src="\/files\/file-ana"/);
    // Cia has a file the viewer may not see: no image, no id in the markup, initials instead.
    expect(html).not.toContain('file-cia-denied');
    expect(html).toContain('CL');
    // Ben has no photo at all: initials.
    expect(html).toContain('BC');
    expect((html.match(/<img/g) ?? []).length).toBe(1);
  });

  it('shows a live chip per person for a viewer with manage_attendance', async () => {
    const html = await render();
    expect(html).toContain('data-live-state="on"');
    expect(html).toContain('data-live-state="break"');
    expect(html).toContain('data-live-state="off"');
  });

  it('GATE x: with enrol_staff but without manage_attendance no chip renders (and the page still renders)', async () => {
    H.caps = new Set(['enrol_staff']);
    const html = await render();
    expect(html).toContain('Ana Reyes');
    expect(html).not.toContain('data-live-state');
    const roster = await render({ view: 'roster' });
    expect(roster).toContain('Ana Reyes');
    expect(roster).not.toContain('data-live-state');
  });

  it('the roster view carries the live chip too, and no schedule band in either view', async () => {
    const roster = await render({ view: 'roster' });
    expect(roster).toContain('data-live-state="break"');
    for (const html of [roster, await render()]) {
      expect(html).not.toMatch(/scheduled|data-schedule|schedule band/i);
    }
  });
});
