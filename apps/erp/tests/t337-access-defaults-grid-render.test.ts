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
 * NEGATIVE half (duplicating one capability into two areas / dropping one area): commit 2 has
 * landed, so `GridAreaGroup` exists — see the `describe('R2 NEGATIVE — …')` block below, which
 * mutates a real `gridCapabilityGroups()` result rather than hand-building one, so it stays true
 * to the live shape.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OFFERABLE_TO_POSITIONS } from '@shareat/domain';
import type { Capability } from '@shareat/auth';
import type { GridAreaGroup, GridScopeGroup } from '../src/app/admin/access-defaults/lib';

vi.mock('../src/app/admin/access-defaults/actions', () => ({
  toggleDefaultAction: vi.fn(),
  retireStorePositionAction: vi.fn(),
  sameForEveryStoreAction: vi.fn(),
  copyDefaultsAction: vi.fn(),
}));

const STORE_ID = 'store-fixture-1';

const FIXTURE_POSITIONS = [
  { id: 'pos-cashier', name: 'Cashier', isCanonical: true, holderCount: 2 },
  { id: 'pos-cook', name: 'Kitchen Staff', isCanonical: true, holderCount: 1 },
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
// Audit finding 2 (2026-09-24) — the R2 oracle must actually CATCH a bad grouping, not just agree
// with a correct one. Both mutations below start from a real `gridCapabilityGroups()` result
// (never hand-built), so they mutate the live shape rather than a stand-in for it.
// -------------------------------------------------------------------------------------

/** Duplicates the FIRST store-scoped area's first capability into the SECOND store-scoped area
 *  too, so that one capability now renders twice (two forms per position instead of one). */
function withOneCapabilityDuplicatedAcrossAreas(groups: readonly GridScopeGroup[]): GridScopeGroup[] {
  return groups.map((g) => {
    if (g.scope !== 'store' || g.areas.length < 2) return g;
    const [first, second, ...rest] = g.areas as GridAreaGroup[];
    const dupCap = first!.capabilities[0]!;
    return { ...g, areas: [first!, { ...second!, capabilities: [...second!.capabilities, dupCap] }, ...rest] };
  });
}

/** Drops the first store-scoped area entirely, so its capabilities render nowhere. */
function withOneAreaDropped(groups: readonly GridScopeGroup[]): GridScopeGroup[] {
  return groups.map((g) => (g.scope === 'store' && g.areas.length > 0 ? { ...g, areas: g.areas.slice(1) } : g));
}

describe('R2 NEGATIVE — the form-set oracle must fail on a bad grouping, not just pass on a good one', () => {
  it('a capability duplicated into two areas makes the rendered form multiset disagree with the oracle', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const mutated = withOneCapabilityDuplicatedAcrossAreas(gridCapabilityGroups());
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: mutated,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(signatures(html)).not.toEqual(expectedSignatures());
  });

  it('a dropped area makes the rendered form multiset disagree with the oracle', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const mutated = withOneAreaDropped(gridCapabilityGroups());
    const html = renderToStaticMarkup(
      createElement(DesktopGrid, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups: mutated,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    expect(signatures(html)).not.toEqual(expectedSignatures());
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

function isRetireForm(fields: HiddenField[]): boolean {
  return fields.some((f) => f.name === 'positionId') && !fields.some((f) => f.name === 'capability');
}

// -------------------------------------------------------------------------------------
// Audit findings 4/5 (2026-09-24) — the dark:/neutral- scan must cover every NEW element, not only
// <details> tags (summaries and the new area table/thead/th were never scanned before), and
// "neutral-" must be matched as a TOKEN, not a whole-string prefix: `bg-neutral-50` never STARTS
// WITH "neutral-", so the original `token.startsWith('neutral-')` check could never fire on real
// Tailwind classes.
// -------------------------------------------------------------------------------------

function summaryBlocks(html: string): string[] {
  return html.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/g) ?? [];
}

/** Every table's own opening tag + its `<thead>…</thead>`, excluding the first table (the
 *  pre-existing header table, unchanged by T-337) and excluding every `<tbody>` (which still
 *  holds the pre-existing, legitimately dark:/neutral- styled ToggleButton/InheritedBadge/Retire
 *  button — those are reused components, not new markup). */
function newAreaTableHeadBlocks(html: string): string[] {
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = tableRe.exec(html))) {
    i++;
    if (i === 1) continue; // the header table.
    const thead = /<thead\b[^>]*>[\s\S]*?<\/thead>/.exec(m[2]!)?.[0] ?? '';
    out.push(`<table${m[1]!}>${thead}`);
  }
  return out;
}

function allClassTokensIn(html: string): string[] {
  const out: string[] = [];
  const re = /class="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(...m[1]!.split(/\s+/).filter(Boolean));
  return out;
}

const NEUTRAL_TOKEN = /(^|:|-)neutral-/;

/** The start index of the last `<details ...>` OPENING TAG occurring before `textIdx` — used to
 *  split desktop markup into "store scope and everything nested in it" vs "org scope and
 *  everything nested in it" at the ORG SCOPE'S OWN `<details>` tag, not at the text inside its
 *  summary (which would misclassify that very tag as belonging to the store region). */
function detailsTagStartBefore(html: string, textIdx: number): number {
  const re = /<details\b[^>]*>/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && m.index < textIdx) last = m.index;
  return last;
}

function assertNoDarkOrNeutral(tokens: string[], context: string): void {
  for (const token of tokens) {
    expect(token.startsWith('dark:'), `${context} class "${token}" — T-334 slice 3 forbids new dark: classes`).toBe(false);
    expect(NEUTRAL_TOKEN.test(token), `${context} class "${token}" — new markup must use tokens (bg-surface/border-surface-border/text-ink), not neutral-*`).toBe(false);
  }
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

  it('NEGATIVE: area <details> carry no open attribute; every NEW element carries no dark: or neutral- token', async () => {
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

    assertNoDarkOrNeutral(detailsTags(html).flatMap((d) => classTokens(d.attrs)), '<details>');
    assertNoDarkOrNeutral(allClassTokensIn(summaryBlocks(html).join('\n')), '<summary> (scope + area — desktop has no other kind)');
    assertNoDarkOrNeutral(allClassTokensIn(newAreaTableHeadBlocks(html).join('\n')), 'area <table>/<thead>/<th>');
  });

  it('MobileSections: <details> count is per-position × (rendered scopes + areas); only scope tags (and the first position) carry open', async () => {
    const { MobileSections } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const renderedScopes = groups.filter((g) => g.areas.length > 0).length;
    const totalAreas = groups.reduce((n, g) => n + g.areas.length, 0);
    const html = renderToStaticMarkup(
      createElement(MobileSections, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );

    const expectedTotalDetails = FIXTURE_POSITIONS.length * (1 + renderedScopes + totalAreas);
    expect(detailsTags(html).length, 'one <details> per position, per (position x rendered scope), per (position x area)').toBe(
      expectedTotalDetails,
    );

    const expectedOpen = 1 /* first position, unchanged default */ + FIXTURE_POSITIONS.length * renderedScopes; /* every scope, every position, unconditionally open */
    const openCount = detailsTags(html).filter((d) => /\bopen\b/.test(d.attrs)).length;
    expect(openCount, 'every SCOPE tag open, per position, plus the first position; no area tag open').toBe(expectedOpen);
  });

  it('MobileSections NEGATIVE: the scope/area <summary> elements carry no dark: or neutral- token', async () => {
    const { MobileSections } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const renderedScopes = groups.filter((g) => g.areas.length > 0).length;
    const totalAreas = groups.reduce((n, g) => n + g.areas.length, 0);
    const html = renderToStaticMarkup(
      createElement(MobileSections, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
      }),
    );
    // The per-POSITION summary is unchanged/pre-existing and legitimately still carries its own
    // dark:/neutral- holder-count classes — identified (not assumed) by containing "holder(s)",
    // which only that summary ever renders.
    const newSummaries = summaryBlocks(html).filter((s) => !/\bholders?\b/.test(s));
    expect(newSummaries.length, 'one summary per (position x rendered scope) plus per (position x area)').toBe(
      FIXTURE_POSITIONS.length * (renderedScopes + totalAreas),
    );
    assertNoDarkOrNeutral(allClassTokensIn(newSummaries.join('\n')), 'mobile scope/area <summary>');
  });
});

