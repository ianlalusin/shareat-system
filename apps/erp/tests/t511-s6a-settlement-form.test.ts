/**
 * T-511 S6a (TESTER, 7 Nov 2026) - the manual settlement form and its two actions after the loan-legs / acknowledged-difference change.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6a": "Manual form keeps a single loan picker, passing a one-element list (no new UI beyond that)", and the
 * acknowledgement of a difference of either sign. House pattern: t343-s5-5s-number-boxes.test.ts (source text of a literal JSX attribute) and
 * t351-settlement-preview-render.test.ts (an exported presentational component rendered with renderToStaticMarkup).
 *
 * RED TODAY: the actions still pass `loan` and `recognizeGain`, the form has no reason field and reads `needsGainAcknowledgement`.
 *
 * PINNED (builder meets these or asks BOSS to change the tests):
 *  F1  actions.ts: `previewSettlementAction` and `recordSettlementAction` pass `loanLegs`, never `loan`. The list is ONE object `{ loanId, amount, ownerStoreId }`
 *      built from the single picker, or `[]` when no loan is picked (or the amount is blank). They pass `acknowledgeDifference: { reason }` when the form sent a
 *      reason, from a field named `differenceReason` (`PreviewRequest.differenceReason: string` replaces `recognizeGain: boolean`).
 *  F2  SettlementForm.tsx posts the reason in ONE field named `differenceReason`, as a HIDDEN input mirrored from state (the T-343 5.5v lesson written beside
 *      the old `recognizeGain` field: the visible acknowledgement unmounts when the next check clears the blocker, so a field that only lives inside it would
 *      be missing at submit time).
 *  F3  SettlementForm.tsx exports `DifferenceAcknowledgement({ preview, reason, onReasonChange })`, a hook-free presentational component (like
 *      `SettlementPreviewFigures`). Nothing when `preview.needsAcknowledgement` is false; when true, the SAME visible reason box for a shortfall and for a gain,
 *      the difference as money, and wording that tells the two apart. `PreviewShape` gains `needsAcknowledgement`, `difference`, `differenceSign`
 *      ('short' | 'over' | 'none') and loses `needsGainAcknowledgement`.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readControlSource } from './helpers/control-source';
import * as form from '../src/app/channel-settlements/SettlementForm';

const dir = resolve(__dirname, '..', 'src', 'app', 'channel-settlements');
const actions = readFileSync(resolve(dir, 'actions.ts'), 'utf8');
const formSource = readControlSource(resolve(dir, 'SettlementForm.tsx'), 'utf8');

/** The text of each `loanLegs:` property in actions.ts, up to the next sibling property of the call. */
function loanLegsExpressions(): string[] {
  const out: string[] = [];
  for (const m of actions.matchAll(/\bloanLegs:/g)) {
    const rest = actions.slice(m.index! + m[0].length);
    const end = rest.search(/\n\s{6,10}(?:reference|settledOn|acknowledgeDifference|recognizeGain)\b|\n\s*\}\),/);
    out.push(rest.slice(0, end === -1 ? 500 : end));
  }
  return out;
}

