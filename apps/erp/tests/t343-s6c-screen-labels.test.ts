/**
 * T-343 S6c — the other screens show labels (access defaults, items, usage, discrepancies, order
 * wastage). docs/tasks/343-def-417-human-readable-refusals.md §S6c (design rules §S6, :1082-1146).
 *
 * ⛔ TESTER, not BUILDER. Every page below still shows the raw key (`.replace(/_/g, ' ')`,
 * `{cell.capability}` in `font-mono`, `{row.disposition}`, `{w.disposition}`). S6a and S6b are
 * both already built. Every red here is a genuine, S6c-only assertion — none of it is an S6a/S6b
 * artifact.
 *
 * Harness: the grid legs (G1/G3) reuse `t337-access-defaults-grid-render.test.ts`'s fixture
 * approach (actions mocked, `gridCapabilityGroups()` called live). Every other leg renders
 * `await <Page>({ params?, searchParams })` with the page's own data functions mocked at their
 * import specifiers (session, the page's `./lib`, and `withOrgPrincipal` returning the fixture
 * without calling its callback — the same posture `t337-access-defaults-actions.test.ts` uses).
 * Expected labels are imported from `packages/auth/src/capabilities.ts` directly. Visible text is
 * defined as in S6b (tags stripped, entities decoded).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityTitle } from '../../../packages/auth/src/capabilities';
import { ITEM_KINDS, ITEM_KIND_LABEL } from '../../../packages/db/schema/items';
import { DISCREPANCY_DISPOSITIONS, DISCREPANCY_DISPOSITION_LABEL } from '../../../packages/db/schema/trade-discrepancies';
import { ORDER_WASTAGE_DISPOSITION_LABEL } from '../../../packages/db/schema/order-wastage';
import { WASTAGE_REASONS, WASTAGE_REASON_LABEL } from '../../../packages/domain/src/stock/wastage-reasons';
import { OFFERABLE_TO_POSITIONS } from '@shareat/domain';

// ---------------------------------------------------------------------------------------------
// Shared mocks — session, the two `@/` leaves the root vitest config never aliases, and the one
// shared data helper (`expenses/lib.ts`) every page below reaches `listStores`/`withOrgPrincipal`
// through, directly or via a re-export (items/usage/inventory/discrepancies all funnel here).
// ---------------------------------------------------------------------------------------------

const ACTOR = { orgId: 'org-1', personId: 'actor-1' };

vi.mock('../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: ACTOR })),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound() called unexpectedly — every render fixture in this file resolves');
  },
}));

vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

vi.mock('@/components/FilterRow', () => ({
  FilterRow: ({ children }: { children: unknown }) => children,
}));

const STORES_FIXTURE = [{ id: 'store-1', name: 'SmokeStore', code: 'SMK-1' }];
const withOrgPrincipalMock = vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}));

vi.mock('../src/app/expenses/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/expenses/lib')>();
  return {
    ...actual,
    listStores: vi.fn(async () => STORES_FIXTURE),
    withOrgPrincipal: (...args: [string, (tx: unknown) => unknown]) => withOrgPrincipalMock(...args),
  };
});

afterEach(() => {
  withOrgPrincipalMock.mockClear();
  withOrgPrincipalMock.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}));
});

// ---------------------------------------------------------------------------------------------
// Markup helpers — same posture as t337/S6b: parse the real rendered HTML.
// ---------------------------------------------------------------------------------------------

const MUTED_TOKENS = 'block font-mono text-[11px] text-neutral-500 dark:text-neutral-400'.split(/\s+/);
const SNAKE_CASE_RE = /\b[a-z]+(?:_[a-z]+)+\b/g;

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

function mutedSecondaryOccurrences(html: string): { text: string; index: number }[] {
  const re = /<(\w+)\s+class="([^"]*)">([^<]*)<\/\1>/g;
  const out: { text: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const classes = m[2]!.split(/\s+/);
    if (MUTED_TOKENS.every((t) => classes.includes(t))) out.push({ text: m[3]!.trim(), index: m.index });
  }
  return out;
}

/** Does `label` appear in the tag-stripped text just BEFORE `beforeIndex` in the raw html? */
function labelPrecedes(html: string, label: string, beforeIndex: number, window = 500): boolean {
  const start = Math.max(0, beforeIndex - window);
  return stripTags(html.slice(start, beforeIndex)).includes(label);
}

