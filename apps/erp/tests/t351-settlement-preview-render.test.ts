/**
 * T-351 (DEF-482) — `docs/tasks/351-def-480-483-0944455-review-followups.md` §Legs R1-R4.
 *
 * ⛔ TESTER, not BUILDER. `SettlementPreviewFigures` does not exist yet — the `<dl>` block is
 * still inline inside `SettlementForm`, always rendered, with no `figuresComputed` gate and no
 * "reconciles exactly" tone rule tied to `blockers`. Every leg below is expected red because the
 * import itself resolves to `undefined` (no such export on the module) — the FIRST assertion each
 * test makes is the one that actually fails; state plainly that this is the red, not a deeper one.
 *
 * Harness: `renderToStaticMarkup`, as in `t343-s5-5r-prepaid-refund-render.test.ts`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettlementPreviewFigures, type PreviewShape } from '../src/app/channel-settlements/SettlementForm';

function basePreview(overrides: Partial<PreviewShape> = {}): PreviewShape {
  return {
    channelName: 'Foodpanda',
    outstanding: '1000.00',
    outstandingCleared: '1000.00',
    feesTotal: '50.00',
    loanDeduction: '0.00',
    netDeposited: '950.00',
    variance: '0.00',
    settlementGain: '0.00',
    tolerance: '1.00',
    destinationAccountName: 'Bank A',
    blockers: [],
    needsGainAcknowledgement: false,
    figuresComputed: true,
    ...overrides,
  };
}

function renderFigures(preview: PreviewShape): string {
  const element = SettlementPreviewFigures({ preview });
  return renderToStaticMarkup(element as never);
}

describe('R1 — figuresComputed:false renders no figure rows, just the placeholder sentence', () => {
  it(
    'no "reconciles exactly", no "Banked", no "This settlement clears"; contains the placeholder sentence — ' +
      'was red today: SettlementPreviewFigures does not exist (the import resolves to undefined)',
    () => {
      const html = renderFigures(
        basePreview({ figuresComputed: false, variance: '0.00', settlementGain: '0.00', blockers: ['Some config blocker.'] }),
      );
      expect(html, 'expected no reconcile row when figures were never computed').not.toContain('reconciles exactly');
      expect(html).not.toContain('Banked');
      expect(html).not.toContain('This settlement clears');
      expect(html, 'expected the placeholder sentence').toContain(
        'The arithmetic appears once every figure reads as an amount — fix the ones listed below, then check again.',
      );
    },
  );
});

describe('R2 — figuresComputed:true, variance 0, but a blocker: "reconciles exactly" shows with NO good tone', () => {
  it(
    '"reconciles exactly" present, its row carries no text-emerald-700 — ' +
      'was red today: the export does not exist',
    () => {
      const html = renderFigures(basePreview({ figuresComputed: true, variance: '0.00', settlementGain: '0.00', blockers: ['No payout account set.'] }));
      expect(html).toContain('reconciles exactly');
      const rowMatch = /<div[^>]*>[\s\S]*?reconciles exactly[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? html;
      expect(rowMatch, 'a blocker means no good tone, even though it reconciles').not.toContain('text-emerald-700');
    },
  );
});

describe('R3 (then a guard) — figuresComputed:true, variance 0, no blockers: "reconciles exactly" WITH good tone', () => {
  it(
    '"reconciles exactly" carries text-emerald-700 — was red today: the export does not exist',
    () => {
      const html = renderFigures(basePreview({ figuresComputed: true, variance: '0.00', settlementGain: '0.00', blockers: [] }));
      expect(html).toContain('reconciles exactly');
      expect(html).toContain('text-emerald-700');
    },
  );
});

describe('R4 (then a guard) — figuresComputed:true, a real variance: the Shortfall row shows, no "reconciles exactly"', () => {
  it(
    'the Shortfall row is present; "reconciles exactly" is absent — was red today: the export does not exist',
    () => {
      const html = renderFigures(basePreview({ figuresComputed: true, variance: '12.00', settlementGain: '0.00', blockers: [] }));
      expect(html).toContain('Shortfall');
      expect(html).not.toContain('reconciles exactly');
    },
  );
});