describe('R3 — exactly one Retire form per store-invented position; area tables carry none', () => {
  it('DesktopGrid: every Retire form lives in the header table; zero live in any area table (audit finding 6)', async () => {
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
    const tables = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/g) ?? [];
    const [headerTable, ...areaTables] = tables;
    const storeInvented = FIXTURE_POSITIONS.filter((p) => !p.isCanonical).length;

    const retireInHeader = parseForms(headerTable ?? '').filter(isRetireForm).length;
    const retireInAreas = areaTables.reduce((n, t) => n + parseForms(t).filter(isRetireForm).length, 0);
    expect(tables.length, 'header table plus one per rendered area').toBeGreaterThan(1);
    expect(retireInHeader, 'every Retire form is inside the header table').toBe(storeInvented);
    expect(retireInAreas, 'no area table carries a Retire form').toBe(0);
  });

  it('MobileSections: exactly one Retire form per store-invented position', async () => {
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
    const storeInvented = FIXTURE_POSITIONS.filter((p) => !p.isCanonical).length;
    expect(parseForms(html).filter(isRetireForm).length).toBe(storeInvented);
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

// -------------------------------------------------------------------------------------------
// Amendment A1 (2026-09-24) — S5 failed (every area closes on a toggle's redirect(); tester
// `webapps-30`, 3x reproduced, `t337-s5-STOP-evidence.png`). Ian ruled the server reopens what the
// user was working in. The builder has since wired `openCapability`/`openPositionId` through
// `DesktopGrid`/`MobileSections` and `parseOpenParams` through `lib.ts` (green, 2026-09-24) — the
// `@ts-expect-error` comments this block briefly needed while those were RED (missing
// props/export) have been removed now that the props/export are real.
// -------------------------------------------------------------------------------------------

describe('R4 (Amendment A1) — openCapability opens exactly that capability’s area, in its own scope only', () => {
  it('a store-scoped capability (record_stock_movement, area "inventory") opens only the STORE inventory area', async () => {
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
        openCapability: 'record_stock_movement' as const,
      }),
    );
    const textIdx = html.indexOf('org-scoped');
    expect(textIdx, 'fixture must render both scopes for this test to mean anything').toBeGreaterThan(-1);
    const orgScopeStart = detailsTagStartBefore(html, textIdx);
    const storeRegion = html.slice(0, orgScopeStart);
    const orgRegion = html.slice(orgScopeStart);
    const storeOpen = detailsTags(storeRegion).filter((d) => /\bopen\b/.test(d.attrs));
    const orgOpen = detailsTags(orgRegion).filter((d) => /\bopen\b/.test(d.attrs));

    expect(storeOpen.length, 'store scope itself, plus exactly the one opened (inventory) area').toBe(2);
    expect(orgOpen.length, "NEGATIVE — org's own inventory area (same area id, other scope) must stay closed").toBe(1);
  });

  it('an org-only capability (run_cutover, area "books") opens only the ORG books area', async () => {
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
        openCapability: 'run_cutover' as const,
      }),
    );
    const textIdx = html.indexOf('org-scoped');
    const orgScopeStart = detailsTagStartBefore(html, textIdx);
    const storeRegion = html.slice(0, orgScopeStart);
    const orgRegion = html.slice(orgScopeStart);
    const storeOpen = detailsTags(storeRegion).filter((d) => /\bopen\b/.test(d.attrs));
    const orgOpen = detailsTags(orgRegion).filter((d) => /\bopen\b/.test(d.attrs));

    expect(storeOpen.length, "store's own books area (2 offered caps there) must stay closed").toBe(1);
    expect(orgOpen.length, 'org scope itself, plus exactly the one opened (books) area').toBe(2);
  });

  it('absent openCapability changes nothing: markup stays byte-identical to no-prop rendering (contract point 4)', async () => {
    const { DesktopGrid } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const props = { storeId: STORE_ID, positions: FIXTURE_POSITIONS, groups, activeDefaults: FIXTURE_ACTIVE, overlapCounts: FIXTURE_OVERLAP };
    const withoutProp = renderToStaticMarkup(createElement(DesktopGrid, props));
    const withUndefined = renderToStaticMarkup(createElement(DesktopGrid, { ...props, openCapability: undefined } as never));
    expect(withUndefined).toBe(withoutProp);
  });
});