// =================================================================================================
// G1/G3 — admin/access-defaults grid (t337 fixture approach)
// =================================================================================================

vi.mock('../src/app/admin/access-defaults/actions', () => ({
  toggleDefaultAction: vi.fn(),
  retireStorePositionAction: vi.fn(),
  sameForEveryStoreAction: vi.fn(),
  copyDefaultsAction: vi.fn(),
}));

describe('G1 — every offerable capability shows its label; the raw key lives only in its muted secondary element, directly after the label', () => {
  it('DesktopGrid', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const positions = [{ id: 'pos-cashier', name: 'Cashier', isCanonical: true, holderCount: 2 }];
    const html = renderToStaticMarkup(
      DesktopGrid({
        storeId: 'store-1',
        positions,
        groups: gridCapabilityGroups(),
        activeDefaults: new Map(),
        overlapCounts: new Map(),
      }),
    );
    assertG1(html);
  });

  it('MobileSections', async () => {
    const { MobileSections } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const positions = [{ id: 'pos-cashier', name: 'Cashier', isCanonical: true, holderCount: 2 }];
    const html = renderToStaticMarkup(
      MobileSections({
        storeId: 'store-1',
        positions,
        groups: gridCapabilityGroups(),
        activeDefaults: new Map(),
        overlapCounts: new Map(),
      }),
    );
    assertG1(html);
  });
});

function assertG1(html: string): void {
  const visibleText = stripTags(html);
  for (const c of OFFERABLE_TO_POSITIONS) {
    expect(visibleText, `expected capabilityTitle("${c}") in visible text`).toContain(capabilityTitle(c));
  }

  const occurrences = mutedSecondaryOccurrences(html);
  // T-343 S6d — strengthened from set membership (S6b U1's own finding): a raw key rendered as
  // BOTH primary text AND inside a muted element passed the old "does some muted element have this
  // text" check regardless of the primary-text leak. Strip every muted-secondary element out of the
  // html first, then sweep what remains for a stray raw key — the same "strip-then-sweep" shape
  // `t343-s6b-admin-users-labels.test.ts`'s U1 uses.
  const withoutMutedElements = html.replace(/<(\w+)\s+class="([^"]*)">([^<]*)<\/\1>/g, (match, _tag, classAttr) => {
    const classes = (classAttr as string).split(/\s+/);
    return MUTED_TOKENS.every((t) => classes.includes(t)) ? '' : match;
  });
  const strayKeys = [...stripTags(withoutMutedElements).matchAll(SNAKE_CASE_RE)].map((m) => m[0]);
  expect(strayKeys, `raw key(s) found outside any muted secondary element: ${strayKeys.join(', ')}`).toEqual([]);

  // Spot-check ordering (label precedes its muted key) on a sample: the first, a middle, and the
  // last offerable capability — full coverage is proven by the "only inside a muted element" check
  // above; this proves the ONE relationship spec names explicitly ("directly after").
  const sample = [
    OFFERABLE_TO_POSITIONS[0]!,
    OFFERABLE_TO_POSITIONS[Math.floor(OFFERABLE_TO_POSITIONS.length / 2)]!,
    OFFERABLE_TO_POSITIONS[OFFERABLE_TO_POSITIONS.length - 1]!,
  ];
  for (const c of sample) {
    const occ = occurrences.find((o) => o.text === c);
    expect(occ, `expected a muted element for "${c}"`).toBeTruthy();
    expect(labelPrecedes(html, capabilityTitle(c), occ!.index), `label for "${c}" must precede its raw key`).toBe(true);
  }
}

