import { requirePageAccess } from '../../../../lib/page-access';
import { templateEditorView } from '../editor-page';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'New template — Shareat System' };
export const dynamic = 'force-dynamic';

/** `/documents/templates/new`. T-637. The document editor for a new template. Admin only (`manage_document_templates`, inherited by the route rule). */
export default async function NewTemplatePage() {
  const { actor, refusal } = await requirePageAccess('/documents/templates/new');
  if (refusal) return refusal;
  const view = (await templateEditorView(actor))!; // a new template always has a view
  return (
    <Page density="table" className="space-y-6" title={view.title} description={view.description}>
      {view.editor}
    </Page>
  );
}
