/**
 * T-349 / DEF-456 S2 — the page fold and action banners.
 * `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §3.4, §4 (P1-P4, A1-A4, A2e).
 *
 * ⛔ TESTER, not BUILDER. Before T-349 S2, `foldActiveGrants` did not exist — `[personId]/page.tsx`
 * rendered every active grant row as its own `<li>` (no fold at all), `grantSourceLabel('grant')`
 * returned the bare `'hand-granted'` (no store name), and `setCapabilityGrantAction` never read
 * `positionGrantId` or `grantCapabilityAsActor`'s return value at all — the banner was computed
 * purely from `intent`/`capabilities.length`. S2 is now built and every leg below is green; a "was
 * red before T-349 S2" note records the pre-S2 failure this leg originally pinned. Every P/A leg
 * tests the REAL rendered page / action output directly (S6b harness), never a symbol imported by
 * name — `foldActiveGrants` itself is never imported here.
 *
 * Harness: `renderToStaticMarkup`, partial `@shareat/auth` mock (`grantCapabilityAsActor` only),
 * per `apps/erp/tests/t343-s6b-admin-users-labels.test.ts`'s own header.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { capabilityTitle } from '../../../packages/auth/src/capabilities';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called unexpectedly — every render fixture in this file resolves a detail');
  },
}));

const ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };

vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  clearSessionCookie: vi.fn(async () => {}),
}));

const requirePageAccessMock = vi.fn();
requirePageAccessMock.mockResolvedValue({ actor: ACTOR, refusal: null });
vi.mock('../src/lib/page-access', () => ({
  requirePageAccess: (...args: unknown[]) => requirePageAccessMock(...args),
}));

vi.mock('@/lib/constraint-messages', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

vi.mock('@shareat/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...actual,
    accessRepo: {
      ...actual.accessRepo,
      revokeGrantById: vi.fn(async () => {}),
      storeBelongsToOrg: vi.fn(async () => true),
      activeRoleForPerson: vi.fn(async () => ({ role: 'admin' })),
    },
  };
});

vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  grantCapabilityAsActor: vi.fn(),
}));

const userDetailMock = vi.fn();
vi.mock('../src/app/admin/users/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/users/lib')>();
  return {
    ...actual,
    userDetail: (...args: unknown[]) => userDetailMock(...args),
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  };
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const CAP = 'confirm_receipt';
const CAP_TITLE = capabilityTitle(CAP);
const STAFF_PERSON_ID = 'person-staff-1';
const OTHER_ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };
const STORE_A = { id: 'store-a', name: 'SmokeStore', code: 'SMK-1' };
const STORE_B = { id: 'store-b', name: 'B Store', code: 'SMK-2' };

function positionGrant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'grant-position-1',
    personId: STAFF_PERSON_ID,
    grantName: CAP,
    grantedBy: null,
    grantedAt: new Date('2026-01-02T00:00:00Z'),
    revokedAt: null,
    grantSource: 'position' as const,
    sourceRef: 'posdefault-a',
    storeId: STORE_A.id,
    revokeReason: null,
    positionSource: {
      id: 'posdefault-a',
      positionId: 'pos-cashier',
      positionName: 'Cashier',
      storeId: STORE_A.id,
      storeName: STORE_A.name,
      revokedAt: null,
    },
    ...overrides,
  };
}

function handGrant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'grant-hand-1',
    personId: STAFF_PERSON_ID,
    grantName: CAP,
    grantedBy: 'actor-admin-1',
    grantedAt: new Date('2026-01-03T00:00:00Z'),
    revokedAt: null,
    grantSource: 'grant' as const,
    sourceRef: null,
    storeId: STORE_A.id,
    revokeReason: null,
    positionSource: null,
    ...overrides,
  };
}

function baseDetail(grants: unknown[], stores: { id: string; name: string; code: string }[] = [STORE_A]) {
  return {
    person: {
      id: STAFF_PERSON_ID,
      orgId: 'org-1',
      displayName: 'Jamie Cruz',
      isActive: true,
      kind: 'employee' as const,
      role: 'staff' as const,
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      storeScopeCount: stores.length,
      activeGrantCount: grants.length,
    },
    stores: stores.map((s) => ({ ...s, inScope: true })),
    grants,
    credentials: [] as never[],
  };
}

// ---------------------------------------------------------------------------------------------
// Markup helpers — same posture as t343-s6b's own.
// ---------------------------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function liBlocks(html: string): string[] {
  return html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
}

function formsIn(html: string): string[] {
  return html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
}

interface HiddenField {
  name: string;
  value: string;
}

function hiddenFieldsOf(formHtml: string): HiddenField[] {
  const out: HiddenField[] = [];
  const inputRe = /<input\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(formHtml))) {
    const tag = m[0];
    if (!/type="hidden"/.test(tag)) continue;
    const name = /name="([^"]*)"/.exec(tag)?.[1];
    const value = /value="([^"]*)"/.exec(tag)?.[1];
    if (name !== undefined && value !== undefined) out.push({ name, value });
  }
  return out;
}

function rowsCarryingCapability(html: string): string[] {
  return liBlocks(html).filter((li) => li.includes(`>${CAP}<`));
}

let UserAccessPage: typeof import('../src/app/admin/users/[personId]/page').default;

beforeAll(async () => {
  UserAccessPage = (await import('../src/app/admin/users/[personId]/page')).default;
}, 30_000);

async function renderUserAccessPage(
  personId: string,
  actor: { orgId: string; personId: string } = OTHER_ACTOR,
): Promise<string> {
  requirePageAccessMock.mockResolvedValueOnce({ actor, refusal: null });
  const element = await UserAccessPage({
    params: Promise.resolve({ personId }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

// =================================================================================================
// P1-P4 — the page fold
// =================================================================================================

describe('P1 — position + hand grant, same capability, same store', () => {
  it(
    'wanted (post-fold): one line, "hand-granted at SmokeStore", "also via Cashier at SmokeStore", a Revoke form, no hold form — was red before T-349 S2: two lines, no store name on the hand grant, and a hold form was still there',
    async () => {
      userDetailMock.mockResolvedValueOnce(baseDetail([positionGrant(), handGrant()]));
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      const visibleText = stripTags(html);

      // The three post-fold facts, asserted directly against the real rendering.
      expect(rowsCarryingCapability(html), 'wanted: exactly one row for this capability — was red before T-349 S2: two').toHaveLength(1);
      expect(visibleText, 'wanted: the hand grant names its store — was red before T-349 S2: grantSourceLabel(\'grant\') had no store name').toContain(
        'hand-granted at SmokeStore',
      );
      expect(visibleText, 'wanted: the covering line also shows the position provenance — was red before T-349 S2: a separate row, not "also via"').toContain(
        'also via Cashier at SmokeStore',
      );

      const holdForm = formsIn(html).find((f) =>
        hiddenFieldsOf(f).some((x) => x.name === 'capability' && x.value === CAP) &&
        hiddenFieldsOf(f).some((x) => x.name === 'intent' && x.value === 'hold_own_right'),
      );
      expect(holdForm, 'wanted: no hold form for a capability already hand-granted here — was red before T-349 S2: one was still rendered').toBeUndefined();
    },
    30000,
  );
});

describe('P2 — position at A uncovered, position at B covered by a grant at B', () => {
  it(
    "wanted: TWO lines — §3.4's dedupe key is capability+STORE, and this fixture has this capability at two different stores. A's line carries the hold form with hidden positionGrantId = A's row id; B's line is folded (its own position+grant coexist as one line, no hold form) — was red before T-349 S2: no positionGrantId field existed at all",
    async () => {
      userDetailMock.mockResolvedValueOnce(
        baseDetail(
          [
            positionGrant({ id: 'grant-position-a', storeId: STORE_A.id, sourceRef: 'posdefault-a' }),
            positionGrant({
              id: 'grant-position-b',
              storeId: STORE_B.id,
              sourceRef: 'posdefault-b',
              positionSource: { id: 'posdefault-b', positionId: 'pos-cashier', positionName: 'Cashier', storeId: STORE_B.id, storeName: STORE_B.name, revokedAt: null },
            }),
            handGrant({ id: 'grant-hand-b', storeId: STORE_B.id }),
          ],
          [STORE_A, STORE_B],
        ),
      );
      const html = await renderUserAccessPage(STAFF_PERSON_ID);

      // §3.4: "one line per capability and store" — A's (capability, storeA) pair and B's
      // (capability, storeB) pair are two DIFFERENT keys, so two lines total. B's own two rows
      // (position + grant) fold into ONE of those two lines, they do not disappear.
      expect(rowsCarryingCapability(html), 'wanted: two lines, one per store — was red before T-349 S2: both of B\'s rows also rendered separately (3 total)').toHaveLength(2);

      const holdForm = formsIn(html).find((f) =>
        hiddenFieldsOf(f).some((x) => x.name === 'capability' && x.value === CAP) &&
        hiddenFieldsOf(f).some((x) => x.name === 'intent' && x.value === 'hold_own_right'),
      );
      expect(holdForm, 'expected a hold form for the uncovered position row at A').toBeTruthy();
      expect(
        hiddenFieldsOf(holdForm!).some((x) => x.name === 'positionGrantId' && x.value === 'grant-position-a'),
        'wanted: the hold form carries hidden positionGrantId = A\'s row id — was red before T-349 S2: no such field existed',
      ).toBe(true);

      // B's line: folded (one line, not two), no hold form for it — the hand grant at B already
      // covers this capability there.
      const holdFormsTotal = formsIn(html).filter((f) =>
        hiddenFieldsOf(f).some((x) => x.name === 'capability' && x.value === CAP) &&
        hiddenFieldsOf(f).some((x) => x.name === 'intent' && x.value === 'hold_own_right'),
      );
      expect(holdFormsTotal, 'wanted: exactly one hold form total (A only) — B is covered, no hold form for it').toHaveLength(1);
    },
    30000,
  );
});

describe('P3 — a NULL-store owner-equivalent row, and a position row for the same capability', () => {
  it(
    'wanted: the position row is folded (covered by the org-wide owner-equivalent row), no hold form for it — was red before T-349 S2: it rendered on its own, with a hold form',
    async () => {
      userDetailMock.mockResolvedValueOnce(
        baseDetail([
          positionGrant(),
          {
            id: 'grant-owner-1',
            personId: STAFF_PERSON_ID,
            grantName: CAP,
            grantedBy: 'actor-super-1',
            grantedAt: new Date('2026-01-01T00:00:00Z'),
            revokedAt: null,
            grantSource: 'owner' as const,
            sourceRef: null,
            storeId: null,
            revokeReason: null,
            positionSource: null,
          },
        ]),
      );
      const html = await renderUserAccessPage(STAFF_PERSON_ID);

      expect(rowsCarryingCapability(html), 'wanted: one line (folded) — was red before T-349 S2: two').toHaveLength(1);
      const holdForm = formsIn(html).find((f) =>
        hiddenFieldsOf(f).some((x) => x.name === 'capability' && x.value === CAP) &&
        hiddenFieldsOf(f).some((x) => x.name === 'intent' && x.value === 'hold_own_right'),
      );
      expect(holdForm, 'wanted: no hold form once covered by an org-wide row — was red before T-349 S2: one was still rendered').toBeUndefined();
    },
    30000,
  );
});

describe('P4 — grantSummaryLine over the folded list', () => {
  it(
    'wanted: "0 inherited from positions · 1 granted" (the position row is covered, so folded out) — was red before T-349 S2: "1 inherited … · 1 granted" (unfolded)',
    async () => {
      userDetailMock.mockResolvedValueOnce(baseDetail([positionGrant(), handGrant()]));
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      const visibleText = stripTags(html);
      expect(visibleText).toContain('0 inherited from positions · 1 granted');
    },
    30000,
  );
});

describe('P5 (S2b item 2) — one NULL-store grant covering TWO position rows at two stores shows BOTH jobs', () => {
  it(
    'wanted: "also via Cashier at SmokeStore" AND "also via Supervisor at B Store" both appear — was red before S2b: lib.ts:230 `alsoViaByOtherId.set` only runs `if (!alsoViaByOtherId.has(cover.id))`, so the SECOND covered position\'s job is silently dropped (alsoVia is typed as one PositionDefaultGrant, not an array)',
    async () => {
      userDetailMock.mockResolvedValueOnce(
        baseDetail(
          [
            // A NULL-store hand grant — "covers every store" per foldActiveGrants' own cover
            // predicate (`cover.storeId === position.storeId || cover.storeId === null`).
            handGrant({ id: 'grant-hand-orgwide', storeId: null }),
            positionGrant({ id: 'grant-position-a', storeId: STORE_A.id, sourceRef: 'posdefault-a' }),
            positionGrant({
              id: 'grant-position-b',
              storeId: STORE_B.id,
              sourceRef: 'posdefault-b',
              positionSource: { id: 'posdefault-b', positionId: 'pos-supervisor', positionName: 'Supervisor', storeId: STORE_B.id, storeName: STORE_B.name, revokedAt: null },
            }),
          ],
          [STORE_A, STORE_B],
        ),
      );
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      const visibleText = stripTags(html);

      // Both positions are covered — only one line for the capability, not three.
      expect(rowsCarryingCapability(html), 'wanted: one line — the org-wide grant folds both position rows').toHaveLength(1);
      expect(visibleText, 'wanted: the first covered job\'s provenance').toContain('via Cashier at SmokeStore');
      expect(visibleText, 'wanted: the SECOND covered job\'s provenance too — was red before S2b: dropped').toContain('via Supervisor at B Store');
    },
    30000,
  );
});

describe('P6 (S2b item 3) — the picker excludes only an ORG-WIDE hold, not a store-scoped one or a bare position row', () => {
  // ⚠️ Parses the whole tag rather than assuming attribute order (React renders `class` before
  // `value` here) — same approach as t343-s6b's own `checkboxValuesOf`. A hold/revoke form's
  // hidden field never carries `type="checkbox"`, so this can only match the picker.
  function pickerOffersCapability(html: string): boolean {
    const inputRe = /<input\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(html))) {
      const tag = m[0];
      if (!/type="checkbox"/.test(tag)) continue;
      if (!/name="capability"/.test(tag)) continue;
      if (new RegExp(`value="${CAP}"`).test(tag)) return true;
    }
    return false;
  }

  it(
    'wanted: a store-scoped hand grant leaves the capability offerable org-wide in the picker — was red before S2b: [personId]/page.tsx:66 excluded it for ANY active row, store-scoped or not',
    async () => {
      userDetailMock.mockResolvedValueOnce(baseDetail([handGrant({ id: 'grant-hand-a', storeId: STORE_A.id })]));
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      expect(
        pickerOffersCapability(html),
        'wanted: the capability is still offerable org-wide via the picker (a store-scoped hold does not exhaust it) — was red before S2b: excluded',
      ).toBe(true);
    },
    30000,
  );

  it(
    'wanted: a bare (uncovered) position row also leaves the capability offerable in the picker', async () => {
      userDetailMock.mockResolvedValueOnce(baseDetail([positionGrant()]));
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      expect(pickerOffersCapability(html), 'a position row alone must not exhaust the org-wide picker slot').toBe(true);
    },
    30000,
  );

  it(
    'wanted: an ORG-WIDE (NULL-store) hold DOES exclude the capability from the picker — unchanged, a control for the two legs above',
    async () => {
      userDetailMock.mockResolvedValueOnce(baseDetail([handGrant({ id: 'grant-hand-orgwide', storeId: null })]));
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      expect(pickerOffersCapability(html), 'an org-wide hold must still exhaust the picker').toBe(false);
    },
    30000,
  );
});

describe('P7 (S2b item 4) — the revoked list names the store for a store-scoped hand grant', () => {
  it(
    'wanted: "hand-granted at SmokeStore" in the revoked list — was red before S2b: [personId]/page.tsx:307-310 read the bare grantSourceLabel, no store name',
    async () => {
      userDetailMock.mockResolvedValueOnce(
        baseDetail([
          handGrant({
            id: 'grant-hand-revoked',
            storeId: STORE_A.id,
            revokedAt: new Date('2026-01-05T00:00:00Z'),
            revokeReason: 'test revoke',
          }),
        ]),
      );
      const html = await renderUserAccessPage(STAFF_PERSON_ID);
      const visibleText = stripTags(html);
      expect(visibleText, 'wanted: the revoked row names its store too').toContain('hand-granted at SmokeStore');
    },
    30000,
  );
});

// =================================================================================================
// A1-A4, A2e — setCapabilityGrantAction banners
// =================================================================================================

let actions: typeof import('../src/app/admin/users/actions');
let authModule: typeof import('@shareat/auth');

beforeAll(async () => {
  actions = await import('../src/app/admin/users/actions');
  authModule = await import('@shareat/auth');
}, 30_000);

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
    throw new Error('expected the action to redirect, but it returned normally');
  } catch (err) {
    if (!(err instanceof RedirectSignal)) throw err;
    return err.to;
  }
}

function holdFormData(overrides: { positionGrantId?: string; capabilities?: string[] } = {}): FormData {
  const fd = new FormData();
  fd.set('personId', STAFF_PERSON_ID);
  fd.set('granted', 'true');
  for (const c of overrides.capabilities ?? [CAP]) fd.append('capability', c);
  fd.set('intent', 'hold_own_right');
  if (overrides.positionGrantId !== undefined) fd.set('positionGrantId', overrides.positionGrantId);
  return fd;
}

function pickerFormData(): FormData {
  const fd = new FormData();
  fd.set('personId', STAFF_PERSON_ID);
  fd.set('granted', 'true');
  fd.append('capability', CAP);
  return fd;
}

describe('A1/A2/A2e — the hold banner names the store (was red before T-349 S2: it never did)', () => {
  let grantCapabilityAsActor: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    grantCapabilityAsActor = authModule.grantCapabilityAsActor as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    grantCapabilityAsActor.mockReset();
  });

  it('A1: wrote true, storeName "SmokeStore" — wanted "… is now held in their own right at SmokeStore." — was red before T-349 S2: no store name', async () => {
    grantCapabilityAsActor.mockResolvedValue({ wrote: true, storeName: 'SmokeStore', heldEverywhere: false });
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(holdFormData({ positionGrantId: 'grant-position-a' })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(`${CAP_TITLE} is now held in their own right at SmokeStore.`);
  });

  it('A1e: wrote true, storeName null (an org-scoped hold, §3.2 item 9/H9) — wanted "… is now held in their own right." with no "at" and no "null"', async () => {
    grantCapabilityAsActor.mockResolvedValue({ wrote: true, storeName: null, heldEverywhere: false });
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(holdFormData({ positionGrantId: 'grant-position-a' })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    const ok = params.get('ok');
    expect(ok, `redirect URL was: ${to}`).toBe(`${CAP_TITLE} is now held in their own right.`);
    expect(ok).not.toContain('null');
  });

  it('A2: wrote false, heldEverywhere false, storeName "SmokeStore" — wanted "… was already held in their own right at SmokeStore." — was red before T-349 S2: same as A1\'s old sentence regardless of `wrote`', async () => {
    grantCapabilityAsActor.mockResolvedValue({ wrote: false, storeName: 'SmokeStore', heldEverywhere: false });
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(holdFormData({ positionGrantId: 'grant-position-a' })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(`${CAP_TITLE} was already held in their own right at SmokeStore.`);
  });

  it('A2e: wrote false, heldEverywhere true — wanted "… was already held in their own right everywhere.", no store name — was red before T-349 S2: the plain "now held" sentence, unconditioned on wrote/heldEverywhere', async () => {
    grantCapabilityAsActor.mockResolvedValue({ wrote: false, storeName: null, heldEverywhere: true });
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(holdFormData({ positionGrantId: 'grant-position-a' })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    const ok = params.get('ok');
    expect(ok, `redirect URL was: ${to}`).toBe(`${CAP_TITLE} was already held in their own right everywhere.`);
    expect(ok).not.toContain('SmokeStore');
  });
});

describe('A3 — intent=hold_own_right with no positionGrantId, or two capabilities, should refuse before any write', () => {
  let grantCapabilityAsActor: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    grantCapabilityAsActor = authModule.grantCapabilityAsActor as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    grantCapabilityAsActor.mockReset();
  });

  it('no positionGrantId — wanted: error param, grantCapabilityAsActor not called — was red before T-349 S2: it was called anyway (field ignored), an org-wide grant', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(holdFormData()));
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('error'), `redirect URL was: ${to}`).toBeTruthy();
    expect(params.has('ok'), `redirect URL was: ${to}`).toBe(false);
    expect(grantCapabilityAsActor, 'wanted: refused before any write — was red before T-349 S2: called once, org-wide').not.toHaveBeenCalled();
  });

  it('two capabilities with a positionGrantId — wanted: error param, grantCapabilityAsActor not called — was red before T-349 S2: it was called twice, granted', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(holdFormData({ positionGrantId: 'grant-position-a', capabilities: [CAP, 'record_sale'] })),
    );
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('error'), `redirect URL was: ${to}`).toBeTruthy();
    expect(params.has('ok'), `redirect URL was: ${to}`).toBe(false);
    expect(grantCapabilityAsActor, 'wanted: refused before any write — was red before T-349 S2: called twice, granted').not.toHaveBeenCalled();
  });
});

describe('A4 (⛔ green now — a guard) — the ordinary picker grant (no intent) is unaffected', () => {
  let grantCapabilityAsActor: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    grantCapabilityAsActor = authModule.grantCapabilityAsActor as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    grantCapabilityAsActor.mockReset();
  });

  // T-349 S2c (DEF-456), finding 3: `confirm_receipt` is store-scoped, so the person-level picker
  // grant covers every store — the banner now names it.
  it('grantCapabilityAsActor is called without a positionGrantId field; banner "Granted: …" names every store', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(pickerFormData()));
    const params = new URL(to, 'http://localhost').searchParams;
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(`Granted: ${CAP_TITLE}, at every store.`);
    expect(grantCapabilityAsActor).toHaveBeenCalledTimes(1);
    const callArg = grantCapabilityAsActor.mock.calls[0]?.[2] as Record<string, unknown>;
    expect('positionGrantId' in callArg, 'the ordinary grant path must not carry this field at all').toBe(false);
  });
});
