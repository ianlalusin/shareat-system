import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field, FormGrid } from '../src/components/ui/FormGrid';
import { Input } from '../src/components/ui/Input';
const read = (path: string) => readFileSync(path, 'utf8');
describe('T-452 compact card field groups', () => {
  it('offers the shared paired layout without a nested form', () => {
    const html = renderToStaticMarkup(createElement(FormGrid, { layout: 'pairs' } as never, 'fields'));
    expect(html).toContain('erp-form-pairs-grid'); expect(html).not.toContain('<form');
  });
  it('places the control before help and keeps the short label separate', () => {
    const html = renderToStaticMarkup(createElement(Field, { label: 'Net deposited', hint: 'What landed in the account' }, createElement(Input, { name: 'netDeposited' })));
    expect(html).toContain('erp-field-label');
    expect(html.indexOf('name="netDeposited"')).toBeLessThan(html.indexOf('What landed in the account'));
  });
  it('applies shared paired spacing to existing record-card groups', () => {
    expect(read('apps/erp/src/components/forms/EditableRecord.tsx')).toContain('erp-record-fields');
    const css = read('apps/erp/src/app/globals.css');
    expect(css).toContain('.erp-record-fields .erp-form-fields');
    expect(css).toContain('repeat(2, minmax(0, 1fr))');
    expect(css).toContain('@container (min-width: 24rem)');
    expect(css).toContain('form:has(.erp-form-fields)');
    expect(css).toContain('@container (max-width: 42rem)');
    expect(css).toContain('.erp-field-short .erp-field-control');
    expect(css).toContain('max-inline-size: min(100%, 8rem)');
  });
  it('pairs government fields and settlement groups', () => {
    const staff = read('apps/erp/src/app/staff/[employmentId]/page.tsx');
    expect(staff.slice(staff.indexOf('label="government numbers"'))).toContain('layout="pairs"');
    const settlement = read('apps/erp/src/app/channel-settlements/SettlementForm.tsx');
    expect((settlement.match(/<FormGrid layout="pairs">/g) ?? []).length).toBe(5);
    expect(settlement).toContain('label={d.label}');
    expect(settlement).toContain('hint={<>{accountLabel(d.account)}');
    expect(settlement).toContain('<SplitWorkspace formTitle="Payout details" detailsTitle="Payout check"');
  });
});
