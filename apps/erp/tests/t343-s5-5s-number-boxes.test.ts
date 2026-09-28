/**
 * T-343 S5.5s — DEF-470, money half. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5s
 * item 1, TESTER path "R-legs, one per converted box".
 *
 * ⛔ TESTER, not BUILDER. Every listed `<input>` still carries `type="number"`, `step`, and (where
 * present) `min`/`max` — measured directly below, never presumed.
 *
 * Two components are `'use client'` (`RecordTransferForm.tsx`, `SettlementForm.tsx`) — rendered for
 * real via `renderToStaticMarkup`, matching this repo's own render-test convention. The five SERVER
 * pages each need their own real data-fetching chain (`requirePageAccess` + several page-local
 * `lib.ts` reads with distinct shapes) to reach the box at all; building five full page fixtures for
 * a check that is a LITERAL JSX attribute would be disproportionate to what it proves. Read the raw
 * source text instead and assert on the actual `<input .../>` tag — every attribute under test here
 * is a hard-coded string in source, never computed, so this is exactly as strong as a render for
 * this specific claim (same posture as this repo's own `touch-target-baseline.json`, class-keyed
 * against source). Flagged, not silently substituted — say if a real render is wanted instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');

/**
 * `nameLiteral` is the EXACT source substring that appears right after `name=` in the JSX — a
 * plain `"foo"` for a literal name, or the template-literal form (`` {`lineAmount_${i}`} ``) for a
 * computed one. Finds that substring, then the nearest `<input` opening before it and the `>`
 * closing it — a source-text scan, not a regex reconstruction of JSX, so a template literal and a
 * plain string attribute both just work.
 *
 * ⭐ Orchestrator ruling — asserts the box is found EXACTLY ONCE before checking anything about it,
 * so a refactor that moves the box elsewhere (or duplicates it) fails loudly here instead of this
 * function silently returning whatever it happens to find first, or a vacuous pass.
 */
