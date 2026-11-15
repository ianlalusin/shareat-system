import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RefusalError } from '@shareat/db';
import type { PreflightItem } from '@shareat/domain';
import { requirePageAccess } from '../../../../../lib/page-access';
import { posPreflightFor, storeDetail } from '../../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner } from '@/components/ui';

export const metadata = { title: 'POS pre-flight — Shareat System' };
export const dynamic = 'force-dynamic';

function Items({ items }: { items: PreflightItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.code} className="text-sm">
          <div>{i.sentence}</div>
          {i.href && (
            <Link href={i.href} className="inline-flex min-h-11 items-center text-sm underline underline-offset-2">
              Fix this →
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * T-533 S3 — what is still missing before this store may be switched on for the new POS. Admin only: the same gate as `/admin/stores`.
 * A read: the list is worked out fresh on every visit and nothing about it is stored. Blocking items stop the switch to live; warnings do not.
 */
export default async function PosPreflightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, refusal } = await requirePageAccess(`/admin/stores/${id}/pos-preflight`);
  if (refusal) return refusal;
  const detail = await storeDetail(actor, id);
  if (!detail) notFound();
  const result = await posPreflightFor(actor, id).catch((e: unknown) => {
    if (e instanceof RefusalError) notFound(); // a store of another organisation reads as not found
    throw e;
  });
  const { store } = detail;

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href={`/admin/stores/${id}`} className="inline-flex min-h-11 items-center text-sm underline underline-offset-2">
          ← {store.code} — {store.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">POS pre-flight</h1>
        <PageDescription>What this store still needs before it is switched on for the new POS.</PageDescription>
      </div>

      {result.blocking.length === 0 ? (
        <Banner tone="success">Nothing blocks the switch for this store.</Banner>
      ) : (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">
            {result.blocking.length} thing{result.blocking.length === 1 ? '' : 's'} must be fixed before the switch to live
          </h2>
          <Items items={result.blocking} />
        </section>
      )}

      {result.warnings.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">
            {result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'} (these do not stop the switch)
          </h2>
          <Items items={result.warnings} />
        </section>
      )}
    </Page>
  );
}
