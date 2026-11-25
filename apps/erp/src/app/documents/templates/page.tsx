import { listDocumentKinds, listDocumentTemplateVersions, listDocumentTemplates, FIELD_DEFS, type TemplateListItem } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { withOrgPrincipal } from '../lib';
import { typedFor } from '../../../lib/keep-typing';
import { DOCUMENT_KIND_EDIT } from './typed-forms';
import { createKindAction, renameKindAction, retireTemplateAction, setKindStatusAction } from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { DOCUMENT_KIND_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { Badge, Button, EmptyState, Field, FlashBanner, Input } from '@/components/ui';

export const metadata = { title: 'Document templates — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * `/documents/templates`. T-584 S2, T-637.
 *
 * The library: every template with its kind and version, a link to the editor, and the list of document KINDS (Certificate of employment, Memo, Explanation letter ...) that the
 * administrator edits here: add, rename, retire. Writing a template happens in the editor (`/documents/templates/new` and `/documents/templates/[id]`). Admin only (`manage_document_templates`).
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

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Document templates</h1>
          <PageDescription>
            The standard wording and page for each kind of document. Fields like the employee&apos;s name are filled in when a document is issued; type {'{{'} in the editor to insert one.
          </PageDescription>
          <p className="mt-1 text-sm text-muted">Each save is a new version. Documents already issued keep the wording they were written from.</p>
        </div>
        <a href="/documents/templates/new" className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white">
          + New template
        </a>
      </div>

      <FlashBanner flash={sp} />

      {active.length === 0 ? (
        <EmptyState illustration="magnifier" title="No templates yet" body="Press New template to write the first one. Nothing is pre-filled: the wording is yours." />
      ) : (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Templates</h2>
          {active.map((t) => (
            <TemplateCard key={t.id} template={t} versions={history.get(t.id)} />
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

      <section className="space-y-3" aria-labelledby="kinds-h">
        <h2 id="kinds-h" className="text-lg font-semibold">
          Document kinds
        </h2>
        <p className="text-sm text-muted">
          The kinds you can pick for a template, and filter the register by. Add your own, for example Warning letter. A kind cannot be retired while a template that is in use has it; documents already
          issued keep the name they were issued with.
        </p>
        <div className="space-y-2">
          {kinds.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <span className="min-w-0 flex-1 font-medium">{k.name}</span>
              {!k.active && <Badge tone="closed" label="Retired" />}
              <EditableRecord
                action={renameKindAction}
                label={k.name}
                hidden={{ kindId: k.id }}
                rules={DOCUMENT_KIND_RULES}
                typed={typedFor(sp, DOCUMENT_KIND_EDIT, k.id, actor.personId)}
                extra={
                  <form action={setKindStatusAction}>
                    <input type="hidden" name="kindId" value={k.id} />
                    <input type="hidden" name="status" value={k.active ? 'retired' : 'active'} />
                    <Button type="submit" variant={k.active ? 'danger' : 'secondary'} icon={null}>
                      {k.active ? 'Retire' : 'Restore'}
                    </Button>
                  </form>
                }
              >
                <Field label="Kind name" rule={DOCUMENT_KIND_RULES.name}>
                  <Input {...nativeAttrs(DOCUMENT_KIND_RULES.name)} defaultValue={k.name} className="w-full" />
                </Field>
              </EditableRecord>
            </div>
          ))}
        </div>
        <CheckedForm rules={DOCUMENT_KIND_RULES} action={createKindAction} className="flex flex-wrap items-end gap-2">
          <Field label="A new kind" rule={DOCUMENT_KIND_RULES.name}>
            <Input {...nativeAttrs(DOCUMENT_KIND_RULES.name)} placeholder="Warning letter" className="w-full" />
          </Field>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </CheckedForm>
      </section>

      <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-medium">Fields you can use in the wording</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {FIELD_DEFS.map((f) => (
            <div key={f.name} className="flex flex-wrap gap-x-2">
              <dt className="font-medium">{f.label}</dt>
              <dd className="text-muted">e.g. {f.sample}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Page>
  );
}

function TemplateCard({ template, versions }: { template: TemplateListItem; versions: Awaited<ReturnType<typeof listDocumentTemplateVersions>> | undefined }) {
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
      <div className="flex flex-wrap items-center gap-3">
        <a href={`/documents/templates/${template.id}`} className={ACTION_LINK}>
          Edit and preview
        </a>
        <form action={retireTemplateAction}>
          <input type="hidden" name="templateId" value={template.id} />
          <Button type="submit">Retire</Button>
        </form>
      </div>
      {older.length > 0 && (
        <details className="text-sm">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-neutral-600 dark:text-neutral-400">Earlier versions ({older.length})</summary>
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
