import type { ReactNode } from 'react';
import { can } from '@shareat/auth';
import { ITEM_IMPORT_MAX_ROWS, type ItemImportPreview } from '@shareat/domain';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../lib';
import { FlashBanner, Banner, Table, Th, Td } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { confirmImportAction, previewImportAction } from './actions';
import { ImportFlow } from './ImportFlow';
import { IMPORT_STATUS_LABELS, safeCell } from './lib';

export const metadata = { title: 'Import items — Shareat System' };
export const dynamic = 'force-dynamic';

const COUNT_ORDER = ['new', 'exists', 'alias_clash', 'category_not_found', 'subcategory_not_found', 'subcategory_required', 'invalid', 'duplicate_in_file'] as const;

/** What the preview says, row by row. Every cell that came from the file goes through `safeCell`. */
function PreviewPanel({ csv, preview }: { csv: string; preview: ItemImportPreview }) {
  const problems = preview.rows.length - preview.counts.new - preview.counts.exists;
  return (
    <section className="space-y-4" aria-label="Preview of the file">
      <p className="text-sm">
        {COUNT_ORDER.filter((s) => preview.counts[s] > 0)
          .map((s) => `${preview.counts[s]} × ${IMPORT_STATUS_LABELS[s]}`)
          .join(' · ') || 'The file has no items.'}
      </p>
      {preview.canConfirm ? (
        <Banner tone="success">Every line is fine. Press Confirm to create the new items. Lines already in the list are skipped.</Banner>
      ) : (
        <Banner tone="error">
          {problems > 0
            ? `${problems} line${problems === 1 ? '' : 's'} need fixing. Nothing is created until the whole file is clean: fix the file and upload it again.`
            : 'There is nothing to import in this file.'}
        </Banner>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Line</Th>
            <Th>Item name</Th>
            <Th>What will happen</Th>
            <Th>Why</Th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r) => (
            <tr key={r.line} className="border-t border-surface-border">
              <Td>{r.line}</Td>
              <Td>{safeCell(r.name)}</Td>
              <Td>{IMPORT_STATUS_LABELS[r.status]}</Td>
              <Td>{r.reason ? safeCell(r.reason) : ''}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {preview.canConfirm && preview.counts.new > 0 && (
        <form action={confirmImportAction}>
          <input type="hidden" name="csv" value={csv} />
          <SubmitButton pendingLabel="Creating…">Confirm and create the items</SubmitButton>
        </form>
      )}
    </section>
  );
}

export default async function ImportItemsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; warning?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/items/import');
  // Presentation only: the domain refuses a non-admin on its own. This keeps the upload box away from people who cannot use it.
  const mayImport = await withOrgPrincipal(actor.orgId, (tx) => can(tx, actor, 'approve_item_request', {}));

  async function check(formData: FormData): Promise<ReactNode> {
    'use server';
    const r = await previewImportAction(formData);
    if (!r.ok) return <Banner tone="error">{r.error}</Banner>;
    return <PreviewPanel csv={r.csv} preview={r.preview} />;
  }

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Import items</h1>
        <PageDescription>
          Upload the reviewed item list as a CSV with the columns item_name, kind, base_unit, expense_category, expense_subcategory and aliases
          (other names separated by |). You see every line checked before anything is created. Up to {ITEM_IMPORT_MAX_ROWS.toLocaleString('en-US')} items per file.
        </PageDescription>
      </div>
      <FlashBanner flash={sp} />
      {mayImport ? <ImportFlow check={check} /> : <Banner tone="info">Only an admin can import items.</Banner>}
    </Page>
  );
}
