'use client';
/**
 * The document editor. T-637 (docs/tasks/637-document-editor.md s1-s3). A rich-text surface (TipTap, MIT) that produces the JSON document `validateDoc` judges on the server.
 *
 * Toolbar: style (paragraph, three headings), font (three), size (seven), bold / italic / underline, alignment, line spacing, bullet and numbered lists, a simple table (no merged
 * cells), a rule, a page break, undo / redo, and "Insert field". Typing `{{` opens the list of every field, filtered as you type; Enter or a tap inserts the tag. No colours, images or links.
 *
 * It tells its parent the document on every change (`onChange`); the parent sends it to the server inside the form. `fields={false}` is the issue screen: the wording there is filled text.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { FIELD_DEFS, FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, suggestFields, type DocJson, type FieldDef } from '@shareat/domain/documents/doc';
import { Select } from '@/components/ui/Select';
import { DocumentStyles } from './DocumentDoc';
import { documentExtensions, fieldNode } from './editor-extensions';
import { FieldSuggestList } from './FieldSuggestList';

interface Pop {
  items: FieldDef[];
  index: number;
  rect: { left: number; bottom: number } | null;
  pick: (f: FieldDef) => void;
}

// Literal class strings (the touch-target census reads them statically).
const BTN_ON = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-ink bg-canvas px-2 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40';
const BTN_OFF = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-field-border px-2 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40';

function Btn({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active === undefined ? undefined : active} disabled={disabled} onClick={onClick} className={active ? BTN_ON : BTN_OFF}>
      {children}
    </button>
  );
}

export interface DocumentEditorProps {
  initialDoc: DocJson;
  onChange: (doc: DocJson) => void;
  /** Field tags and the `{{` list. Off for the wording of a document being issued. */
  fields?: boolean;
  /** A short name for the surface, read by a screen reader ("Wording", "Header"). */
  label: string;
  /** A smaller writing area (the header and footer). */
  compact?: boolean;
}

