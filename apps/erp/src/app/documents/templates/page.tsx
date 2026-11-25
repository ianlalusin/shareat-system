import { listDocumentKinds, listDocumentTemplateVersions, listDocumentTemplates, FIELD_DEFS, SLOT_WORDS, type DocumentKindItem, type TemplateListItem } from '@shareat/domain';
import { SIGNATURE_SLOTS, type SignatureSlot } from '@shareat/db/schema';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor, type TypedView } from '../../../lib/keep-typing';
import { withOrgPrincipal } from '../lib';
import { retireTemplateAction, saveTemplateAction } from './actions';
import { DOCUMENT_TEMPLATE_EDIT, NEW_TEMPLATE_RECORD } from './typed-forms';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { EditableRecord } from '@/components/forms';
import { Badge, Button, Checkbox, EmptyState, Field, FlashBanner, FormGrid, FormModal, Input, Select, Textarea } from '@/components/ui';

export const metadata = { title: 'Document templates — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * `/documents/templates`. T-584 S2.
 *
 * Where an administrator writes the wording of a certificate of employment, a memo, a notice to explain or a contract. The wording is plain text with a
 * few fields in double braces that the system fills in when a document is issued. Every save is a new version; documents already issued keep the version
 * they were written from. Admin only (`manage_document_templates`).
 */
export default async function DocumentTemplatesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/documents/templates');
  if (refusal) return refusal;

  const { templates, history, kinds } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const kinds = await listDocumentKinds(tx, actor);
    const templates = await listDocumentTemplates(tx, actor);
    const history = new Map<string, Awaited<ReturnType<typeof listDocumentTemplateVersions>>>();
    for (const t of templates) if (t.latest.versionNo > 1) history.set(t.id, await listDocumentTemplateVersions(tx, actor, t.id));
    return { templates, history, kinds };
  });
  const active = templates.filter((t) => !t.retired);
  const retired = templates.filter((t) => t.retired);
  const newTyped = typedFor(sp, DOCUMENT_TEMPLATE_EDIT, NEW_TEMPLATE_RECORD, actor.personId);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            <a href="/documents" className={ACTION_LINK}>
              Documents
            </a>{' '}
            / Templates
          </p>
          <h1 className="text-2xl font-semibold">Document templates</h1>
          <PageDescription>
            The standard wording for a certificate of employment, memo, notice to explain or contract. Fields in double braces, like {'{{employee.full_name}}'}, are
            filled in when a document is issued.
          </PageDescription>
          <p className="mt-1 text-sm text-muted">Each save is a new version. Documents already issued keep the wording they were written from.</p>
        </div>
        {/* T-589 B7: writing a new template is a header action; a refused save reopens it with the typing (defaultOpen). */}
        <FormModal trigger="+ New template" title="New template" size="lg" defaultOpen={newTyped?.kind === 'typed'}>
          <form action={saveTemplateAction} className="space-y-4 text-sm">
            <TemplateFields typed={newTyped} kinds={kinds} />
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-medium">Fields you can use in the wording</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {FIELD_DEFS.map((f) => (
            <div key={f.name} className="flex flex-wrap gap-x-2">
              <dt className="font-mono text-xs">{`{{${f.name}}}`}</dt>
              <dd className="text-muted">{f.label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-muted">
          Formatting: a blank line starts a new paragraph, a line that starts with # is a heading, and **double stars** make bold. Nothing else is read as formatting.
        </p>
      </details>

      {active.length === 0 ? (
        <EmptyState illustration="magnifier" title="No templates yet" body="Press New template to write the first one. Nothing is pre-filled: the wording is yours." />
      ) : (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Templates</h2>
          {active.map((t) => (
            <TemplateCard key={t.id} template={t} versions={history.get(t.id)} typed={typedFor(sp, DOCUMENT_TEMPLATE_EDIT, t.id, actor.personId)} kinds={kinds} />
          ))}
        </section>
      )}

      {retired.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Retired</h2>
          <p className="text-sm text-muted">Not offered for new documents. Documents already issued from them are untouched.</p>
          {retired.map((t) => (
            <article key={t.id} className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{t.name}</h3>
                <Badge tone="closed" label="Retired" />
                <span className="text-muted">
                  {t.kindName} · version {t.latest.versionNo}
                </span>
              </div>
            </article>
          ))}
        </section>
      )}
    </Page>
  );
}

