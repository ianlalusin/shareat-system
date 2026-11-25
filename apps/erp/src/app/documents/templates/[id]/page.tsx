import { requirePageAccess } from '../../../../lib/page-access';
import { TemplateEditorScreen } from '../editor-page';

export const metadata = { title: 'Edit template — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/documents/templates/[id]`. T-637. The document editor for an existing template: saving writes the next version. Admin only. */
export default async function EditTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, refusal } = await requirePageAccess(`/documents/templates/${id}`);
  if (refusal) return refusal;
  return <TemplateEditorScreen actor={actor} {...(UUID.test(id) ? { templateId: id } : { templateId: '00000000-0000-0000-0000-000000000000' })} />;
}