describe('R5 (Amendment A1) — mobile: openPositionId opens exactly that position, and its matching area', () => {
  it('openPositionId=pos-cook opens only Cook (not Cashier/Prep Lead), and its inventory area', async () => {
    const { MobileSections } = await import('../src/app/admin/access-defaults/grid');
    const { gridCapabilityGroups } = await import('../src/app/admin/access-defaults/lib');
    const groups = gridCapabilityGroups();
    const html = renderToStaticMarkup(
      createElement(MobileSections, {
        storeId: STORE_ID,
        positions: FIXTURE_POSITIONS,
        groups,
        activeDefaults: FIXTURE_ACTIVE,
        overlapCounts: FIXTURE_OVERLAP,
        openPositionId: 'pos-cook',
        openCapability: 'record_stock_movement' as const,
      }),
    );

    const isOpenJustBefore = (haystack: string, idx: number, windowSize = 400): boolean => {
      if (idx === -1) return false;
      const tags = [...haystack.slice(Math.max(0, idx - windowSize), idx).matchAll(/<details\b([^>]*)>/g)];
      const last = tags.at(-1);
      return last ? /\bopen\b/.test(last[1]!) : false;
    };

    const cashierIdx = html.indexOf('Cashier');
    const cookIdx = html.indexOf('Kitchen Staff');
    const prepIdx = html.indexOf('Prep Lead');
    expect([cashierIdx, cookIdx, prepIdx].every((i) => i !== -1), 'fixture must render all three positions').toBe(true);

    // Position-level open: Cook only.
    expect(isOpenJustBefore(html, cashierIdx), 'Cashier (default first-open) must NOT be open when pos is overridden').toBe(false);
    expect(isOpenJustBefore(html, cookIdx), 'Cook (openPositionId) must be open').toBe(true);
    expect(isOpenJustBefore(html, prepIdx), 'Prep Lead must not be open').toBe(false);

    // Area-level open, WITHIN each position's own region: Inventory open only inside Cook's block.
    const cashierRegion = html.slice(cashierIdx, cookIdx);
    const cookRegion = html.slice(cookIdx, prepIdx);
    const prepRegion = html.slice(prepIdx);
    expect(isOpenJustBefore(cashierRegion, cashierRegion.indexOf('Inventory')), "Cashier's own copy of Inventory stays closed").toBe(false);
    expect(isOpenJustBefore(cookRegion, cookRegion.indexOf('Inventory')), "Cook's Inventory area (matching openCapability) opens").toBe(true);
    expect(isOpenJustBefore(prepRegion, prepRegion.indexOf('Inventory')), "Prep Lead's own copy of Inventory stays closed").toBe(false);
  });
});

