import { describe, expect, it } from 'vitest';
import { MERGE_FIELDS, fieldsIn, fillBody, longDate, missingIn, parseBody, unknownFields } from '../../src/documents/merge-fields';

/**
 * T-584 - the merge-field whitelist and the plain-text markup (docs/tasks/584-documents.md s5, s6). Pure: no database.
 * Test 3 (unknown field refused, missing blocks issue) at the unit level, and test 8 (`<script>` stays literal text) at the parser level.
 */
describe('T-584 merge fields', () => {
  it('the whitelist is exactly the spec list, fifteen names [kills: a field added or dropped without a decision]', () => {
    expect([...MERGE_FIELDS].sort()).toEqual(
      [
        'employee.full_name', 'employee.staff_code', 'employee.position', 'employee.status', 'employee.started_on', 'employee.ended_on',
        'store.name', 'store.address', 'store.tin_branch_code', 'org.legal_name', 'org.trading_name', 'org.tin', 'issuer.full_name', 'issuer.position', 'today',
      ].sort(),
    );
  });

  it('fieldsIn finds every {{name}} once, tolerating spaces; unknownFields names the bad ones [kills: a typo saved silently]', () => {
    const body = 'Dear {{ employee.full_name }}, {{employee.full_name}} at {{store.name}} {{employee.salary}} {{nope}}';
    expect(fieldsIn(body)).toEqual(['employee.full_name', 'store.name', 'employee.salary', 'nope']);
    expect(unknownFields(body)).toEqual(['employee.salary', 'nope']);
    expect(unknownFields('{{today}} {{org.legal_name}}')).toEqual([]);
  });

  it('fillBody fills values and writes a visible marker for a missing, null or blank one [kills: a blank silently printed]', () => {
    const out = fillBody('{{employee.full_name}} / {{employee.ended_on}} / {{store.address}} / {{today}}', {
      'employee.full_name': 'Pat Example',
      'employee.ended_on': null,
      'store.address': '   ',
      today: '15 November 2026',
    });
    expect(out).toBe('Pat Example / [missing: employee.ended_on] / [missing: store.address] / 15 November 2026');
    expect(missingIn(out)).toEqual(['employee.ended_on', 'store.address']);
    expect(missingIn('all filled in')).toEqual([]);
  });

  it('a value that itself contains {{...}} is not filled twice [kills: injecting a field through a value]', () => {
    expect(fillBody('{{employee.full_name}}', { 'employee.full_name': '{{org.tin}}', 'org.tin': '999' })).toBe('{{org.tin}}');
  });

  it('longDate prints the long form with no time zone shift, and null for junk [kills: an off-by-one day]', () => {
    expect(longDate('2026-11-15')).toBe('15 November 2026');
    expect(longDate('2025-01-06')).toBe('6 January 2025');
    expect(longDate('2026-12-31')).toBe('31 December 2026');
    expect(longDate(null)).toBeNull();
    expect(longDate('15/11/2026')).toBeNull();
  });
});

describe('T-584 the body is plain text with a tiny markup (test 8)', () => {
  it('a blank line is a paragraph, "# " a heading, **bold** a bold run, a single newline stays inside the paragraph', () => {
    const blocks = parseBody('# Certificate\n\nThis is **to certify** that\nPat works here.\n\nSecond paragraph.');
    expect(blocks).toEqual([
      { type: 'heading', text: 'Certificate' },
      { type: 'paragraph', runs: [{ text: 'This is ', bold: false }, { text: 'to certify', bold: true }, { text: ' that\nPat works here.', bold: false }] },
      { type: 'paragraph', runs: [{ text: 'Second paragraph.', bold: false }] },
    ]);
  });

  it('<script> and HTML stay literal text, never a tag or an attribute [kills: any HTML pass-through]', () => {
    const blocks = parseBody('<script>alert(1)</script>\n\n**<img src=x onerror=alert(1)>**');
    expect(blocks).toEqual([
      { type: 'paragraph', runs: [{ text: '<script>alert(1)</script>', bold: false }] },
      { type: 'paragraph', runs: [{ text: '<img src=x onerror=alert(1)>', bold: true }] },
    ]);
  });

  it('an unmatched ** stays literal and bolds nothing; empty input has no blocks [kills: bolding the rest of the page]', () => {
    expect(parseBody('a **b')).toEqual([{ type: 'paragraph', runs: [{ text: 'a **b', bold: false }] }]);
    expect(parseBody('   \n\n  ')).toEqual([]);
  });
});
