/**
 * T-343 S6b — `/admin/users` shows labels, and says "now held in their own right" only after it
 * is (DEF-431). docs/tasks/343-def-417-human-readable-refusals.md §S6b (design rules §S6, :1082-1146).
 *
 * ⛔ TESTER, not BUILDER. `admin/users/page.tsx`, `[personId]/page.tsx` and `actions.ts` still show
 * raw keys (`role.replace(/_/g, ' ')`, `{g.grantName}` in `font-mono`), the pre-click "now held"
 * sentence is still there, and `actions.ts` never reads `intent`. Every U/A leg below is expected
 * red until the builder lands S6b. **S6a is already built** (`capabilityTitle`/`ROLE_LABEL` exist
 * on `packages/auth/src/capabilities.ts` and are exported from its barrel) — none of this file's
 * red is an S6a artifact; every red here is a genuine, S6b-only assertion.
 *
 * Harness: `renderToStaticMarkup(await UserAccessPage({ params, searchParams }))`, per
 * `t337-access-defaults-grid-render.test.ts`'s header, for U1-U5; the t337-actions harness
 * (RedirectSignal, mocked `next/navigation`, session, `withOrgPrincipal`), per
 * `t337-access-defaults-actions.test.ts`, for A1-A6. **Expected labels are imported from
 * `packages/auth/src/capabilities.ts` and `errors.ts` directly** — never typed in, and never read
 * through the `@shareat/auth` BARREL this file also mocks (partially) for the real page/actions
 * code, so a test bug in the expectation can never share the same wrong value as a bug under test.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ROLES,
  ROLE_LABEL,
  capabilityTitle,
  type Capability,
  type Role,
} from '../../../packages/auth/src/capabilities';
import { AuthorizationError } from '../../../packages/auth/src/errors';
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

// `actions.ts` imports `@/lib/constraint-messages` via `apps/erp`'s own tsconfig path, which the
// ROOT `vitest.config.mts` never registers as a resolve alias (t337-access-defaults-actions.test.ts's
// own header note). Mocking the bare specifier sidesteps the gap.
vi.mock('@/lib/constraint-messages', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Same gap, for the `Page` shell every route under `admin/users` renders through.
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
      // A6's revoke branch calls the REAL authorize() (grantCapabilityAsActor is the only
      // @shareat/auth override) — 'grant_capability' is org-scoped and CAPABILITY_MATRIX grants it
      // to 'admin', so this is the only DB lookup authorize()'s success path needs here.
      activeRoleForPerson: vi.fn(async () => ({ role: 'admin' })),
    },
    // T-412: revoking a grant asks for its title to be retyped; the server loads the grant's name (stubbed here: 'void_expense').
    destructiveTargetsRepo: { targetOf: vi.fn(async () => ({ storeId: null, name: 'void_expense', status: null })) },
  };
});

// Exactly the spec's own mock (S6b TESTER-paths note) — everything else real, including
// `capabilityTitle`/`ROLE_LABEL`/`CAPABILITY_SCOPE` the page itself renders with.
vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  grantCapabilityAsActor: vi.fn(),
}));

const userDetailMock = vi.fn();
const listUsersMock = vi.fn();
vi.mock('../src/app/admin/users/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/admin/users/lib')>();
  return {
    ...actual,
    userDetail: (...args: unknown[]) => userDetailMock(...args),
    listUsers: (...args: unknown[]) => listUsersMock(...args),
    // Same passthrough t337-access-defaults-actions.test.ts uses — no real transaction, no real DB.
    withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
  };
});

// ---------------------------------------------------------------------------------------------
// Fixtures — two targets, per spec's own TESTER-paths note.
// ---------------------------------------------------------------------------------------------

const STAFF_PERSON_ID = 'person-staff-1';
const OTHER_ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };

function staffDetail() {
  return {
    person: {
      id: STAFF_PERSON_ID,
      orgId: 'org-1',
      displayName: 'Jamie Cruz',
      isActive: true,
      kind: 'employee' as const,
      role: 'staff' as Role,
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      storeScopeCount: 1,
      activeGrantCount: 2,
    },
    stores: [{ id: 'store-1', name: 'SmokeStore', code: 'SMK-1', inScope: true }],
    grants: [
      {
        id: 'grant-1',
        personId: STAFF_PERSON_ID,
        grantName: 'record_sale',
        grantedBy: 'actor-admin-1',
        grantedAt: new Date('2026-01-02T00:00:00Z'),
        revokedAt: null,
        grantSource: 'grant' as const,
        sourceRef: null,
        storeId: null,
        revokeReason: null,
        positionSource: null,
      },
      {
        id: 'grant-2',
        personId: STAFF_PERSON_ID,
        grantName: 'submit_sales_day',
        grantedBy: null,
        grantedAt: new Date('2026-01-02T00:00:00Z'),
        revokedAt: null,
        grantSource: 'position' as const,
        sourceRef: 'posdefault-1',
        storeId: 'store-1',
        revokeReason: null,
        positionSource: {
          id: 'posdefault-1',
          positionId: 'pos-cashier',
          positionName: 'Cashier',
          storeId: 'store-1',
          storeName: 'SmokeStore',
          revokedAt: null,
        },
      },
      {
        id: 'grant-3',
        personId: STAFF_PERSON_ID,
        grantName: 'void_sales_day',
        grantedBy: 'actor-admin-1',
        grantedAt: new Date('2026-01-01T00:00:00Z'),
        revokedAt: new Date('2026-01-05T00:00:00Z'),
        grantSource: 'grant' as const,
        sourceRef: null,
        storeId: null,
        revokeReason: 'no longer needed',
        positionSource: null,
      },
    ],
    credentials: [] as never[],
  };
}

const SUPER_PERSON_ID = 'person-super-1';

function superAdminDetail() {
  return {
    person: {
      id: SUPER_PERSON_ID,
      orgId: 'org-1',
      displayName: 'Alex Ramirez',
      isActive: true,
      kind: 'employee' as const,
      role: 'super_admin' as Role,
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      storeScopeCount: 0,
      activeGrantCount: 0,
    },
    stores: [] as never[],
    grants: [] as never[],
    credentials: [] as never[],
  };
}

// ---------------------------------------------------------------------------------------------
// Markup helpers — same posture as t337-access-defaults-grid-render.test.ts: parse the real
// rendered HTML, never re-derive what the page "should" produce.
// ---------------------------------------------------------------------------------------------

const MUTED_TOKENS = 'block font-mono text-xs text-neutral-500 dark:text-neutral-400'.split(/\s+/);

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every element whose `class` is a SUPERSET of design rule 5's muted-secondary tokens, with its
 *  own (non-nested) text content — the exact element S6b's raw key must live inside. */