export function DocumentEditor({ initialDoc, onChange, fields = true, label, compact = false }: DocumentEditorProps) {
  const [pop, setPop] = useState<Pop | null>(null);
  const popRef = useRef<Pop | null>(null);
  popRef.current = pop;
  const wrap = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () =>
      documentExtensions(
        fields
          ? fieldNode({
              char: '{{',
              allowedPrefixes: null,
              items: ({ query }) => suggestFields(query),
              command: ({ editor, range, props }) => {
                const f = props as FieldDef;
                editor.chain().focus().insertContentAt(range, [{ type: 'field', attrs: { name: f.name } }, { type: 'text', text: ' ' }]).run();
              },
              render: () => ({
                onStart: (p) => setPop({ items: p.items as FieldDef[], index: 0, rect: p.clientRect?.() ?? null, pick: (f) => p.command(f) }),
                onUpdate: (p) => setPop({ items: p.items as FieldDef[], index: 0, rect: p.clientRect?.() ?? null, pick: (f) => p.command(f) }),
                onKeyDown: ({ event }) => {
                  const cur = popRef.current;
                  if (!cur) return false;
                  if (event.key === 'Escape') {
                    setPop(null);
                    return true;
                  }
                  if (cur.items.length === 0) return false;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    const d = event.key === 'ArrowDown' ? 1 : -1;
                    setPop({ ...cur, index: (cur.index + d + cur.items.length) % cur.items.length });
                    return true;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    cur.pick(cur.items[cur.index]!);
                    return true;
                  }
                  return false;
                },
                onExit: () => setPop(null),
              }),
            })
          : null,
      ),
    [fields],
  );

  const editor = useEditor({
    extensions,
    content: initialDoc,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', class: 'outline-none' } },
    // ProseMirror's attrs objects have no prototype, which a server-action call cannot carry (it silently drops them): round-trip to plain JSON.
    onUpdate: ({ editor: e }) => onChangeRef.current(JSON.parse(JSON.stringify(e.getJSON())) as DocJson),
  });

  // Cancel (a form reset) puts the stored wording back.
  useEffect(() => {
    const form = wrap.current?.closest('form');
    if (!form || !editor) return;
    const reset = () => {
      editor.commands.setContent(initialDoc);
      onChangeRef.current(initialDoc);
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [editor, initialDoc]);

  if (!editor) return <div ref={wrap} className="min-h-40 rounded-lg border border-field-border bg-field" aria-busy="true" />;
  return (
    <div ref={wrap} className="space-y-2">
      <DocumentStyles />
      <Toolbar editor={editor} fields={fields} />
      <div className="doc-sheet doc-inline overflow-x-auto rounded-lg border border-field-border" style={{ minHeight: compact ? '6rem' : '20rem' }}>
        <EditorContent editor={editor} />
      </div>
      {pop && (
        <div
          className="fixed z-50 w-80 max-w-[90vw] rounded-lg border border-field-border bg-surface shadow-lg"
          style={{ left: Math.max(8, Math.min(pop.rect?.left ?? 16, (typeof window === 'undefined' ? 600 : window.innerWidth) - 330)), top: (pop.rect?.bottom ?? 120) + 6 }}
        >
          <FieldSuggestList items={pop.items} selected={pop.index} onPick={pop.pick} />
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor, fields }: { editor: Editor; fields: boolean }) {
  const c = () => editor.chain().focus();
  const style = editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';
  const ts = editor.getAttributes('textStyle') as { fontFamily?: string | null; fontSize?: string | null };
  const lh = (editor.getAttributes('paragraph').lineHeight ?? editor.getAttributes('heading').lineHeight ?? '') as string;
  const inTable = editor.isActive('table');
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1.5">
      <Select aria-label="Paragraph style" value={style} onChange={(e) => (e.target.value === 'p' ? c().setParagraph().run() : c().toggleHeading({ level: Number(e.target.value.slice(1)) as 1 | 2 | 3 }).run())}>
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </Select>
      <Select aria-label="Font" value={ts.fontFamily ?? ''} onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}>
        <option value="">Font</option>
        {FONT_FAMILIES.map((f) => (
          <option key={f.label} value={f.stack}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select aria-label="Size" value={ts.fontSize ?? ''} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}>
        <option value="">Size</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s.replace('pt', ' pt')}
          </option>
        ))}
      </Select>
      <Btn label="Bold" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()}>
        <b>B</b>
      </Btn>
      <Btn label="Italic" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()}>
        <i>I</i>
      </Btn>
      <Btn label="Underline" active={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()}>
        <u>U</u>
      </Btn>
      {(['left', 'center', 'right', 'justify'] as const).map((a) => (
        <Btn key={a} label={`Align ${a}`} active={editor.isActive({ textAlign: a })} onClick={() => c().setTextAlign(a).run()}>
          {{ left: 'L', center: 'C', right: 'R', justify: 'J' }[a]}
        </Btn>
      ))}
      <Select aria-label="Line spacing" value={lh} onChange={(e) => c().updateAttributes('paragraph', { lineHeight: e.target.value || null }).updateAttributes('heading', { lineHeight: e.target.value || null }).run()}>
        <option value="">Spacing</option>
        {LINE_HEIGHTS.map((h) => (
          <option key={h} value={h}>
            {Number(h).toFixed(h === '1.15' ? 2 : 1)}
          </option>
        ))}
      </Select>
      <Btn label="Bullet list" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()}>
        •
      </Btn>
      <Btn label="Numbered list" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()}>
        1.
      </Btn>
      <Btn label="Insert table (3 by 3)" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run()}>
        Table
      </Btn>
      {inTable && (
        <>
          <Btn label="Add row below" onClick={() => c().addRowAfter().run()}>
            +Row
          </Btn>
          <Btn label="Add column right" onClick={() => c().addColumnAfter().run()}>
            +Col
          </Btn>
          <Btn label="Delete row" onClick={() => c().deleteRow().run()}>
            -Row
          </Btn>
          <Btn label="Delete column" onClick={() => c().deleteColumn().run()}>
            -Col
          </Btn>
          <Btn label="Delete table" onClick={() => c().deleteTable().run()}>
            -Table
          </Btn>
        </>
      )}
      <Btn label="Horizontal rule" onClick={() => c().setHorizontalRule().run()}>
        —
      </Btn>
      <Btn label="Page break" onClick={() => c().insertContent({ type: 'pageBreak' }).run()}>
        Break
      </Btn>
      <Btn label="Undo" disabled={!editor.can().undo()} onClick={() => c().undo().run()}>
        ↶
      </Btn>
      <Btn label="Redo" disabled={!editor.can().redo()} onClick={() => c().redo().run()}>
        ↷
      </Btn>
      {fields && (
        <Select
          aria-label="Insert field"
          value=""
          onChange={(e) => {
            if (e.target.value) c().insertContent([{ type: 'field', attrs: { name: e.target.value } }, { type: 'text', text: ' ' }]).run();
          }}
        >
          <option value="">Insert field</option>
          {FIELD_DEFS.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
