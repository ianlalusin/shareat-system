import { compare, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../lib/page-access';
import { distributeAction } from './actions';
import { floatBalance, listStores, moneyAccounts, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Service charge — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

export default async function ServiceChargePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/service-charge');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">Service charge</h1>
        <PageDescription>No stores yet.</PageDescription>
      </Page>
    );
  }

  const [balance, accounts] = await Promise.all([
    floatBalance(actor.orgId, storeId),
    moneyAccounts(actor.orgId, storeId),
  ]);
  const store = stores.find((s) => s.id === storeId);
  // ⛔ T-371 R4/C4 — the ledger figure re-minted and ordered exactly, never as a float.
  const hasFloat = compare(money(balance), ZERO) > 0;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Service charge</h1>
        <PageDescription>
          RA 11360 sends 100% of the service charge to rank-and-file staff, at least twice a
          month. This records that the float was discharged and by how much.{' '}
          <strong>ERP does not know the split, who is eligible, or the odd centavo</strong> — the
          business processes and documents that by hand.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </div>
      )}

      {/* ── Store picker ─────────────────────────────────────────────────────────────── */}
      {stores.length > 1 && (
        <form className="flex flex-wrap items-end gap-2 gap-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Store
            </span>
            <select name="store" defaultValue={storeId} className={INPUT}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Show
          </button>
        </form>
      )}

      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {store?.name ?? 'This store'}&apos;s service charge float — held for staff
        </div>
        <div className="font-mono text-lg font-medium tabular-nums">{peso(balance)}</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
          ⭐ Derived from the ledger — `2160`, credits minus debits, this store only. A store may
          never spend another store&apos;s float.
        </p>
      </div>

      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Distribute</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {hasFloat
              ? "Pay only what is available. A distribution exceeding this store's own float is refused, never negative."
              : 'Nothing is held for this store yet.'}
          </p>
        </div>
        {hasFloat && (
          <form action={distributeAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <Field label="Amount" hint={`Up to ${peso(balance)} available.`}>
              <input
                name="amount"
                required
                inputMode="decimal"
                className={INPUT}
              />
            </Field>
            <Field label="From" hint="Balances shown are derived from the ledger.">
              <select name="moneyAccountId" required defaultValue="" className={INPUT}>
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {peso(a.balance)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payday">
              <input name="paidOn" type="date" required defaultValue={today()} className={INPUT} />
            </Field>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Distribute
            </button>
          </form>
        )}
      </section>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