function mutedSecondaryTexts(html: string): string[] {
  const re = /<(\w+)\s+class="([^"]*)">([^<]*)<\/\1>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const classes = m[2]!.split(/\s+/);
    if (MUTED_TOKENS.every((t) => classes.includes(t))) out.push(m[3]!.trim());
  }
  return out;
}

/** Every top-level `<li>…</li>` block (grants list, revoked list, store list, credentials list all
 *  use flat, non-nested `<li>`s on this page). */
function liBlocks(html: string): string[] {
  return html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
}

interface HiddenField {
  name: string;
  value: string;
}

function formsIn(html: string): string[] {
  return html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
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

function checkboxValuesOf(formHtml: string, name: string): string[] {
  const out: string[] = [];
  const inputRe = /<input\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(formHtml))) {
    const tag = m[0];
    if (!/type="checkbox"/.test(tag)) continue;
    if (!new RegExp(`name="${name}"`).test(tag)) continue;
    const value = /value="([^"]*)"/.exec(tag)?.[1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

const SNAKE_CASE_RE = /\b[a-z]+(?:_[a-z]+)+\b/g;

// Audit note (t337-access-defaults-actions.test.ts precedent): the FIRST dynamic import of a
// module this size (drags in schema/domain/auth/drizzle for a fresh transform under load)
// routinely exceeds vitest's 5000ms default test timeout even though the assertions are correct.
// Hoisted to `beforeAll` with a generous timeout so every `it` reuses the same cached import.
let UserAccessPage: typeof import('../src/app/admin/users/[personId]/page').default;
let UsersPage: typeof import('../src/app/admin/users/page').default;
let lib: typeof import('../src/app/admin/users/lib');
let actions: typeof import('../src/app/admin/users/actions');
let authModule: typeof import('@shareat/auth');