describe('G3 — hidden capability values still equal the full offerable set (⛔ green now)', () => {
  it('DesktopGrid', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const positions = [{ id: 'pos-cashier', name: 'Cashier', isCanonical: true, holderCount: 2 }];
    const html = renderToStaticMarkup(
      DesktopGrid({
        storeId: 'store-1',
        positions,
        groups: gridCapabilityGroups(),
        activeDefaults: new Map(),
        overlapCounts: new Map(),
      }),
    );
    const values = new Set(
      [...html.matchAll(/<input type="hidden" name="capability" value="([^"]*)"/g)].map((m) => m[1]!),
    );
    expect(values).toEqual(new Set(OFFERABLE_TO_POSITIONS));
  });
});

// =================================================================================================
// I1/I2 — items pages
// =================================================================================================

const itemsListMock = vi.fn();
const pendingRequestsMock = vi.fn();
const duplicateCandidatesMock = vi.fn();
const getItemMock = vi.fn();
const itemPricesMock = vi.fn();
const sellabilityByStoreMock = vi.fn();

vi.mock('../src/app/items/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/items/lib')>();
  return {
    ...actual,
    listItems: (...a: unknown[]) => itemsListMock(...a),
    pendingRequests: (...a: unknown[]) => pendingRequestsMock(...a),
    duplicateCandidates: (...a: unknown[]) => duplicateCandidatesMock(...a),
    getItem: (...a: unknown[]) => getItemMock(...a),
    itemPrices: (...a: unknown[]) => itemPricesMock(...a),
    sellabilityByStore: (...a: unknown[]) => sellabilityByStoreMock(...a),
  };
});

vi.mock('../src/app/items/actions', () => ({
  approveItemRequestAction: vi.fn(),
  createItemAction: vi.fn(),
  mergeItemsAction: vi.fn(),
  rejectItemRequestAction: vi.fn(),
  requestItemAction: vi.fn(),
  clearStoreSellabilityAction: vi.fn(),
  setStoreSellabilityAction: vi.fn(),
  updateItemFlagsAction: vi.fn(),
}));

const whoSellsMock = vi.fn();
vi.mock('../src/app/ap/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/ap/lib')>();
  return { ...actual, whoSells: (...a: unknown[]) => whoSellsMock(...a) };
});

describe('I1 — items list: meat_slab / meat_sliced show their label; the kind <select> is ITEM_KINDS', () => {
  it('renders labels, no "meat slab", no snake-case token', async () => {
    itemsListMock.mockResolvedValueOnce([
      {
        id: 'item-1',
        name: 'Pork belly (slab)',
        code: 'PORK-SLAB',
        kind: 'meat_slab',
        baseUnit: 'kg',
        status: 'active',
        isPurchasable: true,
        sellableRetail: false,
        sellableWholesale: true,
      },
    ]);
    pendingRequestsMock.mockResolvedValueOnce([
      {
        id: 'req-1',
        name: 'Pork belly (sliced)',
        code: 'PORK-SLICED',
        kind: 'meat_sliced',
        baseUnit: 'kg',
        reason: null,
        status: 'requested',
        similarWarning: null,
        requestedBy: 'actor-1',
        requestedAt: new Date('2026-01-01T00:00:00Z'),
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        createdItemId: null,
      },
    ]);
    duplicateCandidatesMock.mockResolvedValueOnce([]);

    const { default: ItemsPage } = await import('../src/app/items/page');
    const html = renderToStaticMarkup(
      await ItemsPage({ searchParams: Promise.resolve({}) }),
    );
    const visibleText = stripTags(html);

    expect(visibleText).toContain(ITEM_KIND_LABEL.meat_slab);
    expect(visibleText).toContain(ITEM_KIND_LABEL.meat_sliced);
    expect(visibleText).not.toContain('meat slab');
    expect([...visibleText.matchAll(SNAKE_CASE_RE)]).toEqual([]);

    const selectBlock = /<select\s+name="kind"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(selectBlock, 'expected the kind <select>').toBeTruthy();
    const optionValues = [...selectBlock!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);
    expect(optionValues).toEqual([...ITEM_KINDS]);
  });
});

