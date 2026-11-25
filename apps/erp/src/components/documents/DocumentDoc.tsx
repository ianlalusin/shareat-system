import type { CSSProperties, ReactNode } from 'react';
import {
  FIELD_LABELS,
  FONT_FAMILIES,
  FONT_SIZES,
  LINE_HEIGHTS,
  PAGE_MARGINS,
  TEXT_ALIGNS,
  FONT_STACKS,
  type DocJson,
  type DocNode,
  type DocPage,
  type PageMargin,
} from '@shareat/domain/documents/doc';

/**
 * A document drawn as React ELEMENTS. T-637 (docs/tasks/637-document-editor.md s1, s6).
 *
 * The stored document is JSON that the server has already judged against a strict whitelist (`validateDoc`). This renderer is the second lock: it turns each known node into an
 * ordinary element, every piece of text into a React TEXT node (React escapes it), and reads a style value only if it is on the fixed list (alignment, line spacing, the three font
 * stacks, the seven sizes, the three margins). No raw-markup escape hatch is used anywhere in this path (a test scans for it), so a `<script>` typed into a template prints as the
 * characters `<script>`. A node it does not know draws nothing.
 *
 * Preview, print and the issue screen all use this one component and one stylesheet, so what the author sees is the page that prints.
 */

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const ALIGNS = TEXT_ALIGNS as readonly string[];

function blockStyle(attrs: DocNode['attrs']): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (has(ALIGNS, attrs?.textAlign)) style.textAlign = attrs!.textAlign as CSSProperties['textAlign'];
  if (has(LINE_HEIGHTS, attrs?.lineHeight)) style.lineHeight = Number(attrs!.lineHeight);
  return Object.keys(style).length > 0 ? style : undefined;
}

function Marked({ node, children }: { node: DocNode; children: ReactNode }) {
  let out = children;
  for (const m of node.marks ?? []) {
    if (m.type === 'bold') out = <strong>{out}</strong>;
    else if (m.type === 'italic') out = <em>{out}</em>;
    else if (m.type === 'underline') out = <u>{out}</u>;
    else if (m.type === 'textStyle') {
      const style: CSSProperties = {};
      if (has(FONT_STACKS, m.attrs?.fontFamily)) style.fontFamily = m.attrs!.fontFamily as string;
      if (has(FONT_SIZES, m.attrs?.fontSize)) style.fontSize = m.attrs!.fontSize as string;
      if (Object.keys(style).length > 0) out = <span style={style}>{out}</span>;
    }
  }
  return <>{out}</>;
}

function Inline({ nodes }: { nodes: DocNode[] | undefined }) {
  if (!nodes || nodes.length === 0) return <>{' '}</>;
  return (
    <>
      {nodes.map((n, i) => {
        if (n.type === 'text') return <Marked key={i} node={n}>{n.text}</Marked>;
        if (n.type === 'hardBreak') return <br key={i} />;
        // An unfilled tag (a template shown as it is stored) reads as its plain label in a grey chip.
        if (n.type === 'field') {
          const label = FIELD_LABELS[String(n.attrs?.name)] ?? 'Unknown field';
          return (
            <Marked key={i} node={n}>
              <span className="doc-field">{label}</span>
            </Marked>
          );
        }
        return null;
      })}
    </>
  );
}

const HEADING_SIZE: Record<number, string> = { 1: '20pt', 2: '16pt', 3: '13pt' };

function Blocks({ nodes }: { nodes: DocNode[] | undefined }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        switch (n.type) {
          case 'paragraph':
            return (
              <p key={i} style={blockStyle(n.attrs)}>
                <Inline nodes={n.content} />
              </p>
            );
          case 'heading': {
            const level = typeof n.attrs?.level === 'number' && n.attrs.level >= 1 && n.attrs.level <= 3 ? n.attrs.level : 2;
            const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3';
            return (
              <Tag key={i} style={{ fontSize: HEADING_SIZE[level], ...blockStyle(n.attrs) }}>
                <Inline nodes={n.content} />
              </Tag>
            );
          }
          case 'bulletList':
            return (
              <ul key={i}>
                <Blocks nodes={n.content} />
              </ul>
            );
          case 'orderedList':
            return (
              <ol key={i} start={Number.isInteger(n.attrs?.start) ? (n.attrs!.start as number) : 1}>
                <Blocks nodes={n.content} />
              </ol>
            );
          case 'listItem':
            return (
              <li key={i}>
                <Blocks nodes={n.content} />
              </li>
            );
          case 'table':
            return (
              <table key={i} className="doc-table">
                <tbody>
                  <Blocks nodes={n.content} />
                </tbody>
              </table>
            );
          case 'tableRow':
            return (
              <tr key={i}>
                <Blocks nodes={n.content} />
              </tr>
            );
          case 'tableCell':
            return (
              <td key={i}>
                <Blocks nodes={n.content} />
              </td>
            );
          case 'tableHeader':
            return (
              <th key={i}>
                <Blocks nodes={n.content} />
              </th>
            );
          case 'horizontalRule':
            return <hr key={i} />;
          case 'pageBreak':
            return <div key={i} className="doc-page-break" aria-label="Page break" />;
          default:
            return null;
        }
      })}
    </>
  );
}