function inputTagFor(filePath: string, nameLiteral: string): string {
  const src = readFileSync(resolve(repoRoot, filePath), 'utf8');
  const needle = `name=${nameLiteral}`;
  const occurrences = src.split(needle).length - 1;
  expect(occurrences, `"${needle}" must appear exactly once in ${filePath}`).toBe(1);

  const nameIdx = src.indexOf(needle);
  const tagStart = src.lastIndexOf('<input', nameIdx);
  expect(tagStart, `no preceding <input for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  // Anchor on the tag's real close (`/>`), not the first `>` — an inline `onChange={(e) => …}`
  // arrow function's own `>` sits before the tag actually closes and would truncate the slice early.
  const tagEnd = src.indexOf('/>', nameIdx);
  expect(tagEnd, `no self-closing "/>" found for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  return src.slice(tagStart, tagEnd + 2);
}

function assertConverted(filePath: string, nameLiteral: string) {
  const tag = inputTagFor(filePath, nameLiteral);
  expect(tag, `${filePath} ${nameLiteral}: must not carry type="number"`).not.toMatch(/type=["']number["']/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a step= attribute`).not.toMatch(/\bstep=/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a min= attribute`).not.toMatch(/\bmin=/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a max= attribute`).not.toMatch(/\bmax=/);
  expect(tag, `${filePath} ${nameLiteral}: must carry inputMode="decimal"`).toMatch(/inputMode=["']decimal["']/);
}

describe('R-legs — source-text: each converted box has no type="number"/step/min/max, and inputMode="decimal"', () => {
  it('payroll/separations/page.tsx — separationPayAmount', () => {
    assertConverted('apps/erp/src/app/payroll/separations/page.tsx', '"separationPayAmount"');
  });
  it('money-accounts/page.tsx — overdraftLimit', () => {
    assertConverted('apps/erp/src/app/money-accounts/page.tsx', '"overdraftLimit"');
  });
  it('owners/page.tsx — ownershipPercentage', () => {
    assertConverted('apps/erp/src/app/owners/page.tsx', '"ownershipPercentage"');
  });
  it('owners/page.tsx — drawingLimit', () => {
    assertConverted('apps/erp/src/app/owners/page.tsx', '"drawingLimit"');
  });
  it('owners/[id]/page.tsx — acknowledgedAmount', () => {
    assertConverted('apps/erp/src/app/owners/[id]/page.tsx', '"acknowledgedAmount"');
  });
  it('cash-requests/[id]/page.tsx — returnedAmount', () => {
    assertConverted('apps/erp/src/app/cash-requests/[id]/page.tsx', '"returnedAmount"');
  });
  it('cash-requests/[id]/page.tsx — shortAmount', () => {
    assertConverted('apps/erp/src/app/cash-requests/[id]/page.tsx', '"shortAmount"');
  });
  it('remittance/page.tsx — lineAmount_${i}', () => {
    assertConverted('apps/erp/src/app/remittance/page.tsx', '{`lineAmount_${i}`}');
  });
  it('remittance/page.tsx — lineOverage_${i}', () => {
    assertConverted('apps/erp/src/app/remittance/page.tsx', '{`lineOverage_${i}`}');
  });
});

// =================================================================================================
// The two 'use client' components — rendered for real.
// =================================================================================================

function formsIn(html: string): string[] {
  return html.match(/<input\b[^>]*>/g) ?? [];
}
function inputByName(html: string, name: string): string | undefined {
  return formsIn(html).find((tag) => new RegExp(`name="${name}"`).test(tag));
}

async function renderTransferForm(): Promise<string> {
  const { RecordTransferForm } = await import('../src/app/money-transfers/RecordTransferForm');
  return renderToStaticMarkup(createElement(RecordTransferForm, { action: () => {}, options: [], today: '2026-01-01' }));
}

describe('R-legs — real render: RecordTransferForm.tsx amountIn', () => {
  it('no type="number"/step/min/max; inputMode="decimal" kept', async () => {
    const html = await renderTransferForm();
    const tag = inputByName(html, 'amountIn');
    expect(tag, 'expected the amountIn input').toBeTruthy();
    expect(tag).not.toMatch(/type="number"/);
    expect(tag).not.toMatch(/\bstep="/);
    expect(tag).not.toMatch(/\bmin="/);
    expect(tag).not.toMatch(/\bmax="/);
    expect(tag).toMatch(/inputMode="decimal"/);
  });

  // T-343 S5.5v ruled edit: amountOut is now converted (spec §S5.5v BUILDER path
  // `money-transfers/RecordTransferForm.tsx`) — flipped from the "stays a real number spinner" pin
  // to this slice's own R-leg assertion. Red until S5.5v's BUILDER lands.
  it('amountOut: no type="number"/step/min/max; inputMode="decimal" (S5.5v R-leg)', async () => {
    const html = await renderTransferForm();
    const tag = inputByName(html, 'amountOut');
    expect(tag, 'expected the amountOut input').toBeTruthy();
    expect(tag).not.toMatch(/type="number"/);
    expect(tag).not.toMatch(/\bstep="/);
    expect(tag).not.toMatch(/\bmin="/);
    expect(tag).not.toMatch(/\bmax="/);
    expect(tag).toMatch(/inputMode="decimal"/);
  });
});

describe('R-legs — real render: SettlementForm.tsx deductions + loanAmount', () => {
  const DEDUCTION_NAMES = ['commission', 'platformFee', 'vatOnFees', 'marketing', 'withholdingTax', 'penalty'];

  async function render() {
    const { SettlementForm } = await import('../src/app/channel-settlements/SettlementForm');
    return renderToStaticMarkup(
      createElement(SettlementForm, {
        postAction: () => {},
        previewAction: async () => ({ ok: false, error: 'unused' }) as never,
        channels: [
          {
            id: 'channel-1',
            name: 'GrabFood',
            storeId: 'store-1',
            storeName: 'SmokeStore',
            outstanding: '0.00',
            destinationAccountName: null,
            destinationMoneyAccountId: null,
          },
        ],
        days: [{ salesDayId: 'day-1', channelId: 'channel-1', businessDate: '2026-01-15', reportedAmount: '1000.00', ageDays: 1 }],
        loans: [],
        today: '2026-01-01',
      }),
    );
  }

  it.each(DEDUCTION_NAMES)('%s: no type="number"/step/min/max; inputMode="decimal" kept', async (name) => {
    const html = await render();
    const tag = inputByName(html, name);
    expect(tag, `expected the ${name} input`).toBeTruthy();
    expect(tag).not.toMatch(/type="number"/);
    expect(tag).not.toMatch(/\bstep="/);
    expect(tag).not.toMatch(/\bmin="/);
    expect(tag).not.toMatch(/\bmax="/);
    expect(tag).toMatch(/inputMode="decimal"/);
  });

  it('loanAmount: no type="number"/step/min/max; inputMode="decimal" kept', async () => {
    const html = await render();
    const tag = inputByName(html, 'loanAmount');
    expect(tag, 'expected the loanAmount input').toBeTruthy();
    expect(tag).not.toMatch(/type="number"/);
    expect(tag).not.toMatch(/\bstep="/);
    expect(tag).not.toMatch(/\bmin="/);
    expect(tag).not.toMatch(/\bmax="/);
    expect(tag).toMatch(/inputMode="decimal"/);
  });

  // T-343 S5.5v ruled edit: grossAmount/netDeposited are now converted (spec §S5.5v BUILDER path
  // `channel-settlements/SettlementForm.tsx`) — flipped from the "stay real number spinners" pin to
  // this slice's own R-leg assertion. Red until S5.5v's BUILDER lands.
  it.each(['grossAmount', 'netDeposited'])('%s: no type="number"/step/min/max; inputMode="decimal" (S5.5v R-leg)', async (name) => {
    const html = await render();
    const tag = inputByName(html, name);
    expect(tag, `expected the ${name} input`).toBeTruthy();
    expect(tag).not.toMatch(/type="number"/);
    expect(tag).not.toMatch(/\bstep="/);
    expect(tag).not.toMatch(/\bmin="/);
    expect(tag).not.toMatch(/\bmax="/);
    expect(tag).toMatch(/inputMode="decimal"/);
  });
});