describe('I2 — item detail: a raw_material item shows "Raw material" (exact case)', () => {
  it('renders the label, not "raw material"', async () => {
    getItemMock.mockResolvedValueOnce({
      id: 'item-1',
      orgId: 'org-1',
      code: 'RAW-1',
      name: 'White onion',
      kind: 'raw_material',
      baseUnit: 'kg',
      status: 'active',
      costBasisItemId: null,
      isPurchasable: true,
      sellableRetail: false,
      sellableWholesale: false,
      notes: null,
      createdBy: 'actor-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    itemPricesMock.mockResolvedValueOnce({ history: [], movement: [], bySupplier: [] });
    whoSellsMock.mockResolvedValueOnce([]);
    sellabilityByStoreMock.mockResolvedValueOnce([]);

    const { default: ItemDetailPage } = await import('../src/app/items/[id]/page');
    const html = renderToStaticMarkup(
      await ItemDetailPage({ params: Promise.resolve({ id: 'item-1' }), searchParams: Promise.resolve({}) }),
    );
    const visibleText = stripTags(html);
    expect(visibleText).toContain('Raw material');
    expect(visibleText).not.toContain('raw material');
  });
});

// =================================================================================================
// R1/R2/R3 — inventory/usage pages
// =================================================================================================

const usageScreenDataMock = vi.fn();
const usageRecordDetailMock = vi.fn();

vi.mock('../src/app/inventory/usage/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/inventory/usage/lib')>();
  return {
    ...actual,
    usageScreenData: (...a: unknown[]) => usageScreenDataMock(...a),
    usageRecordDetail: (...a: unknown[]) => usageRecordDetailMock(...a),
  };
});

vi.mock('../src/app/inventory/usage/actions', () => ({
  saveUsageDraftAction: vi.fn(),
  deleteUsageDraftAction: vi.fn(),
  postUsageAction: vi.fn(),
  voidUsageAction: vi.fn(),
}));

let capturedNewUsageFormProps: { reasons?: readonly { value: string; label: string }[] } | null = null;
vi.mock('../src/app/inventory/usage/NewUsageForm', () => ({
  NewUsageForm: (props: { reasons?: readonly { value: string; label: string }[] }) => {
    capturedNewUsageFormProps = props;
    return null;
  },
}));

