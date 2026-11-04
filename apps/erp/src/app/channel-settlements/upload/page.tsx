import { requirePageAccess } from '../../../lib/page-access';
import { Page } from '@/components/shell/Page';
import { Table, Td, Th } from '@/components/ui';
import { UploadForm } from './UploadForm';
import { listWaitingForFile } from './lib';

export const metadata = { title: 'Upload settlement files — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-511 S4 - the minimal upload screen: drop the Grab and Foodpanda files, see what each became. Nothing is booked here; the review screen comes in a
 * later slice. The route is gated by `upload_settlement_files` (ROUTE_CAPABILITY); the domain gates the upload again at the store the file belongs to.
 */
export default async function UploadSettlementFilesPage() {
  const { actor, refusal } = await requirePageAccess('/channel-settlements/upload');
  if (refusal) return refusal;
  const waiting = await listWaitingForFile(actor);

  return (
    <Page
      density="table"
      title="Upload settlement files"
      description={
        'Drop the Grab CSV files (Transactions and Transfers) and the Foodpanda invoice zips you downloaded. ' +
        'Each file is read and kept as it came; nothing is booked yet. A Grab payout appears once both of its files are in.'
      }
    >
      <UploadForm />
      <section className="space-y-2" aria-label="Days still waiting for a file">
        <h2 className="text-lg font-semibold">Days with sales and no file yet</h2>
        {waiting.length === 0 ? (
          <p className="text-sm">Every verified day with sales already has a staged file line.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Store</Th>
                <Th>Channel</Th>
                <Th>Days</Th>
                <Th>Oldest</Th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((w) => (
                <tr key={w.channelId} className="border-t border-surface-border">
                  <Td>{w.storeName}</Td>
                  <Td>{w.channelName}</Td>
                  <Td>{w.days.length}</Td>
                  <Td>{w.days[0]}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </Page>
  );
}
