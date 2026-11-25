import { documentDraft, documentIssueOptions, SLOT_WORDS } from '@shareat/domain';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor } from '../../../lib/keep-typing';
import { withOrgPrincipal } from '../lib';
import { issueDocumentAction } from '../actions';
import { DOCUMENT_ISSUE } from '../typed-forms';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Banner, Button, EmptyState, Field, FlashBanner, Select } from '@/components/ui';
import { WordingField } from '@/components/documents/WordingField';
import { validateDoc, type DocJson } from '@shareat/domain/documents/doc';

export const metadata = { title: 'Issue a document — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrUndefined = (v: string | undefined): string | undefined => (v && UUID.test(v) ? v : undefined);

/**
 * `/documents/new`. T-584 S3.
 *
 * Step 1: pick a template and the employee (or, for a general memo, a store). Step 2: the wording appears with every field filled in from the records; the
 * issuer may edit it, and a gap that could not be filled reads `[missing: …]` and must be filled in or taken out before the document can be issued.
 * Issuing freezes the wording as version 1 and gives it a number. Needs `issue_documents` at the employee's store.
 */
export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; template?: string; employmentId?: string; store?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/documents/new');
  if (refusal) return refusal;

  const templateId = uuidOrUndefined(sp.template);
  const employmentId = uuidOrUndefined(sp.employmentId);
  const storeId = uuidOrUndefined(sp.store);

  const { options, draft, draftError } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const options = await documentIssueOptions(tx, actor);
    if (!templateId) return { options, draft: null, draftError: null as string | null };
    try {
      return { options, draft: await documentDraft(tx, actor, { templateId, employmentId: employmentId ?? null, storeId: storeId ?? null }), draftError: null };
    } catch (err) {
      return { options, draft: null, draftError: err instanceof Error ? ((err as { userMessage?: string }).userMessage ?? err.message) : 'This draft could not be made.' };
    }
  });
  const typed = templateId ? typedFor(sp, DOCUMENT_ISSUE, templateId, actor.personId) : null;
  // After a refused issue the editor opens with what was typed (if it was small enough to keep), else with the filled draft.
  const typedDoc = typed?.kind === 'typed' && typeof typed.fields.bodyDoc === 'string' ? safeDoc(typed.fields.bodyDoc) : null;
  const startDoc: DocJson | null = typedDoc ?? draft?.doc ?? null;
  const employee = options.employments.find((e) => e.id === (draft?.employmentId ?? employmentId));

  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Issue a document</h1>
        <PageDescription>Pick the template and who it is for. The wording is filled in from the records and you can change it before it is issued.</PageDescription>
      </div>

      <FlashBanner flash={sp} />
      {draftError && <Banner tone="error">{draftError}</Banner>}

      {options.templates.length === 0 ? (
        <EmptyState illustration="magnifier" title="No templates yet" body="An administrator writes the templates first, under Documents, Templates." />
      ) : (
        <FilterRow submitLabel="Fill it in">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Template</span>
            <Select name="template" defaultValue={templateId ?? ''}>
              {templateId ? null : <option value="">Pick a template</option>}
              {options.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.kindName})
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Employee</span>
            <Select name="employmentId" defaultValue={employmentId ?? ''}>
              <option value="">No employee: a general memo</option>
              {options.employments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayName} · {e.staffCode} · {e.storeName}
                  {e.ended ? ' (left)' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Store, for a general memo</span>
            <Select name="store" defaultValue={storeId ?? ''}>
              {options.canIssueOrgWide ? <option value="">Whole company</option> : <option value="">Pick a store</option>}
              {options.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
        </FilterRow>
      )}

      {draft && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="space-y-1 text-sm">
            <h2 className="text-lg font-semibold">{draft.template.name}</h2>
            <p className="text-muted">
              {draft.template.kindName} · template version {draft.template.versionNo} · for {employee ? `${employee.displayName} (${employee.staffCode}, ${employee.storeName})` : 'no one in particular'}
            </p>
            <p className="text-muted">
              Signatures needed:{' '}
              {draft.template.signatureSlots.length === 0 ? 'none' : draft.template.signatureSlots.map((s) => SLOT_WORDS[s]).join(' and ')}. Each is added with the signer&apos;s own Employee ID and
              PIN after the document is issued.
            </p>
          </div>
          {draft.missing.length > 0 && (
            <Banner tone="warning">
              Some fields could not be filled in from the records: {draft.missing.join(', ')}. They show as [missing: …] below. Type the value in, or delete the sentence, before issuing.
            </Banner>
          )}
          <form action={issueDocumentAction} className="space-y-4 text-sm">
            <input type="hidden" name="templateId" value={draft.template.id} />
            {draft.employmentId && <input type="hidden" name="employmentId" value={draft.employmentId} />}
            {draft.storeId && !draft.employmentId && <input type="hidden" name="storeId" value={draft.storeId} />}
            <Field label="Wording" span="full" hint="Change anything the document should say differently. Format it with the toolbar.">
              {startDoc && <WordingField name="bodyDoc" label="Wording" initialDoc={startDoc} />}
            </Field>
            <Button type="submit" variant="primary">
              Issue
            </Button>
          </form>
        </section>
      )}
    </Page>
  );
}

function safeDoc(raw: string): DocJson | null {
  try {
    const c = validateDoc(JSON.parse(raw));
    return c.ok ? c.doc : null;
  } catch {
    return null;
  }
}
