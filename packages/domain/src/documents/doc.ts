/**
 * The document model. T-637 (docs/tasks/637-document-editor.md). PURE: no database import, so the editor, the renderer and the server share ONE definition.
 *
 * A template or an issued document is stored as JSON (a ProseMirror-shaped tree: `{type:'doc', content:[...]}`), NEVER as HTML. `validateDoc` is a STRICT whitelist run
 * on the SERVER at every save: a node, a mark, an attribute or a value that is not listed here is refused, so a stored document cannot hold a script, an image, a link,
 * a colour or an inline style. The renderer (apps/erp `DocumentDoc`) turns the tree into React elements and never touches innerHTML.
 *
 * Fields are inline `field` nodes (`attrs.name` on the merge-field whitelist). Filling swaps each for a plain TEXT node, so a value that itself reads `{{x}}` is only
 * ever text and is never filled twice.
 */
import { FIELD_DEFS, parseBody, type MergeField, type MergeValues } from './merge-fields';

// The editor and the renderer reach the field list through this leaf (it is the db-free import they are allowed).
export { FIELD_DEFS, suggestFields, type FieldDef } from './merge-fields';
export const FIELD_LABELS: Readonly<Record<string, string>> = Object.fromEntries(FIELD_DEFS.map((f) => [f.name, f.label]));

