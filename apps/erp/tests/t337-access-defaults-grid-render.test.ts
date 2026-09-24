/**
 * T-337 — R2 (commit 1's own deliverable). `docs/tasks/337-access-defaults-grouped-collapsible.md`
 * §5. The oracle: render `DesktopGrid` and `MobileSections` with a hand-built fixture (2 canonical
 * + 1 store-invented position, some active defaults), parse every `<form>`'s hidden name=value
 * pairs, and compare the multiset to an INDEPENDENTLY built expectation — exactly one toggle per
 * (position × each of the 91 offerable capabilities), `on` = the negation of active, plus one
 * Retire form per store-invented position.
 *
 * ⛔ Written against `grid.tsx`, which does not exist until commit 1 (pure extraction) lands — RED
 * on "Cannot find module" until then, same posture as every other T-336/T-337 delta this session.
 * `gridCapabilityGroups()` is called live (not hand-typed) so this SAME file, unmodified, stays
 * green through commit 2's regroup (§5: "R2 is green at commit 1... commit 2, with R2 unchanged
 * and still green") — the oracle asserts an invariant about the FORM SET, which does not care how
 * the cells are grouped on screen.
 *
 * `.test.ts` + `createElement` + `renderToStaticMarkup`, per `apps/erp/tests/filter-row.test.ts` —
 * a `.test.tsx` matches no glob (vitest.config.mts). `actions.ts` is mocked: importing it (via
 * `grid.tsx`) reaches `@shareat/db`/`requireActor` at module scope.
 *
 * NEGATIVE half (duplicating one capability into two areas / dropping one area) needs
 * `GridAreaGroup` to exist — deferred to the commit-2 pass of this file (R1/R3), which is added
 * once the regroup lands, not written here.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OFFERABLE_TO_POSITIONS } from '@shareat/domain';
import type { Capability } from '@shareat/auth';

vi.mock('../src/app/admin/access-defaults/actions', () => ({
  toggleDefaultAction: vi.fn(),
  retireStorePositionAction: vi.fn(),
  sameForEveryStoreAction: vi.fn(),
  copyDefaultsAction: vi.fn(),
}));

const STORE_ID = 'store-fixture-1';

const FIXTURE_POSITIONS = [
  { id: 'pos-cashier', name: 'Cashier', isCanonical: true, holderCount: 2 },
  { id: 'pos-cook', name: 'Cook', isCanonical: true, holderCount: 1 },
  { id: 'pos-prep', name: 'Prep Lead', isCanonical: false, holderCount: 0 },
] as const;

const FIXTURE_ACTIVE = new Map<string, Set<Capability>>([
  ['pos-cashier', new Set<Capability>(['record_sale', 'submit_sales_day'])],
  ['pos-cook', new Set<Capability>(['record_wastage'])],
]);

const FIXTURE_OVERLAP = new Map();

interface HiddenField {
  name: string;
  value: string;
}

/** Parses every `<form>…</form>` block into its hidden `name=value` pairs. No nested forms exist
 *  in this markup, so a non-greedy match between open and close tags is exact. */
function parseForms(html: string): HiddenField[][] {
  const forms: HiddenField[][] = [];
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/g;
  let m: RegExpExecArray | null;
  while ((m = formRe.exec(html))) {
    const body = m[1]!;
    const inputRe = /<input\b[^>]*>/g;
    const fields: HiddenField[] = [];
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(body))) {
      const tag = im[0];
      if (!/type="hidden"/.test(tag)) continue;
      const name = /name="([^"]*)"/.exec(tag)?.[1];
      const value = /value="([^"]*)"/.exec(tag)?.[1];
      if (name !== undefined && value !== undefined) fields.push({ name, value });
    }
    forms.push(fields);
  }
  return forms;
}

