'use client';
/**
 * The template editor. T-637 s1-s6. One screen: the template's name, kind and signatures, the page (margins), the letterhead header and footer, and the wording, each written in the document
 * editor; a Preview switch shows the EXACT A4 page (the same sheet and stylesheet the print route uses) with sample values, or with one chosen employee's real ones. "Print" prints just that sheet.
 *
 * Save sends the three documents as JSON to the server action, which judges them against the whitelist and writes a new version. A refusal is shown here and nothing typed is lost.
 */
import { useState } from 'react';
import {
  MARGIN_WORDS,
  PAGE_MARGIN_KEYS,
  fillDoc,
  sampleValues,
  type DocJson,
  type PageMargin,
} from '@shareat/domain/documents/doc';
import type { MergeValues } from '@shareat/domain';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field, FormGrid } from '@/components/ui/FormGrid';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DocumentDoc, DocumentSheet } from './DocumentDoc';
import { DocumentEditor } from './DocumentEditor';

export interface TemplateEditorProps {
  templateId?: string;
  initial: { name: string; kindId: string; slots: string[]; margins: PageMargin; body: DocJson; header: DocJson | null; footer: DocJson | null };
  kinds: Array<{ id: string; name: string }>;
  slots: Array<{ value: string; label: string }>;
  employees: Array<{ id: string; label: string }>;
  /** Writes a new version; redirects on success, returns the sentence on a refusal. */
  save: (input: { templateId?: string; name: string; kindId: string; slots: string[]; margins: PageMargin; bodyDoc: DocJson; headerDoc: DocJson | null; footerDoc: DocJson | null }) => Promise<{ error: string } | void>;
  /** The values issue would fill in for one employee. */
  previewValues: (employmentId: string) => Promise<{ values: MergeValues } | { error: string }>;
}

export function TemplateEditor({ templateId, initial, kinds, slots, employees, save, previewValues }: TemplateEditorProps) {
  const [name, setName] = useState(initial.name);
  const [kindId, setKindId] = useState(initial.kindId);
  const [picked, setPicked] = useState<string[]>(initial.slots);
  const [margins, setMargins] = useState<PageMargin>(initial.margins);
  const [body, setBody] = useState<DocJson>(initial.body);
  const [header, setHeader] = useState<DocJson | null>(initial.header);
  const [footer, setFooter] = useState<DocJson | null>(initial.footer);
  const [preview, setPreview] = useState(false);
  const [who, setWho] = useState('');
  const [values, setValues] = useState<MergeValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(id: string) {
    setWho(id);
    setValues(null);
    if (!id) return;
    const r = await previewValues(id);
    if ('error' in r) setError(r.error);
    else setValues(r.values);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await save({ ...(templateId ? { templateId } : {}), name, kindId, slots: picked, margins, bodyDoc: body, headerDoc: header, footerDoc: footer });
      if (r && 'error' in r) setError(r.error);
    } catch (e) {
      // A successful save redirects (Next throws to do it); anything else is shown.
      if (!(e instanceof Error && /NEXT_REDIRECT/.test(`${e.message}${(e as { digest?: string }).digest ?? ''}`))) setError('This could not be saved. Try again.');
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  const vals = who && values ? values : sampleValues();
  const filledBody = fillDoc(body, vals, 'marker');
  const page = { margins, headerDoc: header ? fillDoc(header, vals, 'blank') : null, footerDoc: footer ? fillDoc(footer, vals, 'blank') : null };

  return (
    <div className="space-y-5">
      {error && <Banner tone="error">{error}</Banner>}

      <FormGrid>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Certificate of Employment" className="w-full" />
        </Field>
        <Field label="Kind">
          <Select value={kindId} onChange={(e) => setKindId(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Page margins" hint="Paper is A4. The same margins print.">
          <Select value={margins} onChange={(e) => setMargins(e.target.value as PageMargin)}>
            {PAGE_MARGIN_KEYS.map((m) => (
              <option key={m} value={m}>
                {MARGIN_WORDS[m]}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
      <fieldset className="flex flex-wrap items-center gap-x-6">
        <legend className="text-sm font-medium">Signatures this document needs</legend>
        {slots.map((s) => (
          <Checkbox key={s.value} checked={picked.includes(s.value)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.value] : picked.filter((x) => x !== s.value))} label={s.label} />
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3" role="group" aria-label="View">
        <Button type="button" variant={preview ? 'secondary' : 'primary'} icon={null} aria-pressed={!preview} onClick={() => setPreview(false)}>
          Write
        </Button>
        <Button type="button" variant={preview ? 'primary' : 'secondary'} icon={null} aria-pressed={preview} onClick={() => setPreview(true)}>
          Preview
        </Button>
        {preview && (
          <>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Fill with</span>
              <Select aria-label="Preview with" value={who} onChange={(e) => void choose(e.target.value)}>
                <option value="">Sample values</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="button" variant="secondary" icon={null} onClick={() => window.print()}>
              Print or save as PDF
            </Button>
          </>
        )}
      </div>

      {/* The writing surfaces stay mounted while the preview shows, so nothing typed is lost by looking. */}
      <div hidden={preview} className="space-y-5">
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Letterhead: header</h2>
          <p className="text-sm text-muted">Repeats at the top of every page. It may hold fields, like the company name or the store address. Leave it empty for none.</p>
          <DocumentEditor label="Header" compact initialDoc={initial.header ?? { type: 'doc', content: [{ type: 'paragraph' }] }} onChange={setHeader} />
        </section>
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Wording</h2>
          <p className="text-sm text-muted">
            Type {'{{'} to insert a field the system fills in when the document is issued, for example the employee&apos;s name. Text in square brackets is printed exactly as written.
          </p>
          <DocumentEditor label="Wording" initialDoc={initial.body} onChange={setBody} />
        </section>
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Letterhead: footer</h2>
          <p className="text-sm text-muted">Repeats at the bottom of every page. Optional.</p>
          <DocumentEditor label="Footer" compact initialDoc={initial.footer ?? { type: 'doc', content: [{ type: 'paragraph' }] }} onChange={setFooter} />
        </section>
      </div>

      {preview && (
        <section className="space-y-2" aria-label="Preview of the A4 page">
          <p className="text-sm text-muted">
            {who && values ? 'Filled with the chosen employee. A gap reads [missing: …]: the issuer would have to fill it in.' : 'Filled with made-up sample values.'} This is the page that prints.
          </p>
          <DocumentSheet page={page}>
            <DocumentDoc doc={filledBody} />
          </DocumentSheet>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" disabled={busy} onClick={() => void submit()}>
          {templateId ? 'Save as a new version' : 'Save'}
        </Button>
        <a href="/documents/templates" className="inline-flex min-h-11 items-center text-sm underline">
          Back to templates
        </a>
      </div>
    </div>
  );
}