/** The document's blocks, with no page around them (a header, a footer, a signature slot's neighbour). */
export function DocumentDoc({ doc, className }: { doc: DocJson; className?: string }) {
  return (
    <div className={className}>
      <Blocks nodes={doc.content} />
    </div>
  );
}

/**
 * The stylesheet of the page. One constant string: the only value spliced in is a margin taken from the three fixed choices (`PAGE_MARGINS`), never author text.
 * Print: A4, the chosen margin, the header and footer repeat on every sheet (a table's header and footer groups), a page-break node breaks the page, and everything on the screen
 * that is not the sheet is hidden (`:has` keeps only the sheet's ancestors), so the app chrome never prints and no blank pages follow.
 */
const sansStack = FONT_FAMILIES[1].stack;
function sheetCss(margin: string, sheet: boolean): string {
  return `
.doc-sheet { box-sizing: border-box; width: 210mm; min-height: 297mm; margin: 0 auto; padding: ${margin}; background: #fff; color: #000; font-family: ${sansStack}; font-size: 11pt; line-height: 1.15; box-shadow: 0 1px 6px rgba(0,0,0,.25); overflow-wrap: anywhere; }
.doc-sheet * { box-sizing: border-box; }
.doc-frame { width: 100%; border-collapse: collapse; border: 0; }
.doc-frame > thead { display: table-header-group; }
.doc-frame > tfoot { display: table-footer-group; }
.doc-frame td { padding: 0; vertical-align: top; }
.doc-sheet p { margin: 0 0 .6em; }
.doc-sheet h1, .doc-sheet h2, .doc-sheet h3 { margin: .8em 0 .4em; font-weight: 700; line-height: 1.2; }
.doc-sheet ul { list-style: disc; padding-left: 1.6em; margin: 0 0 .6em; }
.doc-sheet ol { list-style: decimal; padding-left: 1.6em; margin: 0 0 .6em; }
.doc-sheet li > p { margin: 0 0 .2em; }
.doc-sheet hr { border: 0; border-top: 1px solid #000; margin: .8em 0; }
.doc-sheet .doc-table { width: 100%; border-collapse: collapse; margin: 0 0 .6em; table-layout: fixed; }
.doc-sheet .doc-table td, .doc-sheet .doc-table th { border: 1px solid #000; padding: 3pt 5pt; vertical-align: top; text-align: left; }
.doc-sheet .doc-table th { font-weight: 700; background: #f0f0f0; }
.doc-sheet .doc-table p { margin: 0; }
.doc-sheet .doc-field { background: #e5e5e5; border-radius: 3px; padding: 0 .25em; }
.doc-sheet .doc-page-break { border-top: 2px dashed #888; margin: 1em 0; }
.doc-sheet .doc-page-break::after { content: 'Page break'; display: block; font: 8pt ${sansStack}; color: #888; text-align: center; }
.doc-sheet.doc-inline { width: auto; min-height: 0; padding: .75rem; box-shadow: none; font-size: 10pt; }
@media print {${
    sheet
      ? `
  @page { size: A4; margin: ${margin}; }
  body:has(.doc-print-root) *:not(:has(.doc-print-root)):not(.doc-print-root):not(.doc-print-root *) { display: none !important; }
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; }
  .doc-sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }`
      : ''
  }
  .doc-sheet .doc-page-break { border: 0; margin: 0; height: 0; break-after: page; }
  .doc-sheet .doc-page-break::after { content: none; }
  .doc-sheet .doc-table tr, .doc-sheet li { break-inside: avoid; }
}`;
}

/**
 * The A4 page: header (repeated on every sheet), the body, footer (repeated). `children` is the body: the document, and whatever the caller adds around it (the number line, the
 * signature slots). `header` and `footer` are drawn as documents; `legacyHeader` is the built-in company block of a version from before T-637.
 */
export function DocumentSheet({ page, legacyHeader, children, voided }: { page: DocPage | null; legacyHeader?: ReactNode; children: ReactNode; voided?: boolean }) {
  const margins: PageMargin = page?.margins && page.margins in PAGE_MARGINS ? page.margins : 'normal';
  return (
    <div className="doc-print-root max-w-full overflow-x-auto bg-neutral-200 p-3 print:overflow-visible print:bg-white print:p-0 dark:bg-neutral-800">
      <style>{sheetCss(PAGE_MARGINS[margins], true)}</style>
      <div className="doc-sheet relative">
        {voided && (
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <span style={{ transform: 'rotate(-12deg)', fontSize: '96pt', fontWeight: 900, letterSpacing: '.1em', color: '#dc2626', opacity: 0.2 }}>VOID</span>
          </div>
        )}
        <table className="doc-frame">
          <thead>
            <tr>
              <td>{legacyHeader ?? (page?.headerDoc ? <DocumentDoc doc={page.headerDoc} className="doc-header" /> : null)}</td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{children}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>{page?.footerDoc ? <DocumentDoc doc={page.footerDoc} className="doc-footer" /> : null}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** A document in a small panel (a version in the history list): the same elements and the same look, with no A4 width and no print rules. */
export function DocumentBlock({ doc, className }: { doc: DocJson; className?: string }) {
  return (
    <div className={`doc-sheet doc-inline ${className ?? ''}`}>
      <style>{sheetCss(PAGE_MARGINS.normal, false)}</style>
      <Blocks nodes={doc.content} />
    </div>
  );
}
