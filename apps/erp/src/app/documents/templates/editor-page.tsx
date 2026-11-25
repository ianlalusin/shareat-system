import { documentIssueOptions, listDocumentKinds, listDocumentTemplates, SLOT_WORDS } from '@shareat/domain';
import { defaultLetterheadDoc, emptyDoc, type DocJson } from '@shareat/domain/documents/doc';
import { SIGNATURE_SLOTS } from '@shareat/db/schema';
import type { Actor } from '@shareat/auth';
import type { ReactNode } from 'react';
import { withOrgPrincipal } from '../lib';
import { previewValuesAction, saveTemplateAction } from './actions';
import { Page } from '@/components/shell/Page';
import { TemplateEditor } from '@/components/documents/TemplateEditor';

/**
 * What the template editor screen shows, shared by `/documents/templates/new` and `/documents/templates/[id]` (T-637). Reads the kinds, the template's latest version and the staff to preview with;
 * the page that calls this has already passed `requirePageAccess` on its own path, and every domain read authorizes again. The page wraps the result in `<Page title description>`
 * (so every route renders the one page container); `null` means the template does not exist or is retired, and the page shows `TemplateNotFound`.
 */
export async function templateEditorView(actor: Actor, templateId?: string): Promise<{ title: string; description: ReactNode; editor: ReactNode } | null> {
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
  if (templateId && (!template || template.retired)) return null;

  const latest = template?.latest;
  const body: DocJson = latest?.doc ?? emptyDoc();
  // A new template, and an old one opened for the first time, start with the company and store lines at the top (what the old print drew).
  const header: DocJson | null = latest && !latest.legacy ? latest.headerDoc : defaultLetterheadDoc();
  const usable = kinds.filter((k) => k.active || k.id === template?.kindId);
  return {
    title: template ? template.name : 'New template',
    description: (
      <>
        {template ? `Version ${template.latest.versionNo} is shown. Saving makes a new version; documents already issued keep the wording they were written from.` : 'Write the wording, set the page, check the preview, then save.'}
        {latest?.legacy ? ' This template was written before the editor: its wording is shown as it was, and the letterhead lines it used to print are offered as the header.' : ''}
      </>
    ),
    editor: (
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
    ),
  };
}

export function TemplateNotFound() {
  return (
    <Page density="table" title="Template not found" description="That template does not exist, or it is retired and can no longer be changed. Make a new template instead.">
      <a href="/documents/templates" className="inline-flex min-h-11 items-center text-sm underline">
        Back to templates
      </a>
    </Page>
  );
}