/** Order-independent signature: fields sorted within a form, forms sorted as a multiset. */
function formSignature(fields: HiddenField[]): string {
  return [...fields]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}=${f.value}`)
    .join('&');
}

function signatures(html: string): string[] {
  return parseForms(html)
    .map(formSignature)
    .sort();
}

/** Independently built — never derived from what the components render. One toggle per
 *  (position × each of the 91), `on` = negation of active, plus one Retire per store-invented
 *  position. */
function expectedSignatures(): string[] {
  const out: string[] = [];
  for (const p of FIXTURE_POSITIONS) {
    for (const capability of OFFERABLE_TO_POSITIONS) {
      const active = FIXTURE_ACTIVE.get(p.id)?.has(capability) ?? false;
      out.push(
        formSignature([
          { name: 'storeId', value: STORE_ID },
          { name: 'positionId', value: p.id },
          { name: 'capability', value: capability },
          { name: 'on', value: active ? 'false' : 'true' },
        ]),
      );
    }
    if (!p.isCanonical) {
      out.push(formSignature([{ name: 'storeId', value: STORE_ID }, { name: 'positionId', value: p.id }]));
    }
  }
  return out.sort();
}

describe('R2 — DesktopGrid and MobileSections render exactly one toggle per (position x capability), plus Retire forms', () => {
  it('DesktopGrid: the rendered form multiset matches the independent oracle', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: gridCapabilityGroups(),
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(signatures(html)).toEqual(expectedSignatures());
  });

  it('MobileSections: the rendered form multiset matches the SAME independent oracle', async () => {
    const { MobileSections } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const html = renderToStaticMarkup(
      createElement(MobileSections, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: gridCapabilityGroups(),
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(signatures(html)).toEqual(expectedSignatures());
  });

  it('floor: the fixture actually produces forms — a broken parser cannot pass on zero', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: gridCapabilityGroups(),
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(parseForms(html).length).toBeGreaterThan(200);
  });
});

// -------------------------------------------------------------------------------------
// R1, R3 — commit 2 (the regroup). §3's `<details>` structure and §4's token discipline.
// ⚠️ First draft against the SPEC TEXT (§2-§4), not yet against real commit-2 markup — commit 2
// hasn't landed, so exact class names/attribute order may need a follow-up pass once it has.
// Counts are derived from `gridCapabilityGroups()`'s own live `.areas` output, never hard-coded,
// so this survives an area moving without becoming a second source of truth (T-337 §1's own rule).
// -------------------------------------------------------------------------------------

interface ParsedTag {
  tag: string;
  attrs: string;
  openIndex: number;
}

/** Every `<details ...>` opening tag, with its raw attribute string (for `open`/`class` checks)
 *  and the index of the NEXT tag right after it (a crude but sufficient "first child" probe for
 *  static, non-nested-details markup). */
function detailsTags(html: string): ParsedTag[] {
  const re = /<details\b([^>]*)>/g;
  const out: ParsedTag[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ tag: 'details', attrs: m[1]!, openIndex: m.index + m[0].length });
  return out;
}

function classTokens(attrs: string): string[] {
  const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? '';
  return cls.split(/\s+/).filter(Boolean);
}

describe('R1 — one <details> per scope and per area; scope carries open, area does not', () => {
  it('DesktopGrid: <details> count equals rendered scopes + rendered areas, from the live grouping', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const renderedScopes = groups.filter((g) => g.areas.length > 0);
    const expectedDetailsCount = renderedScopes.length + renderedScopes.reduce((n, g) => n + g.areas.length, 0);

    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(detailsTags(html).length).toBe(expectedDetailsCount);
  });

  it('NEGATIVE: area <details> carry no open attribute; new elements carry no dark: or neutral- token', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    const withOpen = detailsTags(html).filter((d) => /\bopen\b/.test(d.attrs)).length;
    const renderedScopes = groups.filter((g) => g.areas.length > 0).length;
    expect(withOpen, 'exactly the rendered SCOPE tags carry open; area tags never do').toBe(renderedScopes);

    for (const d of detailsTags(html)) {
      for (const token of classTokens(d.attrs)) {
        expect(token.startsWith('dark:'), `<details> class "${token}" — T-334 slice 3 forbids new dark: classes`).toBe(false);
        expect(token.startsWith('neutral-'), `<details> class "${token}" — new markup must use tokens (bg-surface/border-surface-border/text-ink), not neutral-*`).toBe(false);
      }
    }
  });
});

describe('R3 — exactly one Retire form per store-invented position; area tables carry none', () => {
  it('DesktopGrid: total Retire forms equals the count of store-invented positions in the fixture (1)', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: gridCapabilityGroups(),
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    const retireForms = parseForms(html).filter(
      (fields) => fields.some((f) => f.name === 'positionId') && !fields.some((f) => f.name === 'capability'),
    );
    const storeInvented = FIXTURE_POSITIONS.filter((p) => !p.isCanonical).length;
    expect(retireForms.length).toBe(storeInvented);
  });

  it('every <colgroup> in the grid is byte-identical (§3: one shared component, so columns align)', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: gridCapabilityGroups(),
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    const colgroups = html.match(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/g) ?? [];
    expect(colgroups.length, 'one table per rendered area plus the header table').toBeGreaterThan(1);
    expect(new Set(colgroups).size, 'every colgroup must be identical, or columns cannot align across tables').toBe(1);
  });
});
