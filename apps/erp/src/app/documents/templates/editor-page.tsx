import { documentIssueOptions, listDocumentKinds, listDocumentTemplates, SLOT_WORDS } from '@shareat/domain';
import { defaultLetterheadDoc, emptyDoc, type DocJson } from '@shareat/domain/documents/doc';
import { SIGNATURE_SLOTS } from '@shareat/db/schema';
import type { Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../lib';
import { previewValuesAction, saveTemplateAction } from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { TemplateEditor } from '@/components/documents/TemplateEditor';

/**
 * The template editor screen, shared by `/documents/templates/new` and `/documents/templates/[id]` (T-637). Reads the kinds, the template's latest version and the staff to preview with;
 * the page that calls this has already passed `requirePageAccess` on its own path, and every domain read authorizes again.
 */
export async function TemplateEditorScreen({ actor, templateId }: { actor: Actor; templateId?: string }) {
  const { kinds, template, employees } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const kinds = await listDocumentKinds(tx, actor);
    const template = templateId ? ((await listDocumentTemplates(tx, actor)).find((t) => t.id === templateId) ?? null) : null;
    // The preview can fill in a real employee; a person who cannot issue anywhere simply gets the sample values.
    const employees = await documentIssueOptions(tx, actor).then(
      (o) => o.employments.slice(0, 400).map((e) => ({ id: e.id, label: `${e.displayName} · ${e.staffCode} · ${e.storeName}${e.ended ? ' (left)' : ''}` })),
      () => [] as Array<{ id: string; label: string }>,
    );
    return { kinds, template, employees };
  });
  if (templateId && (!template || template.retired)) return <NotFound />;

  const latest = template?.latest;
  const body: DocJson = latest?.doc ?? emptyDoc();
  // A new template, and an old one opened for the first time, start with the company and store lines at the top (what the old print drew).
  const header: DocJson | null = latest && !latest.legacy ? latest.headerDoc : defaultLetterheadDoc();
  const usable = kinds.filter((k) => k.active || k.id === template?.kindId);
  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{template ? template.name : 'New template'}</h1>
        <PageDescription>
          {template ? `Version ${template.latest.versionNo} is shown. Saving makes a new version; documents already issued keep the wording they were written from.` : 'Write the wording, set the page, check the preview, then save.'}
          {latest?.legacy ? ' This template was written before the editor: its wording is shown as it was, and the letterhead lines it used to print are offered as the header.' : ''}
        </PageDescription>
      </div>
      <TemplateEditor
        {...(template ? { templateId: template.id } : {})}
        initial={{
          name: template?.name ?? '',
          kindId: template?.kindId ?? usable[0]?.id ?? '',
          slots: latest?.signatureSlots ?? [...SIGNATURE_SLOTS],
          margins: latest?.margins ?? 'normal',
          body,
          header,
          footer: latest && !latest.legacy ? latest.footerDoc : null,
        }}
        kinds={usable.map((k) => ({ id: k.id, name: k.name }))}
        slots={SIGNATURE_SLOTS.map((s) => ({ value: s, label: SLOT_WORDS[s] }))}
        employees={employees}
        save={saveTemplateAction}
        previewValues={previewValuesAction}
      />
    </Page>
  );
}

function NotFound() {
  return (
    <Page density="table">
      <h1 className="text-2xl font-semibold">Template not found</h1>
      <p className="mt-2 text-sm text-muted">That template does not exist, or it is retired and can no longer be changed. Make a new template instead.</p>
      <a href="/documents/templates" className="mt-3 inline-flex min-h-11 items-center text-sm underline">
        Back to templates
      </a>
    </Page>
  );
}
