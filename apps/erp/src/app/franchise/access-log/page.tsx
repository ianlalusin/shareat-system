import { listFranchiseAccessLog } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withActorPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { NumTd, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Who looked at our data — Shareat System' };
export const dynamic = 'force-dynamic';

const KINDS = {
  sales_daily: 'Sales looked at',
  stock_levels: 'Stock looked at',
  break_glass_sign_in: 'Signed in',
  break_glass_approval: 'Approved with PIN',
} as const;
type Kind = keyof typeof KINDS;
const isKind = (v: string | undefined): v is Kind => v !== undefined && Object.prototype.hasOwnProperty.call(KINDS, v);
const LINK = 'inline-flex min-h-6 items-center underline underline-offset-4';

export default async function FranchiseAccessLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/franchise/access-log');
  if (refusal) return refusal;

  const raw = Array.isArray(sp.what) ? sp.what[0] : sp.what;
  const what = isKind(raw) ? raw : undefined;
  const rows = await withActorPrincipal(actor.orgId, actor.personId, (tx) => listFranchiseAccessLog(tx, actor, { what, limit: 200 }));

  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Who looked at our data</h1>
        <PageDescription className="mt-1">
          Every time the company that licenses your franchise looks at your sales or stock, or signs in or approves something with a PIN inside your system, it is listed
          here with who it was, when, and the reason they gave. Newest first.
        </PageDescription>
      </div>
      <p className="flex flex-wrap gap-4 text-sm">
        <a href="/franchise/access-log" className={LINK}>
          All
        </a>
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <a key={k} href={`/franchise/access-log?what=${k}`} className={LINK}>
            {KINDS[k]}
          </a>
        ))}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody has looked yet.</p>
      ) : (
        <Table card={{ title: 'What', subtitle: 'Who', keys: ['When', 'Reason'] }}>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>Details</Th>
              <Th numeric>Rows seen</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{formatBusinessDateTime(r.occurredAt)}</Td>
                <Td>{r.personName}</Td>
                <Td>{KINDS[r.what]}</Td>
                <Td>
                  {r.rangeFrom && r.rangeTo ? `${r.rangeFrom} to ${r.rangeTo}` : r.storeId ? 'One store' : r.capability ? r.capability.replace(/_/g, ' ') : r.credentialKind ? `by ${r.credentialKind.toUpperCase()}` : ''}
                </Td>
                <NumTd>{r.rowsReturned ?? ''}</NumTd>
                <Td>{r.reason ?? ''}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