describe('R7 (Amendment A1) — parseOpenParams: untrusted searchParams become a validated pair', () => {
  const positionIds = FIXTURE_POSITIONS.map((p) => p.id);

  it('a valid capability + position pair passes through', async () => {
    const lib = await import('../src/app/admin/access-defaults/lib');
    const result = lib.parseOpenParams({ cap: 'record_sale', pos: 'pos-cashier' }, positionIds);
    expect(result).toEqual({ openCapability: 'record_sale', openPositionId: 'pos-cashier' });
  });

  it('no params at all -> both fields undefined', async () => {
    const lib = await import('../src/app/admin/access-defaults/lib');
    const result = lib.parseOpenParams({}, positionIds);
    expect(result).toEqual({ openCapability: undefined, openPositionId: undefined });
  });

  it('cap=bogus_cap is not a real Capability -> openCapability undefined, but a valid pos still resolves (one bad param must not nuke the other)', async () => {
    const lib = await import('../src/app/admin/access-defaults/lib');
    const result = lib.parseOpenParams({ cap: 'bogus_cap', pos: 'pos-cashier' }, positionIds);
    expect(result.openCapability).toBeUndefined();
    expect(result.openPositionId, 'independent validation: a bad cap must not also blank out a good pos').toBe('pos-cashier');
  });

  it("pos is not one of the rendered grid's position ids -> openPositionId undefined, but a valid cap still resolves", async () => {
    const lib = await import('../src/app/admin/access-defaults/lib');
    const result = lib.parseOpenParams({ cap: 'record_sale', pos: 'pos-does-not-exist' }, positionIds);
    expect(result.openPositionId).toBeUndefined();
    expect(result.openCapability, 'independent validation: a bad pos must not also blank out a good cap').toBe('record_sale');
  });

  it('array-valued params (repeated query key) are rejected outright, not just the first value taken', async () => {
    const lib = await import('../src/app/admin/access-defaults/lib');
    const result = lib.parseOpenParams({ cap: ['record_sale', 'void_sales_day'], pos: ['pos-cashier', 'pos-cook'] }, positionIds);
    expect(result).toEqual({ openCapability: undefined, openPositionId: undefined });
  });
});
