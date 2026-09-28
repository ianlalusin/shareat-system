/**
 * T-350 — an admin can change a channel's payout account after it is set (DEF-477).
 * `docs/tasks/350-def-477-change-channel-payout-account.md`, TESTER path R1–R3.
 *
 * ⛔ TESTER, not BUILDER. `apps/erp/src/app/channel-settlements/page.tsx` renders a wired
 * channel's card (`:142-160`) with its name and account text and NOTHING else — no capability
 * check exists anywhere on this page today, so no actor sees a Change control. The unwired panel
 * (`:81-130`) likewise renders its form for every signed-in actor with zero gating.
 *
 * ⚠️ INFERRED MECHANISM, tester's call, not the spec's: item 2 names only "the repo's existing
 * server-side 'can the actor do X at store Y' helper used by other pages" without naming it. The
 * only helper actually wired into a page for this exact shape — precompute once, then
 * `held.has('capability')` to decide whether an admin-only control renders on a page open to
 * everyone — is `heldCapabilities` from `@shareat/auth`, used today by
 * `apps/erp/src/app/findings/page.tsx` (`canCreateMissingPeriod`, `canBookMissedMonth`). This file
 * mocks that seam. If BUILDER decides visibility a different way (e.g. a per-row `authorize()` +
 * catch), these mocks go unused and the reds below need a different fixture — say so, don't
 * silently rewrite the mechanism this file pins.
 *
 * Harness: `renderToStaticMarkup`, per `t343-s6b-admin-users-labels.test.ts`'s own header.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = { orgId: 'org-1', personId: 'actor-1' };

const requireSessionMock = vi.fn();
vi.mock('../src/lib/session', () => ({
  requireSession: (...args: unknown[]) => requireSessionMock(...args),
  requireActor: async (...args: unknown[]) => (await requireSessionMock(...args)).actor,
}));

const heldCapabilitiesMock = vi.fn();
// T-350 S2 (F2) — the page now also calls the REAL per-store `authorize()` (storeDetail's own
// "throw -> value" idiom) after the org-wide `heldCapabilities` pre-check, so a mocked `tx: null`
// would otherwise crash it with a TypeError. Stubbed against the SAME `held` set `renderPage`
// already threads through `heldCapabilitiesMock` — not a second, independently-controlled fixture —
// so the two mocks can never disagree about who holds what.
let currentHeld = new Set<string>();
vi.mock('@shareat/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shareat/auth')>();
  return {
    ...actual,
    heldCapabilities: (...args: unknown[]) => heldCapabilitiesMock(...args),
    authorize: async (_tx: unknown, _actor: unknown, capability: string, _ctx: unknown) => {
      if (currentHeld.has(capability)) return;
      throw new actual.AuthorizationError(`authorize: mocked refusal for '${capability}'`, capability as never);
    },
  };
});

const listChannelsMock = vi.fn();
const listDestinationAccountsMock = vi.fn();
vi.mock('../src/app/channel-settlements/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/channel-settlements/lib')>();
  return {
    ...actual,
    listChannels: (...args: unknown[]) => listChannelsMock(...args),
    listWaitingDays: async () => [],
    listRecentSettlements: async () => [],
    listActiveLoans: async () => [],
    listDestinationAccounts: (...args: unknown[]) => listDestinationAccountsMock(...args),
    // ⛔ NOT a stub of the real DB wrapper — a pass-through so a future `heldCapabilities(tx, actor)`
    // call routed through this file's re-exported `withOrgPrincipal` never opens a real connection.
    withOrgPrincipal: async (_orgId: string, fn: (tx: null) => unknown) => fn(null),
  };
});

// ⛔ NOT a stub — forwards to the real module (the bare `@/...` specifier the root
// `vitest.config.mts` never resolves; s5-5p/s5-5q, t343-s5-5r-render precedent). Reachable via
// `actions.ts`, which `page.tsx` imports for its form `action=` props.
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../src/lib/constraint-messages');
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

const STORE_ID = 'store-1';
const DEST_A = { id: 'acct-a', storeId: STORE_ID, name: 'Bank A', custodian: 'office', glAccountCode: '1140' };
const DEST_B = { id: 'acct-b', storeId: STORE_ID, name: 'Bank B', custodian: 'office', glAccountCode: '1140' };

function wiredChannel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chan-1',
    name: 'Foodpanda',
    storeId: STORE_ID,
    storeName: 'Store A',
    storeCode: 'A',
    isActive: true,
    destinationMoneyAccountId: DEST_A.id,
    destinationAccountName: DEST_A.name,
    taxTreatment: 'expense',
    outstanding: '0.00',
    ...overrides,
  };
}

function unwiredChannel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chan-2',
    name: 'GrabFood',
    storeId: STORE_ID,
    storeName: 'Store A',
    storeCode: 'A',
    isActive: true,
    destinationMoneyAccountId: null,
    destinationAccountName: null,
    taxTreatment: 'expense',
    outstanding: '0.00',
    ...overrides,
  };
}

let ChannelSettlementsPage: typeof import('../src/app/channel-settlements/page').default;

beforeAll(async () => {
  ChannelSettlementsPage = (await import('../src/app/channel-settlements/page')).default;
}, 30_000);

beforeEach(() => {
  requireSessionMock.mockReset();
  heldCapabilitiesMock.mockReset();
  listChannelsMock.mockReset();
  listDestinationAccountsMock.mockReset();
  listDestinationAccountsMock.mockResolvedValue([DEST_A, DEST_B]);
  requireSessionMock.mockResolvedValue({
    actor: ACTOR,
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  });
});

async function renderPage(
  channels: unknown[],
  held: string[],
  options: { searchParams?: Record<string, string>; accounts?: unknown[] } = {},
) {
  listChannelsMock.mockResolvedValueOnce(channels);
  currentHeld = new Set(held);
  heldCapabilitiesMock.mockResolvedValueOnce(currentHeld);
  if (options.accounts) listDestinationAccountsMock.mockResolvedValueOnce(options.accounts);
  const element = await ChannelSettlementsPage({ searchParams: Promise.resolve(options.searchParams ?? {}) });
  return renderToStaticMarkup(element as never);
}

describe('R1 — a wired channel card, for a holder of set_channel_payout, shows Change', () => {
  it(
    'wanted: a details/summary Change control, pre-selected to the current account, plus Cancel — ' +
      'was red before this fix: no control at all, for any actor',
    async () => {
      const html = await renderPage([wiredChannel()], ['set_channel_payout']);

      expect(html, 'expected the channel name to render at all').toContain('Foodpanda');

      const changeForm = /<form\b[^>]*>[\s\S]*?name="channelId"[^>]*value="chan-1"[\s\S]*?<\/form>/.exec(
        html,
      )?.[0];
      expect(changeForm, 'expected a form carrying channelId=chan-1 and a moneyAccountId control').toBeTruthy();
      expect(changeForm, 'expected a moneyAccountId select in that form').toMatch(/name="moneyAccountId"/);

      expect(html, 'expected a server-rendered disclosure, not client state (spec: <details>/<summary>)').toMatch(
        /<details[^>]*>[\s\S]*<summary[^>]*>[\s\S]*Change[\s\S]*<\/summary>/i,
      );
      expect(html, 'expected a Cancel affordance next to Change').toMatch(/Cancel/);

      const selectBlock = /<select[^>]*name="moneyAccountId"[^>]*>[\s\S]*?<\/select>/.exec(changeForm!)?.[0];
      expect(selectBlock, 'expected the moneyAccountId select itself').toBeTruthy();
      expect(
        selectBlock,
        'wanted the CURRENT account (acct-a) pre-selected — was red: no control to pre-select at all',
      ).toMatch(/<option[^>]*value="acct-a"[^>]*selected/);
      expect(selectBlock, 'expected the OTHER account (acct-b) offered too').toMatch(/value="acct-b"/);
    },
  );
});

describe('R2 — a wired channel card, for a non-holder, shows no control', () => {
  it(
    'plain account text only, no Change — ⛔ may already be true today (nobody sees a control yet); ' +
      'this pins it so a later widening cannot silently show Change to everyone',
    async () => {
      const html = await renderPage([wiredChannel()], []);

      expect(html, 'expected the account name as plain text').toContain('Bank A');
      expect(html, 'expected no Change disclosure for a non-holder').not.toMatch(/<summary[^>]*>[\s\S]*Change/i);
      expect(html, 'expected no moneyAccountId control on the channel card for a non-holder').not.toMatch(
        /name="moneyAccountId"[^>]*>[\s\S]*?value="acct-b"/,
      );
    },
  );
});

describe('R3 (extra, admin only) — a non-holder sees no form in the unwired panel either', () => {
  it(
    'wanted: no moneyAccountId picker for the unwired channel, warning reads "an admin must set it" ' +
      '(doc line 25) — was red: today the form renders for every signed-in actor, no such sentence exists',
    async () => {
      const html = await renderPage([unwiredChannel()], []);

      expect(html, 'expected the unwired warning section to render at all').toContain('GrabFood');
      const unwiredForm = /<form\b[^>]*>[\s\S]*?name="channelId"[^>]*value="chan-2"[\s\S]*?<\/form>/.exec(html)?.[0];
      expect(unwiredForm, 'wanted no per-channel picker form for a non-holder — was red: form rendered').toBeFalsy();
      expect(
        html,
        'wanted the doc\'s named sentence ("an admin must set it") in place of the form',
      ).toMatch(/admin must set it/i);
    },
  );
});

// =================================================================================================
// T-350 S2 — post-commit review of 0ffb0fe (F1/F3/F5/F6), docs/tasks/350-*.md §S2. S2-R2 (F2) is
// NOT here: it needs a REAL per-store capability check, which this file's `heldCapabilities` mock
// cannot express (it is a plain boolean set, store-blind by construction) — see
// apps/erp/tests/integration/t350-s2-render.test.ts instead.
// =================================================================================================

describe('S2-R1 (F1) — a WIRED channel whose current account is retired (not in the active list)', () => {
  it(
    'wanted: a disabled, selected placeholder, no real option pre-selected, card names it "(retired)" — ' +
      'was red today: defaultValue matches no <option>, so the browser silently falls back to the FIRST real option',
    async () => {
      const html = await renderPage(
        [
          wiredChannel({
            destinationMoneyAccountId: 'acct-retired',
            destinationAccountName: 'Retired Bank',
          }),
        ],
        ['set_channel_payout'],
        { accounts: [DEST_A, DEST_B] }, // neither is 'acct-retired' — it has been retired out of the active list
      );

      expect(html, 'expected the card to name the retired account, marked as such').toMatch(/Retired Bank[^<]*\(retired\)/);

      const changeForm = /<form\b[^>]*>[\s\S]*?name="channelId"[^>]*value="chan-1"[\s\S]*?<\/form>/.exec(html)?.[0];
      expect(changeForm, 'expected the Change form to still render').toBeTruthy();
      const selectBlock = /<select[^>]*name="moneyAccountId"[^>]*>[\s\S]*?<\/select>/.exec(changeForm!)?.[0];
      expect(selectBlock, 'expected the moneyAccountId select').toBeTruthy();

      expect(
        selectBlock,
        'wanted: a disabled placeholder is selected — was red: no such placeholder exists at all today',
      ).toMatch(/<option[^>]*value=""[^>]*disabled[^>]*selected|<option[^>]*value=""[^>]*selected[^>]*disabled/);
      expect(selectBlock, 'neither real account may be pre-selected').not.toMatch(/<option[^>]*value="acct-a"[^>]*selected/);
      expect(selectBlock, 'neither real account may be pre-selected').not.toMatch(/<option[^>]*value="acct-b"[^>]*selected/);
    },
  );
});

describe('S2-R3 (F3/F5) — the "changed" banner names the CHANNEL\'S OWN account, never the URL\'s', () => {
  it(
    'wanted: the banner reads the current account server-side — was red today: the banner echoes ?account= verbatim, ' +
      'trusting a value a replayed/crafted URL fully controls',
    async () => {
      const html = await renderPage([wiredChannel({ destinationAccountName: 'Bank A' })], ['set_channel_payout'], {
        searchParams: { ok: 'destination', changed: '1', account: 'Totally Wrong Bank' },
      });

      expect(
        html,
        'wanted: never trust the URL\'s account name — was red: it appears verbatim in the banner',
      ).not.toContain('Totally Wrong Bank');
    },
  );
});

describe('S2-R4 (F6) — a wired channel with NO active accounts at its store', () => {
  it(
    'wanted: a sentence says so, no picker — was red today: an empty <select> with only the disabled placeholder option, still offered as if choosable',
    async () => {
      const html = await renderPage([wiredChannel()], ['set_channel_payout'], { accounts: [] });

      const changeArea = /<form\b[^>]*>[\s\S]*?name="channelId"[^>]*value="chan-1"[\s\S]*?<\/form>/.exec(html)?.[0];
      expect(
        changeArea?.includes('name="moneyAccountId"'),
        'wanted: no moneyAccountId picker when there is nothing to pick — was red: the select still renders, empty',
      ).not.toBe(true);
    },
  );
});
