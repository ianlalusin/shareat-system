import { describe, expect, it } from 'vitest';
import {
  FIELD_DEFS,
  fillDoc,
  fieldsInDoc,
  legacyBodyToDoc,
  missingInDoc,
  placeholderLookalikes,
  plainTextOf,
  validateDoc,
  effectiveDoc,
  defaultLetterheadDoc,
  FONT_STACKS,
  type DocJson,
  type DocNode,
} from '../../src/documents/doc';
import { MERGE_FIELDS, lengthOfService, suggestFields } from '../../src/documents/merge-fields';

/**
 * T-637 - the document model: the strict whitelist, filling, the old-markup converter, the lookalike warning, the new field maths and the `{{` suggestion list.
 * Pure: no database. Tests 1, 3, 4 (fill half), 5 (pure parts), 6 and 8 (detection half) of docs/tasks/637-document-editor.md.
 */
const doc = (...content: DocNode[]): DocJson => ({ type: 'doc', content });
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const f = (name: string): DocNode => ({ type: 'field', attrs: { name } });
const refusal = (raw: unknown): string => {
  const r = validateDoc(raw);
  expect(r.ok, 'expected the document to be refused').toBe(false);
  return r.ok ? '' : r.reason;
};

describe('T-637 test 1 - the server whitelist refuses what is not on the list', () => {
  it('accepts a document with every allowed feature, in the shape the editor emits (null attributes included) [kills: a whitelist so tight the editor cannot save]', () => {
    const good = doc(
      { type: 'heading', attrs: { level: 1, textAlign: 'center', lineHeight: null }, content: [t('Title', [{ type: 'bold' }, { type: 'textStyle', attrs: { fontFamily: FONT_STACKS[0], fontSize: '20pt' } }])] },
      { type: 'paragraph', attrs: { textAlign: 'justify', lineHeight: '1.5' }, content: [t('Dear '), f('employee.full_name'), { type: 'hardBreak' }, t('x', [{ type: 'italic' }, { type: 'underline' }])] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
      { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [p(t('first'))] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(t('A'))] }, { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p()] }] }] },
      { type: 'horizontalRule' },
      { type: 'pageBreak' },
    );
    expect(validateDoc(good)).toEqual({ ok: true, doc: good });
    expect(validateDoc(legacyBodyToDoc('# T\n\nBody **b** {{today}}')).ok).toBe(true);
    expect(validateDoc(defaultLetterheadDoc()).ok).toBe(true);
  });

  it('refuses a script, iframe or image node, and a node that is not allowed in that place [kills: a node whitelist that lets script through]', () => {
    for (const type of ['script', 'iframe', 'image', 'codeBlock', 'blockquote', 'link']) {
      expect(refusal(doc({ type } as DocNode)), type).toContain(`"${type}"`);
    }
    expect(refusal(doc({ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'x' } }] }))).toContain('image');
    expect(refusal(doc({ type: 'tableRow', content: [] }))).toMatch(/not allowed in that place/);
  });

  it('refuses a colour, a link or any other mark, and a mark attribute that is not font or size [kills: a mark whitelist that lets colour or a link through]', () => {
    expect(refusal(doc(p(t('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))))).toMatch(/link/);
    expect(refusal(doc(p(t('x', [{ type: 'textStyle', attrs: { color: '#f00' } }]))))).toMatch(/color/);
    expect(refusal(doc(p(t('x', [{ type: 'highlight' }]))))).toMatch(/highlight/);
    expect(refusal(doc(p(t('x', [{ type: 'bold', attrs: { href: 'x' } }]))))).toMatch(/href/);
  });

  it('refuses an href or style attribute, a font that is not one of the three, a size that is not on the list, bad alignment [kills: an attribute whitelist that lets style through]', () => {
    expect(refusal(doc({ type: 'paragraph', attrs: { href: 'x' }, content: [t('x')] }))).toMatch(/href/);
    expect(refusal(doc({ type: 'paragraph', attrs: { style: 'x' }, content: [t('x')] }))).toMatch(/style/);
    expect(refusal(doc(p(t('x', [{ type: 'textStyle', attrs: { fontFamily: 'Comic Sans MS' } }]))))).toMatch(/fontFamily/);
    expect(refusal(doc(p(t('x', [{ type: 'textStyle', attrs: { fontSize: '99pt' } }]))))).toMatch(/fontSize/);
    expect(refusal(doc({ type: 'paragraph', attrs: { textAlign: 'start' }, content: [t('x')] }))).toMatch(/textAlign/);
    expect(refusal(doc({ type: 'heading', attrs: { level: 4 }, content: [t('x')] }))).toMatch(/level/);
    expect(refusal(doc({ type: 'paragraph', attrs: { lineHeight: '3' }, content: [t('x')] }))).toMatch(/lineHeight/);
  });

  it('refuses merged table cells, an unknown field (naming it), a stray key, a non-object and a tree that is far too big [kills: merged cells, a typo field or a giant document saved]', () => {
    const cell = (extra: object) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, ...extra }, content: [p()] });
    expect(refusal(doc({ type: 'table', content: [{ type: 'tableRow', content: [cell({ colspan: 2 })] }] }))).toMatch(/colspan/);
    expect(refusal(doc({ type: 'table', content: [{ type: 'tableRow', content: [cell({ rowspan: 3 })] }] }))).toMatch(/rowspan/);
    const unknown = refusal(doc(p(f('employee.salary'))));
    expect(unknown).toContain('employee.salary');
    expect(unknown).toMatch(/not a known field/);
    expect(refusal({ type: 'doc', content: [], extra: 1 })).toMatch(/not allowed/);
    expect(refusal({ type: 'doc', content: [{ type: 'paragraph', extra: 1 }] })).toMatch(/extra/);
    expect(refusal('<script>')).toMatch(/not in a form/);
    expect(refusal(null)).toMatch(/not in a form/);
    expect(refusal(doc(p(t('x'.repeat(50_001)))))).toMatch(/too long/);
    const deep = (n: number): DocNode => (n === 0 ? p(t('x')) : { type: 'bulletList', content: [{ type: 'listItem', content: [deep(n - 1)] }] });
    expect(refusal(doc(deep(8)))).toMatch(/nested too deeply/);
  });
});

