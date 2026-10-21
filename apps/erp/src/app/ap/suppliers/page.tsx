import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import {
  CLASSIFICATION_LABEL,
  listSuppliersWithPosition,
  maskAccountNumber,
  matchesSupplier,
  peso,
  VAT_STATUS_LABEL,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, FlashBanner, Input, LinkRow, RowLink } from '@/components/ui';

export const metadata = { title: 'Suppliers — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  q?: string;
  show?: string;
  ok?: string;
  error?: string;
}

/**
 * The supplier register. T-188 §6.
 *
 * ⛔ **This route did not exist until 2026-08-30**, while the main nav linked to it — two entries
 * pointing at 404s (DEF-107). Only `[id]` detail pages had ever been built.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/ap/suppliers');

  const all = await listSuppliersWithPosition(actor.orgId);
  const q = sp.q ?? '';
  const includeInactive = sp.show === 'all';

  const rows = all
    .filter((s) => (includeInactive ? true : s.status === 'active'))
    .filter((s) => matchesSupplier(s, q));

  const inactiveCount = all.filter((s) => s.status !== 'active').length;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Suppliers</h1>
        <PageDescription>
          The register, org-wide. ⭐ One row per supplier — not one per store. v1 keyed suppliers
          under each branch, so a fleet-wide vendor became <strong>up to twenty</strong> separate
          records that each had to be edited, reconciled and paid.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1 erp-field-long w-full">
          <span className={LABEL}>Search</span>
          <Input name="q" defaultValue={q} placeholder="Name, TIN, contact, bank…" className="w-full" />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" name="show" value="all" defaultChecked={includeInactive} />
          Include inactive ({inactiveCount})
        </label>
        <Button type="submit" variant="primary">
          Search
        </Button>
        <Link href="/ap" className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas">
          Add a supplier
        </Link>
      </form>

      <p className="text-xs text-neutral-500">
        {rows.length} of {all.length} shown
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {q ? `Nothing matches “${q}”.` : 'No suppliers yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[58rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3 font-medium">Supplier</th>
                <th className="py-2 pr-3 font-medium">TIN</th>
                <th className="py-2 pr-3 font-medium">VAT</th>
                <th className="py-2 pr-3 font-medium">OR</th>
                <th className="py-2 pr-3 font-medium">Terms</th>
                <th className="py-2 pr-3 font-medium">Bank</th>
                <th className="py-2 pr-3 text-right font-medium">Payable</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <LinkRow key={s.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-2 pr-3">
                    <RowLink href={`/ap/suppliers/${s.id}`} className="font-medium">
                      {s.name}
                    </RowLink>
                    <div className="text-xs text-neutral-500">
                      {s.classification && (
                        <span className="mr-2">{CLASSIFICATION_LABEL[s.classification]}</span>
                      )}
                      {s.representativeName && <span className="mr-2">{s.representativeName}</span>}
                      {s.status !== 'active' && (
                        <Badge status={s.status} />
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{s.tin ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs">
                    {s.vatStatus ? (VAT_STATUS_LABEL[s.vatStatus] ?? s.vatStatus) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {/* ⭐ The one ported field that does work: it defaults the document type. */}
                    {s.issuesOfficialReceipt ? 'Official receipt' : 'No OR'}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {/* T-362 / DEF-495 — === null, never truthiness: 0 days is credit (R1). */}
                    {s.creditTermsDays === null ? 'Cash on delivery' : `${s.creditTermsDays} days`}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {/* ⚠️ Masked on a list, whole on the detail page. */}
                    {s.bankAccountNumber
                      ? `${s.bankName ?? ''} ${maskAccountNumber(s.bankAccountNumber)}`.trim()
                      : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {peso(Number(s.controlBalance))}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
