import Link from 'next/link';
import { notFound } from 'next/navigation';
import { documentPrintData, SLOT_WORDS } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../../lib/page-access';
import { DocumentBody } from '../../DocumentBody';
import { withOrgPrincipal } from '../../lib';
import { ACTION_LINK } from '@/components/action-link';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Document — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/documents/[id]/print`. T-584 S3.
 *
 * The A4 page: the company's registered name and TIN, the store's address and branch code (all from the database) as the letterhead, the document number
 * and version, the wording, and a place for each signature (the signed image, or a blank line under the name). "Save as PDF" is the browser's own: nothing
 * renders on the server. A void document prints VOID across it. `?v=2` prints an earlier version as it was, with the signatures it had.
 *
 * Needs `view_documents` at the document's store, read at the route and again in the domain.
 */
export default async function DocumentPrintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const { id } = await params;
  const { v } = await searchParams;
  const { actor, refusal } = await requirePageAccess(`/documents/${id}/print`);
  if (refusal) return refusal;
  if (!UUID.test(id)) notFound();
  const wanted = v && /^[0-9]{1,4}$/.test(v) ? Number(v) : undefined;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    try {
      return await documentPrintData(tx, actor, id, wanted);
    } catch (err) {
      // A permission refusal and a missing document read the same: the framework's 404, so a guessed id learns nothing.
      if (err instanceof Error && (err.name === 'AuthorizationError' || err.name === 'RefusalError')) return null;
      throw err;
    }
  });
  if (!data) notFound();

  const lh = data.letterhead;
  return (
    <Page density="table">
      <style>{`
        @media print {
          nav, header, aside, footer, .no-print { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          @page { size: A4; margin: 18mm; }
        }
      `}</style>

      <div className="no-print">
        <Link href={`/documents/${id}`} className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}>
          ← Back to the document
        </Link>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Print this page (Ctrl+P), or choose Save as PDF in the print window. Navigation is hidden on paper.</p>
        {!data.isCurrent && <p className="mt-1 text-sm font-medium">This is version {data.versionNo}, an earlier version. A newer version exists.</p>}
      </div>

      <article className="relative space-y-6 text-sm text-black">
        {data.voided && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="-rotate-12 select-none text-8xl font-black tracking-widest text-red-600 opacity-20">VOID</span>
          </div>
        )}
        <header className="border-b border-neutral-400 pb-3 text-center">
          <p className="text-lg font-semibold">{lh.legalName ?? lh.tradingName}</p>
          {lh.tin && (
            <p>
              TIN {lh.tin}
              {lh.tinBranchCode ? `-${lh.tinBranchCode}` : ''}
            </p>
          )}
          {lh.storeName && <p>{lh.storeName}</p>}
          {lh.storeAddress && <p>{lh.storeAddress}</p>}
        </header>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono font-medium">{data.number}</p>
          <p className="text-neutral-700">
            Version {data.versionNo} of {data.number}
            {data.voided ? ' · VOID' : ''}
          </p>
        </div>
        {data.voided && <p className="font-semibold">VOID{data.voidReason ? `: ${data.voidReason}` : ''}</p>}

        <DocumentBody body={data.body} className="leading-relaxed" />

        {data.slots.length > 0 && (
          <div className="grid gap-10 pt-8 sm:grid-cols-2">
            {data.slots.map((s) => (
              <div key={s.slot} className="break-inside-avoid">
                <div className="flex h-20 items-end border-b border-black">
                  {s.signatureId && (
                    // eslint-disable-next-line @next/next/no-img-element -- the image comes through a gated route; a plain GET is what the printer needs
                    <img src={`/documents/signature/${s.signatureId}`} alt={`Signature of ${s.name ?? SLOT_WORDS[s.slot]}`} className="max-h-20 max-w-full object-contain" />
                  )}
                </div>
                <p className="mt-1 font-medium">{s.name ?? ''}</p>
                <p className="text-xs text-neutral-700">
                  {SLOT_WORDS[s.slot]}
                  {s.signedAt ? ` · signed ${formatBusinessDateTime(s.signedAt)}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </article>
    </Page>
  );
}
