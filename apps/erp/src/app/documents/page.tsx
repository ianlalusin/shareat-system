import { heldCapabilities } from '@shareat/auth';
import { listIssuedDocuments, documentKindOptions } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../lib/page-access';
import { withFlash } from '../../lib/flash';
import { heldStoresFor } from '../../lib/held-stores';
import { withOrgPrincipal } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { ACTION_LINK } from '@/components/action-link';
import { Badge, EmptyState, FlashBanner, LinkRow, RowLink, Select, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Documents — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/documents`. T-584 S3.
 *
 * Every document issued for the staff of the stores you may read, newest first, with its number, who it is for and where it stands. A void document
 * stays in the list, marked void. Open one to sign it, change it (a new version), print it, or void it. Needs `view_documents`; the list holds only the
 * stores where you hold it.
 */
export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; store?: string; kind?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/documents');
  if (refusal) return refusal;

  const storeFilter = sp.store && UUID.test(sp.store) ? sp.store : undefined;
  const { rows, stores, held, kinds, kindFilter } = await withOrgPrincipal(actor.orgId, async (tx) => {
    // The kinds are the organisation's own list (T-637); a filter value that is not one of them is ignored.
    const kinds = await documentKindOptions(tx, actor);
    const kindFilter = kinds.find((k) => k.id === sp.kind)?.id;
    return {
      kinds,
      kindFilter,
      rows: await listIssuedDocuments(tx, actor, { ...(storeFilter ? { storeId: storeFilter } : {}), ...(kindFilter ? { kindId: kindFilter } : {}) }),
      stores: await heldStoresFor(tx, actor, ['view_documents']),
      held: await heldCapabilities(tx, actor),
    };
  });
  const canIssue = held.has('issue_documents');
  const canTemplate = held.has('manage_document_templates');

  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Documents</h1>
        <PageDescription>
          Certificates, memos, notices, letters and contracts issued for staff. Each has a number, is kept, and can be printed again at any time.
        </PageDescription>
        <p className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {canIssue && (
            <a href="/documents/new" className={ACTION_LINK}>
              Issue a document
            </a>
          )}
          {canTemplate && (
            <a href="/documents/templates" className={ACTION_LINK}>
              Templates
            </a>
          )}
        </p>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Store</span>
          <Select name="store" defaultValue={storeFilter ?? ''}>
            <option value="">All my stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Kind</span>
          <Select name="kind" defaultValue={kindFilter ?? ''}>
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
                {k.active ? '' : ' (retired)'}
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {rows.length === 0 ? (
        <EmptyState illustration="magnifier" title="No documents yet" body={canIssue ? 'Issue the first one with “Issue a document”.' : 'Nothing has been issued for your stores.'} />
      ) : (
        <Table label="Issued documents" card={{ title: 'Document', subtitle: 'For', keys: ['Store', 'Issued', 'Version', 'Status'] }}>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Document</Th>
              <Th>For</Th>
              <Th>Store</Th>
              <Th>Issued</Th>
              <Th>Version</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <LinkRow key={d.id} className={d.voided ? 'opacity-60' : undefined}>
                <Td>
                  <RowLink href={`/documents/${d.id}`}>{d.number}</RowLink>
                </Td>
                <Td>
                  {d.templateName}
                  <div className="text-xs text-muted">{d.kindName}</div>
                </Td>
                <Td>{d.employeeName ?? '—'}</Td>
                <Td>{d.storeName ?? 'Whole company'}</Td>
                <Td className="text-xs">
                  {formatBusinessDateTime(d.issuedAt, { dateStyle: 'medium' })}
                  <div className="text-muted">{d.issuedByName}</div>
                </Td>
                <Td className="tabular-nums">{d.currentVersionNo}</Td>
                <Td className="text-xs">
                  {d.voided ? (
                    <Badge tone="danger" label="VOID" />
                  ) : d.signatureSlots.length === 0 ? (
                    <span className="text-muted">No signatures needed</span>
                  ) : (
                    <Badge tone={d.signedOnCurrent >= d.signatureSlots.length ? 'success' : 'warning'} label={`${d.signedOnCurrent} of ${d.signatureSlots.length} signed`} />
                  )}
                </Td>
              </LinkRow>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
