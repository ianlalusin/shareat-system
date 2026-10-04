import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { refusalCounts } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Prerequisite walls — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-245 — the number that decides which of 58 features get a tutorial first.
 * docs/tasks/245-prerequisite-refusal-counter.md §4.
 *
 * Read-only, no workflow: unlike `/findings`, a refusal is not a defect to clear — it is a fact
 * about how a feature gets used, and this page exists to be looked at, not acted on. Slice 1 wires
 * exactly two `reasonCode`s (both in `attendance/credentials.ts`); the rest of the 130 sites are
 * slice 2.
 */
export default async function PrerequisiteRefusalsPage() {
  const { actor } = await requireSession('/admin/prerequisite-refusals');
  const rows = await refusalCounts(actor.orgId);

  return (
    <Page
      density="table"
      title="Prerequisite walls"
      description={
        'How often anyone has hit an order-of-operations wall, by reason. Run this for a month ' +
        'and the count ranks which features need a tutorial first — nobody has to guess.'
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No refusals recorded yet at this organisation.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
                <th className="py-2 pr-4 font-medium">Reason code</th>
                <th className="py-2 pr-4 font-medium">Domain</th>
                <th className="py-2 pr-4 font-medium">Count</th>
                <th className="py-2 pr-4 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reasonCode} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="py-2 pr-4 font-mono text-xs">{r.reasonCode}</td>
                  <td className="py-2 pr-4">{r.domain}</td>
                  <td className="py-2 pr-4">{r.count}</td>
                  <td className="py-2 pr-4">{toBusinessDate(r.lastOccurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
