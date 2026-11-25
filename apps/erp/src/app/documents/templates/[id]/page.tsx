import { requirePageAccess } from '../../../../lib/page-access';
import { TemplateNotFound, templateEditorView } from '../editor-view';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Edit template — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/documents/templates/[id]`. T-637. The document editor for an existing template: saving writes the next version. Admin only. */
export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, refusal } = await requirePageAccess(`/documents/templates/${id}`);
  if (refusal) return refusal;
  const view = UUID.test(id) ? await templateEditorView(actor, id) : null;
  if (!view) return <TemplateNotFound />;
  return (
    <Page density="table" className="space-y-6" title={view.title} description={view.description}>
      {view.editor}
    </Page>
  );
}
