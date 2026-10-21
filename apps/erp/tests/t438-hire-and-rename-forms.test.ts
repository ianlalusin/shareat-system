import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-438 S2a/S2b screens (docs/tasks/438-hire-name-parts-and-staff-pin-only.md, "Smoke" steps 1 and 5). Data layer mocked, markup asserted.
 * Assumed field names: lastName, firstName, middleName, sameNameConfirmed (the last is the spec's). Assumed rename form: a form with
 * inputs named lastName / firstName / middleName on /staff/[employmentId], its action a function distinct from the others there.
 * RED today: the Hire page still renders the "Create new person named" radio (`value="new"`, `newDisplayName`) and no part boxes.
 */
const STORE = { id: 'store-1', name: 'Lipa', code: 'LIP' };

const H: { results: unknown[]; parts: { lastName: string | null; firstName: string | null; middleName: string | null }; display: string } = {
  results: [],
  parts: { lastName: null, firstName: null, middleName: null },
  display: 'Maria Dela Cruz Santos',
};

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
// Every real export becomes an inert function (the builder's rename action is unknown to this file, so no names are listed).
vi.mock('../src/app/staff/actions', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]));
});
vi.mock('../src/app/staff/PinSignInPanel', () => ({ PinSignInPanel: () => null }));
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'viewer-1' }, refusal: null })),
  StoreNotAvailable: () => 'NOT_AVAILABLE',
}));
vi.mock('../src/app/staff/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/staff/lib')>();
  const parts = () => H.parts;
  return {
    ...actual,
    staffStoresFor: vi.fn(async () => [STORE]),
    positionsForStore: vi.fn(async () => []),
    searchPersonsFor: vi.fn(async () => H.results),
    livePinFor: vi.fn(async () => null),
    otherOpenBranchesFor: vi.fn(async () => ({ branches: [], hiddenCount: 0 })),
    governmentIdsFor: vi.fn(async () => null),
    mediaFor: vi.fn(async () => ({ hasSignature: false, canViewSignature: false, photoFileId: null })),
    employmentDetail: vi.fn(async () => ({
      employment: { id: 'emp-1', personId: 'person-1', orgId: 'org-1', storeId: 'store-1', staffCode: 'SE-001', employmentStatus: 'regular', startedOn: '2026-01-01', endedOn: null },
      personName: H.display,
      // The loader "returns the parts" (spec); the key is not named there, so the common shapes are all supplied.
      nameParts: parts(),
      person: { displayName: H.display, ...parts() },
      ...parts(),
      storeName: 'Lipa',
      positions: [],
    })),
  };
});

beforeAll(async () => {
  await import('../src/app/staff/hire/page');
  await import('../src/app/staff/[employmentId]/page');
}, 60_000);
beforeEach(() => {
  H.results = [];
  H.parts = { lastName: null, firstName: null, middleName: null };
  H.display = 'Maria Dela Cruz Santos';
});

async function hirePage(sp: Record<string, string> = {}): Promise<string> {
  const Page = (await import('../src/app/staff/hire/page')).default;
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve(sp) })) as never);
}
async function detailPage(): Promise<string> {
  const Page = (await import('../src/app/staff/[employmentId]/page')).default;
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ employmentId: 'emp-1' }), searchParams: Promise.resolve({}) })) as never);
}
const inputTag = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];

describe('T-438 smoke 1 - the Hire screen asks for last / first / middle name', () => {
  it('has no "Create new person" radio and no single full-name box', async () => {
    // Kills: the old radio / newDisplayName box left in place beside the new boxes.
    const html = await hirePage();
    expect(html).not.toMatch(/Create new person/i);
    expect(html).not.toContain('name="newDisplayName"');
    expect(html).not.toMatch(/<input[^>]*name="personChoice"[^>]*value="new"/);
  });
  it('has Last, First and Middle boxes; middle is marked optional, last and first are not', async () => {
    const html = await hirePage();
    for (const n of ['lastName', 'firstName', 'middleName']) expect(inputTag(html, n), `${n} box`).toBeTruthy();
    expect(html).toMatch(/Last name/i);
    expect(html).toMatch(/First name/i);
    expect(html).toMatch(/Middle name[^<]*\(?optional/i);
    expect(html).not.toMatch(/Last name[^<]*optional/i);
    expect(html).not.toMatch(/First name[^<]*optional/i);
  });
  it('offers the "this is a different person with the same name" tick as sameNameConfirmed', async () => {
    // Kills: no way to override the duplicate refusal.
    const tag = inputTag(await hirePage(), 'sameNameConfirmed');
    expect(tag).toBeTruthy();
    expect(tag).toMatch(/type="checkbox"/);
  });
  it('search-result radios are not `required` (the server decides: pick OR type)', async () => {
    // Kills: `required` left on the radios, which would block typing a new name.
    H.results = [{ id: 'person-9', displayName: 'Santos, Maria C.', orgId: 'org-1', isActive: true, kind: 'person' }];
    const html = await hirePage({ q: 'maria' });
    const radio = html.match(/<input[^>]*name="personChoice"[^>]*value="existing:person-9"[^>]*>/)?.[0];
    expect(radio, 'search hit radio').toBeTruthy();
    expect(radio).not.toMatch(/\brequired\b/);
    expect(html).toContain('Santos, Maria C.');
  });
});

describe('T-438 smoke 5 - the Name form on the staff page', () => {
  it('for a legacy person (NULL parts): three empty boxes and the current display name shown as a hint', async () => {
    // Kills: the form pre-filled with a guessed split; no hint of the legacy name (N3: never guess the surname).
    const html = await detailPage();
    for (const n of ['lastName', 'firstName', 'middleName']) {
      const tag = inputTag(html, n);
      expect(tag, `${n} box`).toBeTruthy();
      expect(tag).not.toMatch(/value="[^"]+"/);
    }
    expect(html).toContain('Maria Dela Cruz Santos');
  });
  it('for a person with parts: the boxes carry the current parts', async () => {
    // Kills: parts not loaded by the detail loader.
    H.parts = { lastName: 'Santos', firstName: 'Maria', middleName: 'Clara' };
    H.display = 'Santos, Maria C.';
    const html = await detailPage();
    expect(inputTag(html, 'lastName')).toMatch(/value="Santos"/);
    expect(inputTag(html, 'firstName')).toMatch(/value="Maria"/);
    expect(inputTag(html, 'middleName')).toMatch(/value="Clara"/);
  });
});