describe('T-637 test 3 - the old markup becomes a document and keeps its wording', () => {
  it('keeps paragraphs, headings, bold and field tags; a single newline stays a line break; an unknown {{x}} stays literal text [kills: wording lost in conversion]', () => {
    const d = legacyBodyToDoc('# Certificate of Employment\n\nThis certifies that **{{employee.full_name}}** worked at {{store.name}}.\nIssued {{today}} {{nope}}\n\nSecond paragraph.');
    expect(d.content).toHaveLength(3);
    expect(d.content[0]).toEqual({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Certificate of Employment' }] });
    expect(d.content[1]!.content).toEqual([
      { type: 'text', text: 'This certifies that ' },
      { type: 'field', attrs: { name: 'employee.full_name' }, marks: [{ type: 'bold' }] },
      { type: 'text', text: ' worked at ' },
      { type: 'field', attrs: { name: 'store.name' } },
      { type: 'text', text: '.' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Issued ' },
      { type: 'field', attrs: { name: 'today' } },
      { type: 'text', text: ' {{nope}}' },
    ]);
    expect(fieldsInDoc(d)).toEqual(['employee.full_name', 'store.name', 'today']);
    expect(plainTextOf(d)).toBe('Certificate of Employment\n\nThis certifies that {{employee.full_name}} worked at {{store.name}}.\nIssued {{today}} {{nope}}\n\nSecond paragraph.');
    expect(validateDoc(d).ok).toBe(true);
  });

  it('an empty body is one empty paragraph, and effectiveDoc converts an old row but prefers a stored document [kills: a crash on an old template]', () => {
    expect(legacyBodyToDoc('  ').content).toEqual([{ type: 'paragraph' }]);
    const stored = doc(p(t('stored')));
    expect(effectiveDoc(stored, 'old **body**')).toBe(stored);
    expect(plainTextOf(effectiveDoc(null, 'old **body**'))).toBe('old body');
    expect(plainTextOf(effectiveDoc({ type: 'bad' }, 'fallback wording'))).toBe('fallback wording');
  });
});

describe('T-637 test 4 - a field resolves to its value as TEXT; a missing one blocks; nothing is filled twice', () => {
  it('fills known fields, leaves a visible [missing: x] for a null or blank value, and the marks of the tag carry over [kills: a blank silently printed]', () => {
    const src = doc(p(t('Dear '), { type: 'field', attrs: { name: 'employee.full_name' }, marks: [{ type: 'bold' }] }, t(', left '), f('employee.ended_on'), t(' / '), f('store.address')));
    const out = fillDoc(src, { 'employee.full_name': 'Pat Example', 'employee.ended_on': null, 'store.address': '   ' });
    expect(out.content[0]!.content).toEqual([
      { type: 'text', text: 'Dear ' },
      { type: 'text', text: 'Pat Example', marks: [{ type: 'bold' }] },
      { type: 'text', text: ', left ' },
      { type: 'text', text: '[missing: employee.ended_on]' },
      { type: 'text', text: ' / ' },
      { type: 'text', text: '[missing: store.address]' },
    ]);
    expect(missingInDoc(out)).toEqual(['employee.ended_on', 'store.address']);
    expect(missingInDoc(fillDoc(src, { 'employee.full_name': 'a', 'employee.ended_on': 'b', 'store.address': 'c' }))).toEqual([]);
    expect(src.content[0]!.content!.some((n) => n.type === 'field')).toBe(true); // the source is not mutated
  });

  it('a value that itself reads {{x}} stays text and is never turned into a field or filled again [kills: injecting a field through a value]', () => {
    const out = fillDoc(doc(p(f('employee.full_name'))), { 'employee.full_name': '{{org.tin}}', 'org.tin': '999' });
    expect(out.content[0]!.content).toEqual([{ type: 'text', text: '{{org.tin}}' }]);
    expect(fieldsInDoc(out)).toEqual([]);
  });

  it('a header or footer fills in BLANK mode: a missing value prints nothing and a line left empty is dropped [kills: a letterhead that blocks or keeps an empty line]', () => {
    const out = fillDoc(doc(p(f('store.name')), p(f('store.address')), p(t('fixed text'))), { 'store.name': 'Branch', 'store.address': null }, 'blank');
    expect(plainTextOf(out)).toBe('Branch\n\nfixed text');
    expect(missingInDoc(out)).toEqual([]);
    expect(fillDoc(doc(p(f('store.address'))), {}, 'blank').content).toEqual([{ type: 'paragraph' }]);
  });
});

describe('T-637 test 5 - the new field maths', () => {
  it('length of service counts whole calendar months, drops a zero part, and uses today while still employed [kills: an off-by-one month]', () => {
    expect(lengthOfService('2025-01-06', '2026-06-05', '2026-11-25')).toBe('1 year, 4 months'); // 5 June is before the 6th: month 17 is not complete
    expect(lengthOfService('2025-01-06', '2026-06-06', '2026-11-25')).toBe('1 year, 5 months');
    expect(lengthOfService('2025-01-06', null, '2026-11-25')).toBe('1 year, 10 months');
    expect(lengthOfService('2024-11-25', null, '2026-11-25')).toBe('2 years');
    expect(lengthOfService('2026-10-25', null, '2026-11-25')).toBe('1 month');
    expect(lengthOfService('2026-11-01', null, '2026-11-25')).toBe('less than a month');
    expect(lengthOfService('2025-12-31', null, '2026-01-30')).toBe('less than a month');
    expect(lengthOfService('2026-12-01', null, '2026-11-25')).toBeNull();
    expect(lengthOfService('junk', null, '2026-11-25')).toBeNull();
  });

  it('every field has a plain label and a sample, and nothing like salary or a government number is a field [kills: a field with no label, or personal data offered]', () => {
    expect(FIELD_DEFS.length).toBe(MERGE_FIELDS.length);
    for (const d of FIELD_DEFS) {
      expect(d.label.length, d.name).toBeGreaterThan(2);
      expect(d.sample.length, d.name).toBeGreaterThan(0);
    }
    expect(MERGE_FIELDS.join(' ')).not.toMatch(/salary|rate|sss|philhealth|pagibig|tin_no|birth|address.*employee/);
    expect(new Set(MERGE_FIELDS).size).toBe(MERGE_FIELDS.length);
  });
});

describe('T-637 test 6 - what typing {{ offers', () => {
  it('an empty query lists every field; a prefix of the name, the label or any word of it filters; nothing matching lists nothing [kills: a list that does not filter]', () => {
    expect(suggestFields('').map((d) => d.name)).toEqual(MERGE_FIELDS);
    expect(suggestFields('emp').every((d) => d.name.startsWith('employee.') || d.label.toLowerCase().includes('emp'))).toBe(true);
    expect(suggestFields('employee.f').map((d) => d.name)).toEqual(['employee.full_name', 'employee.first_name']);
    expect(suggestFields('STORE n').map((d) => d.name)).toEqual(['store.name']); // a prefix of the label, case-insensitive
    expect(suggestFields('name store')).toEqual([]); // a prefix, not a fuzzy match across words
    expect(suggestFields('store').map((d) => d.name).sort()).toEqual(['store.address', 'store.name', 'store.phone', 'store.tin_branch_code']);
    expect(suggestFields('contact').map((d) => d.name).sort()).toEqual(['employee.phone', 'store.phone']);
    expect(suggestFields('zzzz')).toEqual([]);
    expect(suggestFields('TODAY').map((d) => d.name)).toEqual(['today']);
  });
});

describe('T-637 test 8 - the square-bracket lookalike (detection)', () => {
  it('finds [CAPS PLACEHOLDER] text in the body, a header or a footer, once each, and ignores lowercase brackets and [missing: x] [kills: a warning that never fires]', () => {
    const body = doc(p(t('This is to certify [EMPLOYEE FULL NAME] of [STORE]. See [note] and [missing: today]. Again [EMPLOYEE FULL NAME].')));
    const header = doc(p(t('[COMPANY NAME]')));
    expect(placeholderLookalikes(body, header, null)).toEqual(['[EMPLOYEE FULL NAME]', '[STORE]', '[COMPANY NAME]']);
    expect(placeholderLookalikes(doc(p(t('Plain [text] and [ab] and [Mixed Case].'))))).toEqual([]);
    expect(placeholderLookalikes(doc(p(f('employee.full_name'))))).toEqual([]);
  });
});