describe('T-511 S6a - F1: the actions pass a one-element loanLegs list, and the acknowledgement', () => {
  it('both the preview and the record call pass loanLegs and neither passes the old single `loan` [kills: the old shape left in one of the two calls]', () => {
    expect(loanLegsExpressions().length, 'loanLegs: occurrences in actions.ts (preview + record)').toBe(2);
    expect(actions).not.toMatch(/^\s+loan:\s/m);
    expect(actions).not.toMatch(/\brecognizeGain\b/);
  });

  it('each loanLegs value is exactly one { loanId, amount, ownerStoreId } object when a loan is picked, and [] when none is [kills: a leg with no loan id; two legs invented; a missing empty case; an owner store dropped]', () => {
    expect(loanLegsExpressions().length, 'loanLegs: occurrences in actions.ts (preview + record)').toBe(2);
    for (const e of loanLegsExpressions()) {
      expect(e, 'one object in an array literal').toMatch(/\[\s*\{[^{}]*\bloanId\b[^{}]*\}\s*\]/);
      expect(e).toMatch(/\bamount\b/);
      expect(e).toMatch(/\bownerStoreId\b/);
      expect(e, 'the empty case').toMatch(/:\s*\[\]/);
      expect((e.match(/\{[^{}]*\bloanId\b[^{}]*\}/g) ?? []).length, 'exactly one leg object is built from the one picker').toBe(1);
    }
  });

  it('the reason travels as `differenceReason` and becomes acknowledgeDifference: { reason } in both calls; PreviewRequest.differenceReason is a string [kills: the acknowledgement dropped from the preview; the field renamed on one side only]', () => {
    expect((actions.match(/\backnowledgeDifference\b/g) ?? []).length, 'acknowledgeDifference in preview and record').toBeGreaterThanOrEqual(2);
    expect(actions).toMatch(/differenceReason:\s*string/);
    expect(actions).toMatch(/['"]differenceReason['"]/);
    expect(actions).toMatch(/\breason\b/);
  });
});

describe('T-511 S6a - F2: the form posts the reason from one hidden field', () => {
  it('SettlementForm.tsx has exactly one name="differenceReason", and it is a hidden input; the old recognizeGain / needsGainAcknowledgement are gone [kills: a reason field that only exists while the acknowledgement is showing; two fields of one name; the old switch kept]', () => {
    const needle = 'name="differenceReason"';
    expect(formSource.split(needle).length - 1, `${needle} occurrences`).toBe(1);
    const at = formSource.indexOf(needle);
    const tag = formSource.slice(Math.max(formSource.lastIndexOf('<input', at), formSource.lastIndexOf('<Input', at)), formSource.indexOf('/>', at) + 2);
    expect(tag, 'the posted reason is a hidden input').toMatch(/type=["']hidden["']/);
    expect(formSource).not.toMatch(/\brecognizeGain\b/);
    expect(formSource).not.toMatch(/\bneedsGainAcknowledgement\b/);
  });

  it('the manual form still has its single loan picker and amount box: no second picker, no add-a-leg control [kills: new UI beyond the spec]', () => {
    expect(formSource.split('name="loanId"').length - 1, 'one loan picker').toBe(1);
    expect(formSource).toMatch(/name="loanAmount"|CHANNEL_SETTLEMENT_RECORD_RULES\.loanAmount/);
    expect(formSource).not.toMatch(/Add (?:another )?loan|addLeg|loanLegs\.map|legs\.map/i);
  });
});

describe('T-511 S6a - F3: DifferenceAcknowledgement, one visible reason box for both signs', () => {
  const base = {
    channelName: 'Grab', outstanding: '10000.00', outstandingCleared: '10000.00', feesTotal: '0.00', loanDeduction: '0.00', netDeposited: '5000.00',
    variance: '0.00', settlementGain: '0.00', tolerance: '1000.00', destinationAccountName: 'Bank A', blockers: [] as string[], figuresComputed: true,
    needsAcknowledgement: false, difference: '0.00', differenceSign: 'none',
  };
  const short = { ...base, needsAcknowledgement: true, difference: '5000.00', differenceSign: 'short', variance: '5000.00', blockers: ['the day is short ... acknowledgeDifference'] };
  const over = { ...base, netDeposited: '13000.00', needsAcknowledgement: true, difference: '3000.00', differenceSign: 'over', settlementGain: '3000.00', blockers: ['the payout exceeds the day ... acknowledgeDifference'] };
  const render = (preview: object, reason = '') => {
    const C = (form as unknown as Record<string, unknown>).DifferenceAcknowledgement;
    expect(C, 'SettlementForm.tsx exports DifferenceAcknowledgement').toBeTypeOf('function');
    return renderToStaticMarkup(createElement(C as never, { preview, reason, onReasonChange: () => {} } as never));
  };
  /** a visible text control: a textarea, or an input that is neither hidden nor a checkbox */
  const hasVisibleReasonBox = (html: string) => /<textarea\b/.test(html) || /<input\b(?![^>]*type=["'](?:hidden|checkbox)["'])[^>]*>/.test(html);

  it('a shortfall past tolerance shows the difference as money, says it is short, and offers a visible reason box [kills: an acknowledgement offered for a gain only (the old recognizeGain tick)]', () => {
    const html = render(short);
    expect(hasVisibleReasonBox(html), 'a visible reason box').toBe(true);
    expect(html).toMatch(/5,000\.00/);
    expect(html).toMatch(/short/i);
  });

  it('a gain past tolerance shows the difference as money, says the payout is over, and offers the SAME visible reason box [kills: a different control per sign; a gain with no reason box]', () => {
    const html = render(over);
    expect(hasVisibleReasonBox(html), 'a visible reason box').toBe(true);
    expect(html).toMatch(/3,000\.00/);
    expect(html).toMatch(/more than|over|exceed/i);
    expect(html, 'the shortfall wording is not shown for a gain').not.toMatch(/\bshort\b/i);
  });

  it('the typed reason is shown back in the box [kills: an uncontrolled box that loses what was typed on re-render]', () => {
    expect(render(short, 'Platform short-paid')).toContain('Platform short-paid');
  });

  it('nothing at all when no acknowledgement is needed: within tolerance, or an exact payout [kills: an acknowledgement a person learns to tick by habit]', () => {
    expect(render({ ...base, difference: '40.00', differenceSign: 'short', variance: '40.00' }).trim()).toBe('');
    expect(render(base).trim()).toBe('');
  });
});
