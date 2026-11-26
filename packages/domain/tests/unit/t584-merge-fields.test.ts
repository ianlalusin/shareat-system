import { describe, expect, it } from 'vitest';
import { MERGE_FIELDS, fieldsIn, longDate, parseBody, unknownFields } from '../../src/documents/merge-fields';

/**
 * T-584 - the merge-field whitelist and the plain-text markup (docs/tasks/584-documents.md s5, s6). Pure: no database.
 * Test 3 (unknown field refused, missing blocks issue) at the unit level, and test 8 (`<script>` stays literal text) at the parser level.
 */
describe('T-584 merge fields', () => {
  it('the whitelist is exactly the spec list, the fifteen of T-584 plus the six T-637 added whose data is really stored [kills: a field added or dropped without a decision]', () => {
    expect([...MERGE_FIELDS].sort()).toEqual(
      [
        'employee.full_name', 'employee.staff_code', 'employee.position', 'employee.status', 'employee.started_on', 'employee.ended_on',
        'store.name', 'store.address', 'store.tin_branch_code', 'org.legal_name', 'org.trading_name', 'org.tin', 'issuer.full_name', 'issuer.position', 'today',
        'employee.first_name', 'employee.last_name', 'employee.email', 'employee.phone', 'employee.length_of_service', 'store.phone',
      ].sort(),
    );
  });

  it('fieldsIn finds every {{name}} once, tolerating spaces; unknownFields names the bad ones [kills: a typo saved silently]', () => {
    const body = 'Dear {{ employee.full_name }}, {{employee.full_name}} at {{store.name}} {{employee.salary}} {{nope}}';
    expect(fieldsIn(body)).toEqual(['employee.full_name', 'store.name', 'employee.salary', 'nope']);
    expect(unknownFields(body)).toEqual(['employee.salary', 'nope']);
    expect(unknownFields('{{today}} {{org.legal_name}}')).toEqual([]);
  });

  // fillBody and missingIn (plain-text filling) were replaced by fillDoc / missingInDoc in T-637; their cases live in t637-doc.test.ts.

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
