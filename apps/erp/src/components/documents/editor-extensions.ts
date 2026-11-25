'use client';
/**
 * The editor's schema. T-637. Exactly the nodes and marks `validateDoc` (packages/domain documents/doc.ts) accepts, and no others: the starter kit's quote, code, strike and link are
 * switched off, and nothing with a colour or an image is added. The server judges every save again; this only keeps the toolbar and the paste handler from making what it would refuse.
 *
 * The extensions are MIT-licensed open source (TipTap / ProseMirror). No "Pro" extension is used.
 */
import { Extension, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { FIELD_LABELS } from '@shareat/domain/documents/doc';

/** `line-height` as a paragraph / heading attribute (the whitelist's 1.0 / 1.15 / 1.5 / 2.0). */
const LineHeight = Extension.create({
  name: 'lineHeight',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.lineHeight || null,
            renderHTML: (attrs: Record<string, unknown>) => (attrs.lineHeight ? { style: `line-height:${String(attrs.lineHeight)}` } : {}),
          },
        },
      },
    ];
  },
});

/** A hard page break: a block with no content. */
const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'doc-page-break' }],
});

/** A fill-in field: an inline, non-editable TAG whose `name` is on the merge-field whitelist, drawn as a grey chip with its plain label. */
export function fieldNode(suggestion: Omit<SuggestionOptions, 'editor'>) {
  return Node.create({
    name: 'field',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { name: { default: null } };
    },
    parseHTML: () => [{ tag: 'span[data-field]', getAttrs: (el) => ({ name: (el as HTMLElement).getAttribute('data-field') }) }],
    renderHTML: ({ node }) => ['span', mergeAttributes({ 'data-field': String(node.attrs.name), class: 'doc-field', contenteditable: 'false' }), FIELD_LABELS[String(node.attrs.name)] ?? 'Unknown field'],
    addProseMirrorPlugins() {
      return [Suggestion({ editor: this.editor, ...suggestion })];
    },
  });
}

/** `withFields`: the body and the letterhead may hold field tags (typing `{{` lists them); a document being issued may not. */
export function documentExtensions(field: ReturnType<typeof fieldNode> | null): Extensions {
  return [
    StarterKit.configure({ blockquote: false, code: false, codeBlock: false, strike: false, link: false, heading: { levels: [1, 2, 3] } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    FontFamily,
    FontSize,
    LineHeight,
    Table.configure({ resizable: false, HTMLAttributes: { class: 'doc-table' } }),
    TableRow,
    TableHeader,
    TableCell,
    PageBreak,
    ...(field ? [field] : []),
  ];
}