beforeAll(async () => {
  UserAccessPage = (await import('../src/app/admin/users/[personId]/page')).default;
  UsersPage = (await import('../src/app/admin/users/page')).default;
  lib = await import('../src/app/admin/users/lib');
  actions = await import('../src/app/admin/users/actions');
  authModule = await import('@shareat/auth');
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

async function renderUsersListPage(): Promise<string> {
  requirePageAccessMock.mockResolvedValueOnce({ actor: OTHER_ACTOR, refusal: null });
  const element = await UsersPage();
  return renderToStaticMarkup(element);
}

// =================================================================================================
// U1-U5 — render legs
// =================================================================================================

describe('U1 — held/revoked/picker capabilities show the label; the raw key appears only in value=/name= attributes, never in visible text', () => {
  it('staff target', async () => {
    userDetailMock.mockResolvedValueOnce(staffDetail());
    const html = await renderUserAccessPage(STAFF_PERSON_ID);
    const visibleText = stripTags(html);

    // Corrected reading (the page's own `offerable` computation, unchanged by S6b):
    // `heldNames` on `[personId]/page.tsx` is built from ACTIVE grants only, so a REVOKED
    // capability is not "held" and the picker still offers it. `void_sales_day` is this fixture's
    // one revoked grant, so it legitimately renders TWICE — once in the revoked list, once in the
    // picker — and each occurrence must still be exactly one muted element within ITS OWN section.
    //
    // S2b item 3 (same ruling as U4): `heldNames` excludes only an ORG-WIDE (NULL-store) active
    // row. `record_sale` (grant, storeId:null) stays excluded. `submit_sales_day` (position,
    // storeId:'store-1') is store-scoped, so it is no longer excluded either — it now renders in
    // BOTH the held-grants list AND the picker, the same "held AND still offerable" shape
    // `void_sales_day` has, just for a different reason (store scope vs. revocation).
    const heldNames = new Set(['record_sale']);
    // Audit follow-up, 2026-09-27: every offerable capability, not just the first — sampling one
    // (`[0]`) left the picker's other ~97 rows unasserted, including the four whose labels contain
    // an apostrophe (manage_locations, book_missed_month, set_cash_policy,
    // finalize_pos_usage_pull), which is exactly the shape `stripTags` missing `&#x27;` decoding
    // would silently pass on (a bare `render()` never decodes it, only the string this test builds
    // by hand does).
    const offerableCaps = lib.grantableCapabilitiesFor('staff' as Role).filter((c) => !heldNames.has(c));
    // void_sales_day is both revoked AND still offerable (the picker excludes ACTIVE grants only);
    // submit_sales_day is both held (a store-scoped position row) AND still offerable (S2b item 3
    // — the picker excludes only an org-wide hold) — both asserted separately below, each needing
    // a shape the generic "never held, never revoked" loop does not cover.
    const pureOfferable = offerableCaps.filter((c) => c !== 'void_sales_day' && c !== 'submit_sales_day');

    const rawKeysToLabels: [string, string][] = [
      ['record_sale', capabilityTitle('record_sale')],
      ['submit_sales_day', capabilityTitle('submit_sales_day')],
      ['void_sales_day', capabilityTitle('void_sales_day')],
    ];

    const allKeys = [...new Set(['record_sale', 'submit_sales_day', ...offerableCaps])];
    for (const key of allKeys) {
      expect(visibleText, `expected label "${capabilityTitle(key)}" (${key}) in visible text`).toContain(
        capabilityTitle(key),
      );
    }

    // T-589 B5 (BOSS ruling): the raw key is not shown at all. It may appear ONLY in value=/name= attributes
    // (what the forms post), never in visible text. Strip every attribute value out of the markup, then sweep what
    // is LEFT for snake_case tokens: the key is hidden from the reader iff this is empty.
    const visibleOnly = stripTags(html.replace(/<[^>]*>/g, (tag) => tag.replace(/\s[\w:-]+="[^"]*"/g, '')));
    const strayKeys = [...visibleOnly.matchAll(SNAKE_CASE_RE)].map((m) => m[0]);
    expect(strayKeys, `raw key(s) shown in visible text: ${strayKeys.join(', ')}`).toEqual([]);

    // Per-section: the picker offers one checkbox per capability (value= carries the key), the held list none.
    const pickerHeadingIdx = html.indexOf('Grant capabilities this role does not have');
    const revokedHeadingIdx = html.indexOf('revoked grant');
    expect(pickerHeadingIdx, 'expected the picker heading').toBeGreaterThanOrEqual(0);
    expect(revokedHeadingIdx, 'expected the revoked-grants summary').toBeGreaterThan(pickerHeadingIdx);
    const heldSection = html.slice(0, pickerHeadingIdx);
    const pickerSection = html.slice(pickerHeadingIdx, revokedHeadingIdx);
    const revokedSection = html.slice(revokedHeadingIdx);
    const boxesIn = (section: string, key: string) =>
      (section.match(new RegExp(`<input[^>]*type="checkbox"[^>]*value="${key}"`, 'g')) ?? []).length;
    // What is counted: the <li> rows of a section whose own text STARTS with the capability's label. A grant row opens with its
    // label, and exactly one row exists per grant, so this is one per held (or revoked) grant; the label may also sit inside
    // that row's confirm dialog or hold form, which is why plain label occurrences are not counted.
    const rowsIn = (section: string, key: string) => liBlocks(section).filter((li) => stripTags(li).startsWith(capabilityTitle(key))).length;

    // record_sale: held org-wide, so it is NOT offered in the picker; its label shows once in the held list.
    expect(boxesIn(pickerSection, 'record_sale'), 'record_sale: picker (must not offer an org-wide-held capability)').toBe(0);
    expect(rowsIn(heldSection, 'record_sale'), 'record_sale: held section').toBe(1);
    expect(rowsIn(revokedSection, 'record_sale'), 'record_sale: revoked section').toBe(0);
    // void_sales_day: revoked AND still picker-offerable: its label shows in the revoked list and as a picker box.
    expect(rowsIn(heldSection, 'void_sales_day'), 'void_sales_day: held section').toBe(0);
    expect(boxesIn(pickerSection, 'void_sales_day'), 'void_sales_day: picker').toBe(1);
    expect(rowsIn(revokedSection, 'void_sales_day'), 'void_sales_day: revoked section').toBe(1);
    // submit_sales_day: held (store-scoped position row) AND still picker-offerable.
    expect(rowsIn(heldSection, 'submit_sales_day'), 'submit_sales_day: held section').toBe(1);
    expect(boxesIn(pickerSection, 'submit_sales_day'), 'submit_sales_day: picker').toBe(1);
    expect(rowsIn(revokedSection, 'submit_sales_day'), 'submit_sales_day: revoked section').toBe(0);
    // Every OTHER offerable capability: one picker checkbox (the key lives in its value=), nowhere else.
    for (const c of pureOfferable) {
      expect(boxesIn(pickerSection, c), `${c}: picker`).toBe(1);
      expect(boxesIn(heldSection, c) + boxesIn(revokedSection, c), `${c}: checkbox outside the picker`).toBe(0);
      expect(rowsIn(heldSection, c), `${c}: held section`).toBe(0);
      expect(rowsIn(revokedSection, c), `${c}: revoked section`).toBe(0);
    }

    // Within the SAME <li> row the label shows and the key does not.
    for (const [rawKey, label] of rawKeysToLabels) {
      const row = liBlocks(html).find((li) => stripTags(li).includes(label));
      expect(row, `no <li> row found carrying the label "${label}"`).toBeTruthy();
      expect(stripTags(row!)).not.toContain(rawKey);
    }
  });
});

describe('U2 — the position-sourced grant\'s "Hold in their own right" form carries intent=hold_own_right, and shows no pre-click "now held" sentence', () => {
  it('staff target', async () => {
    userDetailMock.mockResolvedValueOnce(staffDetail());
    const html = await renderUserAccessPage(STAFF_PERSON_ID);
    const visibleText = stripTags(html);

    expect(visibleText).not.toContain('now held in their own right');

    const holdForm = formsIn(html).find((f) => {
      const fields = hiddenFieldsOf(f);
      return (
        fields.some((x) => x.name === 'capability' && x.value === 'submit_sales_day') &&
        fields.some((x) => x.name === 'granted' && x.value === 'true')
      );
    });
    expect(holdForm, 'expected a "Hold in their own right" form for the position-sourced grant').toBeTruthy();
    const fields = hiddenFieldsOf(holdForm!);
    expect(fields).toEqual(
      expect.arrayContaining([{ name: 'intent', value: 'hold_own_right' }]),
    );
    // T-349 S2 (DEF-456) ruled edit — the store is taken from the position row's OWN grant, never
    // the form, so the hold form now also carries which row that is (`staffDetail()`'s
    // `submit_sales_day` row is `grant-2`).
    expect(fields).toEqual(
      expect.arrayContaining([{ name: 'positionGrantId', value: 'grant-2' }]),
    );
  });
});

describe('U3 — self page: no "Hold in their own right" control (unchanged, isSelf)', () => {
  it('staff target, actor = person', async () => {
    userDetailMock.mockResolvedValueOnce(staffDetail());
    const html = await renderUserAccessPage(STAFF_PERSON_ID, { orgId: 'org-1', personId: STAFF_PERSON_ID });
    expect(stripTags(html)).not.toContain('Hold in their own right');
  });

  it('floor: a non-self render of the SAME fixture DOES show the control', async () => {
    userDetailMock.mockResolvedValueOnce(staffDetail());
    const html = await renderUserAccessPage(STAFF_PERSON_ID, OTHER_ACTOR);
    expect(stripTags(html)).toContain('Hold in their own right');
  });
});

describe('U4 — form contract unchanged: picker checkboxes and the hold form\'s hidden capability are raw keys (Invariant 18)', () => {
  it('staff target', async () => {
    userDetailMock.mockResolvedValueOnce(staffDetail());
    const html = await renderUserAccessPage(STAFF_PERSON_ID);

    // S2b item 3 (TESTER-ruled edit): `heldNames` excludes only an ORG-WIDE (NULL-store) active
    // row — a store-scoped hold or a bare position row no longer exhausts the picker's org-wide
    // slot. `staffDetail()`'s `record_sale` is grantSource:'grant', storeId:null — still excluded.
    // `submit_sales_day` is grantSource:'position', storeId:'store-1' — a store-scoped row, so it
    // is now offerable in the picker too (it still gets its own hold form below, unaffected).
    const heldNames = new Set(['record_sale']);
    const expectedOfferable = new Set(lib.grantableCapabilitiesFor('staff' as Role).filter((c) => !heldNames.has(c)));

    const pickerForm = formsIn(html).find(
      (f) => hiddenFieldsOf(f).some((x) => x.name === 'granted' && x.value === 'true') && /type="checkbox"/.test(f),
    );
    expect(pickerForm, 'expected the capability picker form').toBeTruthy();
    const pickerValues = new Set(checkboxValuesOf(pickerForm!, 'capability'));
    expect(pickerValues).toEqual(expectedOfferable);

    const holdForm = formsIn(html).find((f) =>
      hiddenFieldsOf(f).some((x) => x.name === 'capability' && x.value === 'submit_sales_day'),
    );
    expect(holdForm, 'expected the "Hold in their own right" form').toBeTruthy();
    expect(hiddenFieldsOf(holdForm!)).toEqual(
      expect.arrayContaining([{ name: 'capability', value: 'submit_sales_day' }]),
    );
  });
});

describe('U5 — role labels: detail page text + role <select>, and the list page', () => {
  it('super_admin target: detail page shows "Super admin" (exact case), and the role <select> is ROLES/ROLE_LABEL', async () => {
    userDetailMock.mockResolvedValueOnce(superAdminDetail());
    const html = await renderUserAccessPage(SUPER_PERSON_ID);
    const visibleText = stripTags(html);
    expect(visibleText).toContain('Super admin');
    expect(visibleText).not.toContain('super admin');

    const selectBlock = /<select\b[^>]*name="role"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(selectBlock, 'expected the role <select>').toBeTruthy();
    const options = [...selectBlock!.matchAll(/<option\s+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .map(([, value, text]) => ({ value: value!, text: text!.trim() }))
      .filter((o) => o.value !== '');
    expect(options.map((o) => o.value).sort()).toEqual([...ROLES].sort());
    for (const o of options) {
      expect(o.text).toBe(ROLE_LABEL[o.value as Role]);
    }
  });

  it('list page: a super-admin row shows "Super admin", not "super admin"', async () => {
    listUsersMock.mockResolvedValueOnce([
      {
        id: SUPER_PERSON_ID,
        displayName: 'Alex Ramirez',
        isActive: true,
        role: 'super_admin' as Role,
        storeScopeCount: 0,
        activeGrantCount: 0,
      },
    ]);
    const html = await renderUsersListPage();
    const visibleText = stripTags(html);
    expect(visibleText).toContain('Super admin');
    expect(visibleText).not.toContain('super admin');
  });
});

// =================================================================================================
// A1-A6 — action legs (t337-actions harness)
// =================================================================================================

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
    throw new Error('expected the action to redirect, but it returned normally');
  } catch (err) {
    if (!(err instanceof RedirectSignal)) throw err;
    return err.to;
  }
}

function grantFormData(overrides: {
  personId?: string;
  capabilities?: string[];
  intent?: string;
  positionGrantId?: string;
}): FormData {
  const fd = new FormData();
  fd.set('personId', overrides.personId ?? 'person-1');
  fd.set('granted', 'true');
  for (const c of overrides.capabilities ?? ['record_sale']) fd.append('capability', c);
  if (overrides.intent) fd.set('intent', overrides.intent);
  // T-349 S2 (DEF-456) ruled edit — the hidden field the hold form now carries.
  if (overrides.positionGrantId) fd.set('positionGrantId', overrides.positionGrantId);
  return fd;
}

function revokeFormData(overrides: { personId?: string; grantId?: string; reason?: string }): FormData {
  const fd = new FormData();
  fd.set('personId', overrides.personId ?? 'person-1');
  fd.set('granted', 'false');
  fd.set('grantId', overrides.grantId ?? 'grant-1');
  fd.set('reason', overrides.reason ?? 'no longer needed');
  fd.set('confirmName', capabilityTitle('void_expense'));
  return fd;
}

describe('A1-A6 — setCapabilityGrantAction banners', () => {
  let grantCapabilityAsActor: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    grantCapabilityAsActor = authModule.grantCapabilityAsActor as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    grantCapabilityAsActor.mockReset();
  });

  // T-349 S2c (DEF-456), finding 3 / S2e (E4) — `record_sale` is store-scoped (`CAPABILITY_SCOPE`),
  // so the banner names the store axis — but never "covers every store" outright: axis 2 is a
  // `person_store_scope` row (employment, manual or fan-out), which this grant does not itself
  // create, so the wording says "at every store they have access to", not "every store".
  it('A1: granted, one store-scoped capability → ok = "Granted: <Title>, at every store they have access to."', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(grantFormData({ capabilities: ['record_sale'] })));
    const params = paramsOf(to);
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe(`Granted: ${capabilityTitle('record_sale')}, at every store they have access to.`);
    expect(grantCapabilityAsActor).toHaveBeenCalledTimes(1);
  });

  it(
    'A2 (+) / A4 (⛔ negative): intent=hold_own_right with a positionGrantId — one capability names it "now held … at <store>"; two capabilities refuse before any write',
    async () => {
      // T-349 S2 (DEF-456) ruled edit — the banner now names the STORE the hold reached
      // (`grantCapabilityAsActor`'s new return shape), never a bare "now held".
      grantCapabilityAsActor.mockResolvedValue({ wrote: true, heldEverywhere: false, storeName: 'SmokeStore' });

      const toOne = await expectRedirectTo(() =>
        actions.setCapabilityGrantAction(
          grantFormData({ capabilities: ['record_sale'], intent: 'hold_own_right', positionGrantId: 'grant-position-1' }),
        ),
      );
      const paramsOne = paramsOf(toOne);
      expect(paramsOne.get('ok'), `redirect URL was: ${toOne}`).toBe(
        `${capabilityTitle('record_sale')} is now held in their own right at SmokeStore.`,
      );

      // A4 (negative) — two capabilities under intent=hold_own_right is refused outright (§3.4:
      // "exactly one capability AND a non-empty positionGrantId are required"), never the old
      // "Granted 2 capabilities…" banner, whether or not a positionGrantId is present.
      const toTwo = await expectRedirectTo(() =>
        actions.setCapabilityGrantAction(
          grantFormData({
            capabilities: ['record_sale', 'submit_sales_day'],
            intent: 'hold_own_right',
            positionGrantId: 'grant-position-1',
          }),
        ),
      );
      const paramsTwo = paramsOf(toTwo);
      expect(paramsTwo.get('error'), `A4 (negative): redirect URL was: ${toTwo}`).toBeTruthy();
      expect(paramsTwo.has('ok'), `redirect URL was: ${toTwo}`).toBe(false);
    },
  );

  // T-349 S2c (DEF-456), finding 3 / S2e (E4): both `record_sale` and `submit_sales_day` are
  // store-scoped, so each phrase in the join gains its own ", at every store they have access to".
  it('A3: two store-scoped capabilities, no intent → ok names both titles (each ", at every store they have access to") joined by "; ", with no "_"', async () => {
    grantCapabilityAsActor.mockResolvedValue(undefined);
    const to = await expectRedirectTo(() =>
      actions.setCapabilityGrantAction(grantFormData({ capabilities: ['record_sale', 'submit_sales_day'] })),
    );
    const params = paramsOf(to);
    const ok = params.get('ok');
    expect(ok, `redirect URL was: ${to}`).toBe(
      `Granted 2 capabilities: ${capabilityTitle('record_sale')}, at every store they have access to; ${capabilityTitle('submit_sales_day')}, at every store they have access to.`,
    );
    expect(ok).not.toMatch(/_/);
    expect(grantCapabilityAsActor).toHaveBeenCalledTimes(2);
  });

  it(
    'A5 (⛔): grantCapabilityAsActor throws AuthorizationError with intent=hold_own_right (a positionGrantId present, so the NEW gate lets it through to the real call) → error param, no ok, no "now held"; called once — excludes the gate-refused cases, which never reach the call at all',
    async () => {
      // T-349 S2 (DEF-456) ruled edit — a positionGrantId is included so this case still exercises
      // what it always tested (authorize()'s OWN refusal, reached via a real call), not the NEW
      // §3.4 gate refusal (no positionGrantId / >1 capability), which never calls
      // grantCapabilityAsActor at all — that "refused before any write" shape is A4's job (above)
      // and T-349's own `t349-hold-own-right-page.test.ts` A3, not this case.
      grantCapabilityAsActor.mockRejectedValueOnce(
        new AuthorizationError("may not 'grant_capability'", 'record_sale' as Capability),
      );
      const to = await expectRedirectTo(() =>
        actions.setCapabilityGrantAction(
          grantFormData({ capabilities: ['record_sale'], intent: 'hold_own_right', positionGrantId: 'grant-position-1' }),
        ),
      );
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBeTruthy();
      expect(params.get('error')).not.toContain('now held');
      expect(params.has('ok'), `redirect URL was: ${to}`).toBe(false);
      expect(grantCapabilityAsActor).toHaveBeenCalledTimes(1);
    },
  );

  it('A6 (⛔): revoke → ok === "Grant revoked."', async () => {
    const to = await expectRedirectTo(() => actions.setCapabilityGrantAction(revokeFormData({})));
    const params = paramsOf(to);
    expect(params.get('ok'), `redirect URL was: ${to}`).toBe('Grant revoked.');
  });
});