function TemplateFields({ template, typed, kinds }: { template?: TemplateListItem; typed: TypedView | null; kinds: DocumentKindItem[] }) {
  // The page draws the STORED values as defaults; EditableRecord puts the user's typing back over them. A plain add form has no such layer, so it reads the typing itself.
  const t = typed?.kind === 'typed' ? typed.fields : null;
  const one = (name: string, stored: string): string => {
    const v = t?.[name];
    return typeof v === 'string' ? v : stored;
  };
  const slots = (t?.slot ? (Array.isArray(t.slot) ? t.slot : [t.slot]) : template?.latest.signatureSlots ?? ['issuer', 'employee']) as readonly string[];
  return (
    <>
      <FormGrid>
        <Field label="Name">
          <Input name="name" defaultValue={one('name', template?.name ?? '')} placeholder="Certificate of Employment" className="w-full" />
        </Field>
        <Field label="Kind">
          <Select name="kindId" defaultValue={one('kindId', template?.kindId ?? kinds.find((k) => k.active)?.id ?? '')}>
            {kinds
              .filter((k) => k.active || k.id === template?.kindId)
              .map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
          </Select>
        </Field>
      </FormGrid>
      <Field label="Wording" span="full" hint="Plain text. Use the fields listed above. A blank line starts a paragraph; # at the start of a line is a heading.">
        <Textarea name="body" rows={12} defaultValue={one('body', template?.latest.body ?? '')} className="w-full font-mono" />
      </Field>
      <fieldset className="flex flex-wrap items-center gap-x-6">
        <legend className="text-sm font-medium">Signatures this document needs</legend>
        {SIGNATURE_SLOTS.map((s: SignatureSlot) => (
          <Checkbox key={s} name="slot" value={s} defaultChecked={slots.includes(s)} label={SLOT_WORDS[s]} />
        ))}
      </fieldset>
    </>
  );
}

function TemplateCard({ template, versions, typed, kinds }: { template: TemplateListItem; versions: Awaited<ReturnType<typeof listDocumentTemplateVersions>> | undefined; typed: TypedView | null; kinds: DocumentKindItem[] }) {
  const older = (versions ?? []).filter((v) => v.versionNo !== template.latest.versionNo);
  return (
    <article className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{template.name}</h3>
        <Badge tone="info" label={`Version ${template.latest.versionNo}`} />
        <span className="text-sm text-muted">
          {template.kindName} · saved {formatBusinessDateTime(template.latest.createdAt, { dateStyle: 'medium' })} by {template.latest.createdByName}
        </span>
      </div>
      <EditableRecord
        action={saveTemplateAction}
        label={template.name}
        hidden={{ templateId: template.id }}
        typed={typed}
        extra={
          <form action={retireTemplateAction}>
            <input type="hidden" name="templateId" value={template.id} />
            <Button type="submit">Retire</Button>
          </form>
        }
      >
        <TemplateFields template={template} typed={null} kinds={kinds} />
      </EditableRecord>
      {older.length > 0 && (
        <details className="text-sm">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-neutral-600 dark:text-neutral-400">
            Earlier versions ({older.length})
          </summary>
          <ul className="mt-2 space-y-3">
            {older.map((v) => (
              <li key={v.id}>
                <p className="font-medium">
                  Version {v.versionNo} <span className="font-normal text-muted">· {formatBusinessDateTime(v.createdAt, { dateStyle: 'medium' })} · {v.createdByName}</span>
                </p>
                <pre className="mt-1 whitespace-pre-wrap rounded-md bg-canvas p-3 font-mono text-xs">{v.body}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