export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}
export interface DocJson {
  type: 'doc';
  content: DocNode[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The fixed choices (the editor offers exactly these; the server accepts exactly these)
// ---------------------------------------------------------------------------------------------------------------------
export const FONT_FAMILIES = [
  { label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { label: 'Sans-serif', stack: 'Arial, Helvetica, sans-serif' },
  { label: 'Monospace', stack: '"Courier New", Courier, monospace' },
] as const;
export const FONT_STACKS: readonly string[] = FONT_FAMILIES.map((f) => f.stack);
export const FONT_SIZES = ['10pt', '11pt', '12pt', '14pt', '16pt', '20pt', '24pt'] as const;
export const LINE_HEIGHTS = ['1', '1.15', '1.5', '2'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export const HEADING_LEVELS = [1, 2, 3] as const;
/** Page margins, per template: the fixed choices. A4 is the only page size. */
export const PAGE_MARGINS = { narrow: '12mm', normal: '20mm', wide: '30mm' } as const;
export type PageMargin = keyof typeof PAGE_MARGINS;
export const PAGE_MARGIN_KEYS = Object.keys(PAGE_MARGINS) as PageMargin[];
export const MARGIN_WORDS: Record<PageMargin, string> = { narrow: 'Narrow (12 mm)', normal: 'Normal (20 mm)', wide: 'Wide (30 mm)' };
export const DEFAULT_MARGIN: PageMargin = 'normal';

/** The page settings of a template version, and of an issued version (header and footer already filled). Both docs are optional. */
export interface DocPage {
  margins: PageMargin;
  headerDoc: DocJson | null;
  footerDoc: DocJson | null;
}

export const MAX_DOC_TEXT = 50_000;
const MAX_DOC_JSON = 400_000;
const MAX_NODES = 8_000;
const MAX_DEPTH = 12;

// ---------------------------------------------------------------------------------------------------------------------
// The whitelist
// ---------------------------------------------------------------------------------------------------------------------
type AttrRule = (v: unknown) => boolean;
const oneOf = (...allowed: readonly unknown[]): AttrRule => (v) => allowed.includes(v);
const nullOr = (...allowed: readonly unknown[]): AttrRule => (v) => v === null || v === undefined || allowed.includes(v);

const ALIGN = nullOr(...TEXT_ALIGNS);
const LINE = nullOr(...LINE_HEIGHTS);
const BLOCKS = ['paragraph', 'heading', 'bulletList', 'orderedList', 'table', 'horizontalRule', 'pageBreak'];
const INLINE = ['text', 'hardBreak', 'field'];
const IN_CELL = ['paragraph', 'bulletList', 'orderedList'];

interface NodeRule {
  attrs: Record<string, AttrRule>;
  /** Allowed child types; absent means a leaf. */
  content?: readonly string[];
  /** The child list may not be empty. */
  required?: boolean;
  /** An inline node may carry marks. */
  marks?: boolean;
}

const NODE_RULES: Record<string, NodeRule> = {
  paragraph: { attrs: { textAlign: ALIGN, lineHeight: LINE }, content: INLINE },
  heading: { attrs: { level: oneOf(...HEADING_LEVELS), textAlign: ALIGN, lineHeight: LINE }, content: INLINE },
  bulletList: { attrs: {}, content: ['listItem'], required: true },
  orderedList: { attrs: { start: (v) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999), type: nullOr('1') }, content: ['listItem'], required: true },
  listItem: { attrs: {}, content: IN_CELL, required: true },
  table: { attrs: {}, content: ['tableRow'], required: true },
  tableRow: { attrs: {}, content: ['tableCell', 'tableHeader'], required: true },
  // No merged cells: span 1 and no column width.
  tableCell: { attrs: { colspan: nullOr(1), rowspan: nullOr(1), colwidth: nullOr() }, content: IN_CELL, required: true },
  tableHeader: { attrs: { colspan: nullOr(1), rowspan: nullOr(1), colwidth: nullOr() }, content: IN_CELL, required: true },
  horizontalRule: { attrs: {} },
  pageBreak: { attrs: {} },
  text: { attrs: {}, marks: true },
  hardBreak: { attrs: {} },
  field: { attrs: { name: oneOf(...FIELD_DEFS.map((f) => f.name)) }, marks: true },
};

const MARK_RULES: Record<string, Record<string, AttrRule>> = {
  bold: {},
  italic: {},
  underline: {},
  // Font family and size only. No colour, no background, no anything else.
  textStyle: { fontFamily: nullOr(...FONT_STACKS), fontSize: nullOr(...FONT_SIZES) },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export type DocCheck = { ok: true; doc: DocJson } | { ok: false; reason: string };

/** The plain sentence for the author. `what` is where it was found ("the wording", "the header"). */
const no = (reason: string): DocCheck => ({ ok: false, reason });

function checkAttrs(where: string, attrs: unknown, rules: Record<string, AttrRule>): string | null {
  if (attrs === undefined) return null;
  if (!isRecord(attrs)) return `${where} has attributes that are not allowed.`;
  for (const [k, v] of Object.entries(attrs)) {
    const rule = rules[k];
    if (!rule) return `${where} has an attribute "${k}" that is not allowed.`;
    if (!rule(v)) return `${where} has a value for "${k}" that is not allowed.`;
  }
  return null;
}

/**
 * Judges a stored document. Returns the same object when it passes, or the sentence that says what is wrong. Refuses: any node or mark not on the list (`script`,
 * `iframe`, `image`, a link, a colour), any attribute or value not on the list, a merge field that is not on the whitelist, a tree that is too deep or too big.
 */
export function validateDoc(raw: unknown): DocCheck {
  if (!isRecord(raw) || raw.type !== 'doc' || !Array.isArray(raw.content)) return no('The document is not in a form that can be kept.');
  if (Object.keys(raw).some((k) => k !== 'type' && k !== 'content')) return no('The document has parts that are not allowed.');
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return no('The document is not in a form that can be kept.');
  }
  if (size > MAX_DOC_JSON) return no('The document is too large to keep. Shorten it.');
  let nodes = 0;
  let textLen = 0;

  const walk = (n: unknown, parent: readonly string[], depth: number): string | null => {
    if (!isRecord(n)) return 'The document holds something that is not a normal part of a page.';
    if (++nodes > MAX_NODES) return 'The document has too many parts. Shorten it.';
    if (depth > MAX_DEPTH) return 'The document is nested too deeply.';
    const type = n.type;
    if (typeof type !== 'string') return 'The document holds a part with no type.';
    const rule = Object.hasOwn(NODE_RULES, type) ? NODE_RULES[type] : undefined;
    if (!rule) return `The document holds a "${type}", which is not allowed. Only the formatting in the toolbar can be saved.`;
    if (!parent.includes(type)) return `A "${type}" is not allowed in that place.`;
    for (const k of Object.keys(n)) if (!['type', 'attrs', 'content', 'marks', 'text'].includes(k)) return `The "${type}" has a part "${k}" that is not allowed.`;
    if (type === 'field' && isRecord(n.attrs)) {
      const asked = n.attrs.name;
      if (!FIELD_DEFS.some((f) => f.name === asked)) return `The field "{{${String(asked).slice(0, 60)}}}" is not a known field. Type {{ and pick one from the list.`;
    }
    const a = checkAttrs(`The "${type}"`, n.attrs, rule.attrs);
    if (a) return a;
    if (type === 'text') {
      if (typeof n.text !== 'string' || n.text === '') return 'The document holds an empty piece of text.';
      textLen += n.text.length;
      if (n.content !== undefined) return 'A piece of text cannot hold other parts.';
    } else if (n.text !== undefined) return `The "${type}" cannot carry text.`;
    if (n.marks !== undefined) {
      if (!rule.marks) return `The "${type}" cannot be formatted.`;
      if (!Array.isArray(n.marks)) return 'The formatting is not in a form that can be kept.';
      const seen = new Set<string>();
      for (const m of n.marks) {
        if (!isRecord(m) || typeof m.type !== 'string') return 'The formatting is not in a form that can be kept.';
        for (const k of Object.keys(m)) if (k !== 'type' && k !== 'attrs') return `The formatting "${m.type}" has a part that is not allowed.`;
        const mr = Object.hasOwn(MARK_RULES, m.type) ? MARK_RULES[m.type] : undefined;
        if (!mr) return `The formatting "${m.type}" is not allowed (only bold, italic, underline, font and size).`;
        const ma = checkAttrs(`The formatting "${m.type}"`, m.attrs, mr);
        if (ma) return ma;
        if (seen.has(m.type)) return `The formatting "${m.type}" is applied twice.`;
        seen.add(m.type);
      }
    }
    if (rule.content) {
      if (n.content !== undefined && !Array.isArray(n.content)) return `The "${type}" has contents that are not allowed.`;
      const kids = (n.content ?? []) as unknown[];
      if (rule.required && kids.length === 0) return `A "${type}" cannot be empty.`;
      for (const c of kids) {
        const e = walk(c, rule.content, depth + 1);
        if (e) return e;
      }
    } else if (n.content !== undefined) return `The "${type}" cannot hold other parts.`;
    return null;
  };

  for (const c of raw.content) {
    const e = walk(c, BLOCKS, 1);
    if (e) return no(e);
  }
  if (textLen > MAX_DOC_TEXT) return no(`The wording is too long. The limit is 50,000 characters; this has ${textLen.toLocaleString('en-US')}.`);
  return { ok: true, doc: raw as unknown as DocJson };
}

export const emptyDoc = (): DocJson => ({ type: 'doc', content: [{ type: 'paragraph' }] });

// ---------------------------------------------------------------------------------------------------------------------
// Reading a document
// ---------------------------------------------------------------------------------------------------------------------
function inlineText(n: DocNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'field') return `{{${String(n.attrs?.name ?? '')}}}`;
  if (n.type === 'hardBreak') return '\n';
  return (n.content ?? []).map(inlineText).join('');
}

function blockText(n: DocNode, prefix = ''): string {
  switch (n.type) {
    case 'bulletList':
    case 'orderedList':
      return (n.content ?? [])
        .map((li, i) => `${prefix}${n.type === 'bulletList' ? '- ' : `${i + 1}. `}${(li.content ?? []).map((b) => blockText(b, '  ')).join('\n').trimStart()}`)
        .join('\n');
    case 'table':
      return (n.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((b) => blockText(b)).join(' ')).join(' | ')).join('\n');
    case 'horizontalRule':
      return '---';
    case 'pageBreak':
      return '';
    default:
      return prefix + inlineText(n);
  }
}

/** The document as plain text with `{{field}}` for each tag: kept in the old `body` column so history, search and any plain reader still work. Blocks are separated by a blank line. */
export function plainTextOf(doc: DocJson): string {
  return doc.content
    .map((b) => blockText(b))
    .filter((t, i, all) => t !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function* nodesOf(n: DocNode): Generator<DocNode> {
  yield n;
  for (const c of n.content ?? []) yield* nodesOf(c);
}
export const allNodes = (doc: DocJson): Generator<DocNode> => nodesOf({ type: 'doc', content: doc.content });

/** The field names used in a document, in order of first appearance, without duplicates. */
export function fieldsInDoc(doc: DocJson): string[] {
  const out: string[] = [];
  for (const n of allNodes(doc)) if (n.type === 'field' && typeof n.attrs?.name === 'string' && !out.includes(n.attrs.name)) out.push(n.attrs.name);
  return out;
}

const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9 ._/-]{2,}\]/g;
/** `[EMPLOYEE FULL NAME]`-style text that was probably meant to be a fill-in field. A warning, never a block. */
export function placeholderLookalikes(...docs: ReadonlyArray<DocJson | null | undefined>): string[] {
  const out: string[] = [];
  for (const d of docs) {
    if (!d) continue;
    for (const n of allNodes(d)) if (n.type === 'text') for (const m of (n.text ?? '').matchAll(PLACEHOLDER_RE)) if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------------------------------------------------
/**
 * Replaces every `field` node with plain TEXT. A missing, null or blank value becomes `[missing: name]` ('marker', the issue body: the issuer must fix it) or nothing
 * ('blank', a header or footer: a store with no address just prints no address line). Marks on the tag carry over to the text. A paragraph whose only content was
 * blank fields is dropped, so a letterhead does not keep an empty line.
 */
export function fillDoc(doc: DocJson, values: MergeValues, mode: 'marker' | 'blank' = 'marker'): DocJson {
  const fillInline = (n: DocNode): DocNode[] => {
    if (n.type !== 'field') return [n];
    const name = String(n.attrs?.name ?? '');
    const v = values[name as MergeField];
    const blank = v === null || v === undefined || v.trim() === '';
    if (blank && mode === 'blank') return [];
    return [{ type: 'text', text: blank ? `[missing: ${name}]` : v!, ...(n.marks && n.marks.length > 0 ? { marks: n.marks } : {}) }];
  };
  const fill = (n: DocNode): DocNode[] => {
    if (!n.content) return [n];
    const had = n.content.some((c) => c.type === 'field');
    const content = n.content.flatMap((c) => (n.type === 'paragraph' || n.type === 'heading' ? fillInline(c) : fill(c)));
    // Only a 'blank' fill can empty a line that held a field (a marker is text): that line is dropped.
    if (had && content.length === 0 && (n.type === 'paragraph' || n.type === 'heading')) return [];
    return [{ ...n, content }];
  };
  const content = doc.content.flatMap(fill);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/** True when the filled document still has a gap the issuer must fix (the same `[missing: x]` marker the plain text used). */
export function missingInDoc(doc: DocJson): string[] {
  const out: string[] = [];
  for (const n of allNodes(doc)) if (n.type === 'text') for (const m of (n.text ?? '').matchAll(/\[missing: ([a-z_.]+)\]/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The old plain markup -> a document (T-584 bodies; the original `body` text stays in the table)
// ---------------------------------------------------------------------------------------------------------------------
function textWithFields(text: string, marks: DocMark[] | undefined): DocNode[] {
  const out: DocNode[] = [];
  const known = new Set(FIELD_DEFS.map((f) => f.name));
  const push = (t: string) => {
    // A single newline inside a paragraph was a line break.
    t.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (line !== '') out.push({ type: 'text', text: line, ...(marks ? { marks } : {}) });
    });
  };
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = m[1]!;
    if (!known.has(name as MergeField)) continue; // an unknown name stays as the literal text it was
    push(text.slice(last, m.index));
    out.push({ type: 'field', attrs: { name }, ...(marks ? { marks } : {}) });
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

/** Converts a T-584 plain body to a document: blank line = paragraph, `# ` = heading (level 2, as it was drawn), `**bold**` = bold, `{{x}}` = a field tag. Wording is kept exactly. */
export function legacyBodyToDoc(body: string): DocJson {
  const content: DocNode[] = parseBody(body).map((b): DocNode => {
    if (b.type === 'heading') {
      const inline = textWithFields(b.text, undefined);
      return { type: 'heading', attrs: { level: 2 }, ...(inline.length > 0 ? { content: inline } : {}) };
    }
    const inline = b.runs.flatMap((r) => textWithFields(r.text, r.bold ? [{ type: 'bold' }] : undefined));
    return { type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) };
  });
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/** The letterhead a new template starts with, and what an old template gets on its first edit (the old print drew the company and store lines at the top). */
export function defaultLetterheadDoc(): DocJson {
  const line = (name: string, bold: boolean): DocNode => ({
    type: 'paragraph',
    attrs: { textAlign: 'center' },
    content: [{ type: 'field', attrs: { name }, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  return { type: 'doc', content: [line('org.legal_name', true), line('store.name', false), line('store.address', false), line('store.phone', false)] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sample values for the preview
// ---------------------------------------------------------------------------------------------------------------------
export function sampleValues(): MergeValues {
  return Object.fromEntries(FIELD_DEFS.map((f) => [f.name, f.sample])) as MergeValues;
}

/** The doc a template version holds: its stored document, or the old body converted. */
export function effectiveDoc(stored: unknown, body: string): DocJson {
  if (stored !== null && stored !== undefined) {
    const c = validateDoc(stored);
    if (c.ok) return c.doc;
  }
  return legacyBodyToDoc(body);
}

