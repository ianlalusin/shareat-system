/**
 * T-500 - /payroll/rates usability: the contribution-row form shows only the fields of the chosen agency, every rate box says what it
 * is as a percent, Save says "Save", and each list row shows every value the approver approves. `.ts` + createElement on purpose.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/payroll/rates', useSearchParams: () => new URLSearchParams() }));

import { agencyFields, percentText, rateExceedsOne, rateSummary, type RateRowView } from '../src/app/payroll/rates/rate-fields';
import { StatutoryRateForm } from '../src/app/payroll/rates/StatutoryRateForm';

vi.mock('../src/app/payroll/rates/actions', () => ({ addStatutoryRateAction: vi.fn() }));

const html = (agency: 'sss' | 'philhealth' | 'pagibig') => renderToStaticMarkup(createElement(StatutoryRateForm, { initialAgency: agency }));
const names = (h: string) => [...h.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]);

describe('which fields belong to which agency', () => {
  it('maps each agency', () => {
    expect(agencyFields('sss')).toEqual({ step: true, lowBand: false, ec: true });
    expect(agencyFields('philhealth')).toEqual({ step: false, lowBand: false, ec: false });
    expect(agencyFields('pagibig')).toEqual({ step: false, lowBand: true, ec: false });
  });
  it('SSS form: step and EC, no Pag-IBIG low band', () => {
    const n = names(html('sss'));
    for (const f of ['step', 'ecThreshold', 'ecLow', 'ecHigh', 'eeRate', 'erRate', 'floor', 'ceiling', 'sourceRef', 'agency']) expect(n, f).toContain(f);
    for (const f of ['lowThreshold', 'lowEeRate']) expect(n, f).not.toContain(f);
  });
  it('PhilHealth form: none of step, low band, EC', () => {
    const n = names(html('philhealth'));
    for (const f of ['step', 'lowThreshold', 'lowEeRate', 'ecThreshold', 'ecLow', 'ecHigh']) expect(n, f).not.toContain(f);
    expect(n).toContain('eeRate');
  });
  it('Pag-IBIG form: low band only', () => {
    const n = names(html('pagibig'));
    expect(n).toContain('lowThreshold');
    expect(n).toContain('lowEeRate');
    for (const f of ['step', 'ecThreshold', 'ecLow', 'ecHigh']) expect(n, f).not.toContain(f);
  });
});

describe('rates read as percent', () => {
  it('percentText', () => {
    expect(percentText('0.05')).toBe('5%');
    expect(percentText('0.0275')).toBe('2.75%');
    expect(percentText('0.1000')).toBe('10%');
    expect(percentText('0.045')).toBe('4.5%');
    expect(percentText('5')).toBe('500%');
    expect(percentText('')).toBeNull();
    expect(percentText('abc')).toBeNull();
  });
  it('each rate box carries the hint', () => {
    const h = html('pagibig');
    expect((h.match(/enter 0\.05 for 5%/g) ?? []).length).toBeGreaterThanOrEqual(3); // employee, employer, low-band
  });
  it('a rate box starting at 0.05 reads "= 5%"', () => {
    const h = renderToStaticMarkup(createElement(StatutoryRateForm, { initialAgency: 'sss', initialValues: { eeRate: '0.05' } }));
    expect(h).toContain('= 5%');
  });
});

describe('a rate typed as 5 is flagged', () => {
  it('rateExceedsOne', () => {
    for (const bad of ['5', '1.5', '10', '1.0001']) expect(rateExceedsOne(bad), bad).toBe(true);
    for (const ok of ['0.05', '1', '1.0', '0', '', 'abc']) expect(rateExceedsOne(ok), ok).toBe(false);
  });
});

describe('Save says Save', () => {
  it('a visible text Save, not only an icon button', () => {
    const h = html('sss');
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
  });
});

const row = (over: Partial<RateRowView>): RateRowView => ({
  agency: 'sss', eeRate: '0.0500', erRate: '0.1000', baseKind: 'gross', floor: '5000.00', ceiling: '35000.00', step: '500.00',
  lowThreshold: null, lowEeRate: null, ecThreshold: '15000.00', ecLow: '10.00', ecHigh: '30.00', ...over,
});

describe('the list shows everything the approver approves', () => {
  it('SSS: percent rates, floor, ceiling, step, EC switch point and both amounts', () => {
    const t = rateSummary(row({})).join(' | ');
    expect(t).toContain('5%');
    expect(t).toContain('10%');
    expect(t).toContain('5000');
    expect(t).toContain('35000');
    expect(t).toContain('500');
    expect(t).toMatch(/15000/);
    expect(t).toMatch(/10(\.00)?/);
    expect(t).toMatch(/30(\.00)?/);
  });
  it('Pag-IBIG: low band and its rate; a null floor reads "no floor", never a bare dash', () => {
    const t = rateSummary(row({ agency: 'pagibig', floor: null, step: null, ecThreshold: null, ecLow: null, ecHigh: null, lowThreshold: '1500.00', lowEeRate: '0.0100', eeRate: '0.0200', erRate: '0.0200' })).join(' | ');
    expect(t).toContain('no floor');
    expect(t).toContain('1500');
    expect(t).toContain('1%');
    expect(t).not.toMatch(/floor -|ceiling -/);
    expect(t).not.toMatch(/EC/);
  });
  it('a null ceiling reads "no ceiling"', () => {
    expect(rateSummary(row({ ceiling: null })).join(' | ')).toContain('no ceiling');
  });
});