describe('R1 — usage list: a damage_storage row shows its label; NewUsageForm gets {value,label} reasons; the form file imports nothing from @shareat/', () => {
  it('renders the label, captures reasons prop, and the source has no @shareat/ import', async () => {
    capturedNewUsageFormProps = null;
    usageScreenDataMock.mockResolvedValueOnce({
      locations: [{ id: 'loc-1', code: 'MAIN', name: 'Main room' }],
      departments: [],
      items: [{ id: 'item-1', code: 'PORK', name: 'Pork', baseUnit: 'kg' }],
      records: [
        {
          id: 'rec-1',
          kind: 'wastage',
          status: 'posted',
          usedOn: '2026-01-01',
          locationName: 'Main room',
          reasonCode: 'damage_storage',
          lineCount: 1,
        },
        // T-343 S6d — a null reasonCode (a plain usage record, not wastage — reasonCode is
        // wastage-only) renders the em dash the source already falls back to, pinned exactly
        // rather than left unexercised.
        {
          id: 'rec-2',
          kind: 'usage',
          status: 'posted',
          usedOn: '2026-01-02',
          locationName: 'Main room',
          reasonCode: null,
          lineCount: 1,
        },
      ],
    });

    const { default: UsagePage } = await import('../src/app/inventory/usage/page');
    const html = renderToStaticMarkup(await UsagePage({ searchParams: Promise.resolve({}) }));
    const visibleText = stripTags(html);
    expect(visibleText).toContain(WASTAGE_REASON_LABEL.damage_storage);
    expect(visibleText).not.toContain('damage storage');

    // Only this page's Reason column shares this exact class string.
    const reasonCells = [...html.matchAll(/<td class="px-3 py-2 text-neutral-600 dark:text-neutral-400">([\s\S]*?)<\/td>/g)].map(
      (m) => stripTags(m[1]!),
    );
    expect(reasonCells, 'expected one Reason cell per record').toHaveLength(2);
    expect(reasonCells[0]).toBe(WASTAGE_REASON_LABEL.damage_storage);
    expect(reasonCells[1]).toBe('—');

    expect(capturedNewUsageFormProps).toBeTruthy();
    const reasons = capturedNewUsageFormProps!.reasons ?? [];
    expect(reasons.map((r) => r.value)).toEqual([...WASTAGE_REASONS]);
    for (const r of reasons) expect(r.label).toBe(WASTAGE_REASON_LABEL[r.value as keyof typeof WASTAGE_REASON_LABEL]);

    const formPath = join(dirname(fileURLToPath(new URL(import.meta.url))), '..', 'src', 'app', 'inventory', 'usage', 'NewUsageForm.tsx');
    const source = readFileSync(formPath, 'utf8');
    expect(source).not.toMatch(/from ['"]@shareat\//);
  });
});

describe('R2/R3 — usage detail: prep_loss shows its label; an out-of-enum reasonCode humanises rather than blank/raw', () => {
  it('R2: prep_loss', async () => {
    usageRecordDetailMock.mockResolvedValueOnce({
      record: {
        id: 'rec-1',
        orgId: 'org-1',
        storeId: 'store-1',
        locationId: 'loc-1',
        kind: 'wastage',
        status: 'draft',
        usedOn: '2026-01-01',
        departmentId: null,
        reasonCode: 'prep_loss',
        adjustmentReason: null,
        chargePersonId: null,
        postedAt: null,
        postedBy: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        createdBy: 'actor-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      locationName: 'Main room',
      lines: [],
    });
    const { default: UsageRecordPage } = await import('../src/app/inventory/usage/[id]/page');
    const html = renderToStaticMarkup(
      await UsageRecordPage({ params: Promise.resolve({ id: 'rec-1' }), searchParams: Promise.resolve({}) }),
    );
    const visibleText = stripTags(html);
    expect(visibleText).toContain(WASTAGE_REASON_LABEL.prep_loss);
    expect(visibleText).not.toContain('prep loss');
  });

  it('R3 (⛔): an out-of-enum reasonCode ("legacy_code") humanises to "Legacy code", not blank and not the raw key', async () => {
    usageRecordDetailMock.mockResolvedValueOnce({
      record: {
        id: 'rec-2',
        orgId: 'org-1',
        storeId: 'store-1',
        locationId: 'loc-1',
        kind: 'wastage',
        status: 'draft',
        usedOn: '2026-01-01',
        departmentId: null,
        reasonCode: 'legacy_code',
        adjustmentReason: null,
        chargePersonId: null,
        postedAt: null,
        postedBy: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        createdBy: 'actor-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      locationName: 'Main room',
      lines: [],
    });
    const { default: UsageRecordPage } = await import('../src/app/inventory/usage/[id]/page');
    const html = renderToStaticMarkup(
      await UsageRecordPage({ params: Promise.resolve({ id: 'rec-2' }), searchParams: Promise.resolve({}) }),
    );
    const visibleText = stripTags(html);
    expect(visibleText).toContain('Legacy code');
    expect(visibleText).not.toContain('legacy code');
    expect(visibleText).not.toContain('legacy_code');
  });
});

// =================================================================================================
// D1 — commissary/discrepancies
// =================================================================================================

vi.mock('../src/app/commissary/discrepancies/actions', () => ({
  deferDiscrepancyAction: vi.fn(),
  resolveDiscrepancyAction: vi.fn(),
}));

/** The Nth `<article>` block (0-indexed), matching `rows[N]`'s render order. */
function articleAt(html: string, n: number): string {
  const parts = html.split('<article');
  const part = parts[n + 1];
  expect(part, `expected an <article> at index ${n}`).toBeTruthy();
  return '<article' + part!;
}

/** The row's own status `<span className="text-xs text-neutral-500">`. */
function statusSpanOf(articleHtml: string): string {
  const m = /<span class="text-xs text-neutral-500">([\s\S]*?)<\/span>/.exec(articleHtml);
  expect(m, 'expected the status span').toBeTruthy();
  return stripTags(m![1]!);
}

/** The row's own "⛔ Resolved as …" paragraph, present only when `status === 'resolved'`. */
function resolvedSentenceOf(articleHtml: string): string | undefined {
  const m = /<p class="mt-3 text-sm text-neutral-500">([\s\S]*?)<\/p>/.exec(articleHtml);
  return m ? stripTags(m[1]!) : undefined;
}

describe('D1 — a resolved late_receipt row shows "Late receipt" in the status line and the resolved sentence; an open row offers every disposition; a null disposition renders no label at either site', () => {
  it('renders the label in both places, the select carries every DISCREPANCY_DISPOSITIONS value, and null stays empty', async () => {
    withOrgPrincipalMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'disc-1',
          status: 'resolved',
          disposition: 'late_receipt',
          quantity: '5',
          value: '100.00',
          deferredTo: null,
          itemName: 'Pork belly',
          unit: 'kg',
          orderId: 'order-1',
          orderDate: '2026-01-01',
          branchName: 'SmokeStore Two',
          note: null,
        },
        // T-343 S6d — an OPEN, undecided row: makes the disposition <select> render at all (D1
        // used to fixture only a resolved row, where the select never appears), and its own
        // status line is :137's null arm — no " · …" suffix.
        {
          id: 'disc-2',
          status: 'open',
          disposition: null,
          quantity: '2',
          value: '40.00',
          deferredTo: null,
          itemName: 'Pork belly',
          unit: 'kg',
          orderId: 'order-2',
          orderDate: '2026-01-02',
          branchName: 'SmokeStore Two',
          note: null,
        },
        // T-343 S6d — a RESOLVED row with no disposition on record: :151's null arm (defensive —
        // the ternary the source already has, pinned rather than left unexercised).
        {
          id: 'disc-3',
          status: 'resolved',
          disposition: null,
          quantity: '1',
          value: '10.00',
          deferredTo: null,
          itemName: 'Pork belly',
          unit: 'kg',
          orderId: 'order-3',
          orderDate: '2026-01-03',
          branchName: 'SmokeStore Two',
          note: null,
        },
      ],
      people: [],
    });

    const { default: DiscrepanciesPage } = await import('../src/app/commissary/discrepancies/page');
    const html = renderToStaticMarkup(await DiscrepanciesPage({ searchParams: Promise.resolve({}) }));
    const visibleText = stripTags(html);
    const label = DISCREPANCY_DISPOSITION_LABEL.late_receipt;
    const occurrences = visibleText.split(label).length - 1;
    expect(occurrences, 'expected the label in both the status line and the resolved sentence').toBeGreaterThanOrEqual(2);
    expect(visibleText).not.toContain('late_receipt');

    // :137's null arm — disc-2 (open, no disposition): the status span is exactly "Open", no
    // " · …" suffix leaking a raw key or an empty separator.
    expect(statusSpanOf(articleAt(html, 1))).toBe('Open');

    // :151's null arm — disc-3 (resolved, no disposition): the sentence's <strong> is empty.
    expect(resolvedSentenceOf(articleAt(html, 2))).toBe(
      '⛔ Resolved as . Correcting this is a reversal plus a new resolution, never an edit.',
    );

    // The select now renders (disc-2 is open) — its option set is exactly DISCREPANCY_DISPOSITIONS,
    // as a SET: the screen orders them by frequency of use (loss, charge, audit, late_receipt),
    // not the const's own declaration order, and this pins membership, not that ordering.
    const selectBlock = /<select\s+name="disposition"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(selectBlock, 'expected the disposition <select> now that disc-2 is open').toBeTruthy();
    const optionValues = [...selectBlock!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);
    expect(new Set(optionValues)).toEqual(new Set(DISCREPANCY_DISPOSITIONS));
  });
});

// =================================================================================================
// OW1 — wastage
// =================================================================================================

vi.mock('../src/app/wastage/actions', () => ({
  recordOrderWastageAction: vi.fn(),
}));

describe('OW1 — a recent platform_paid row shows "Platform paid"; a null-disposition row renders no disposition text', () => {
  it('renders the label; null stays blank', async () => {
    withOrgPrincipalMock
      .mockResolvedValueOnce({
        open: [],
        channels: [],
        monitor: null,
        recent: [
          {
            id: 'ow-1',
            orgId: 'org-1',
            storeId: 'store-1',
            salesDayId: 'sd-1',
            channelId: 'ch-1',
            channel: 'Foodpanda',
            orderRef: 'FP-100',
            typeMode: 'instant' as const,
            amount: '150.00',
            reason: 'Remade order',
            status: 'resolved' as const,
            disposition: 'platform_paid' as const,
            autoCharged: false,
            settlementId: null,
            journalEntryId: null,
            openedAt: new Date('2026-01-01T00:00:00Z'),
            resolvedAt: new Date('2026-01-02T00:00:00Z'),
            resolvedBy: 'actor-1',
            createdBy: 'actor-1',
          },
          {
            id: 'ow-2',
            orgId: 'org-1',
            storeId: 'store-1',
            salesDayId: 'sd-1',
            channelId: 'ch-1',
            channel: 'Foodpanda',
            orderRef: 'FP-101',
            typeMode: 'instant' as const,
            amount: '80.00',
            reason: 'Remade order',
            status: 'resolved' as const,
            disposition: null,
            autoCharged: false,
            settlementId: null,
            journalEntryId: null,
            openedAt: new Date('2026-01-01T00:00:00Z'),
            resolvedAt: new Date('2026-01-02T00:00:00Z'),
            resolvedBy: 'actor-1',
            createdBy: 'actor-1',
          },
        ],
      })
      .mockResolvedValueOnce({ businessDates: new Map(), settlements: [] });

    const { default: WastagePage } = await import('../src/app/wastage/page');
    const html = renderToStaticMarkup(await WastagePage({ searchParams: Promise.resolve({}) }));
    const visibleText = stripTags(html);
    expect(visibleText).toContain(ORDER_WASTAGE_DISPOSITION_LABEL.platform_paid);
    expect(visibleText).not.toContain('platform_paid');

    // T-343 S6d — pin the exact cell, not just "the word null is absent": "not.toContain('null')"
    // alone cannot tell an empty cell apart from a stray leaked character. Both `recent` rows are
    // resolved, so both land in "Recent history" — its Disposition <td> is the only column on this
    // page sharing this exact class string (the OPEN table's Order-ref column shares it too, but
    // this fixture's `open: []` keeps that table off the page).
    const dispositionCells = [...html.matchAll(/<td class="px-3 py-2 text-neutral-600 dark:text-neutral-400">([\s\S]*?)<\/td>/g)].map(
      (m) => stripTags(m[1]!),
    );
    expect(dispositionCells, 'expected one Disposition cell per recent row').toHaveLength(2);
    expect(dispositionCells[0]).toBe(ORDER_WASTAGE_DISPOSITION_LABEL.platform_paid);
    expect(dispositionCells[1]).toBe('');

    // T-343 S6d — the "Record a wastage" form's own disposition <select> deliberately excludes
    // `charged` (the comment above it: charging a person needs an allocation, offered only on the
    // detail page) and adds a blank "leave blank" option, so this is an exact array, not a
    // DISCREPANCY_DISPOSITIONS-style set-of-the-full-enum check.
    const recordSelectBlock = /<select name="disposition"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(recordSelectBlock, 'expected the "Record a wastage" disposition <select>').toBeTruthy();
    const recordOptionValues = [...recordSelectBlock!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);
    expect(recordOptionValues).toEqual(['', 'platform_paid', 'absorbed']);
  });
});
