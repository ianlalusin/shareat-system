import { compare, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../lib/page-access';
import { distributeAction } from './actions';
import { floatBalance, listStores, moneyAccounts, peso, today } from './lib';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { SERVICE_CHARGE_DISTRIBUTE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, Select, FormModal } from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';

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

      <FlashBanner flash={sp} />

      {/* ── Store picker ─────────────────────────────────────────────────────────────── */}
      {stores.length > 1 && (
        <form className="flex flex-wrap items-end gap-2 gap-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Store
            </span>
            <Select name="store" defaultValue={storeId} className="w-full">
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit">Show</Button>
        </form>
      )}

      <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="text-xs text-neutral-500 dark:text-neutral-400">
          {store?.name ?? 'This store'}&apos;s service charge float — held for staff
        </div>
        <div className="font-mono text-lg font-medium tabular-nums">{peso(balance)}</div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
          ⭐ Derived from the ledger — the service charge float, credits minus debits, this store only. A store may
          never spend another store&apos;s float.
        </p>
      </div>

      <div className="flex justify-end">
        {!hasFloat && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing is held for this store yet.</p>
        )}
        {hasFloat && (
          <FormModal
            trigger="Distribute"
            title="Distribute"
            size="md"
            description="Pay only what is available. A distribution exceeding this store's own float is refused, never negative."
          >
          <CheckedForm rules={SERVICE_CHARGE_DISTRIBUTE_RULES} action={distributeAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <Field label="Amount" hint={`Up to ${peso(balance)} available.`} rule={SERVICE_CHARGE_DISTRIBUTE_RULES.amount}>
              <input
                {...nativeAttrs(SERVICE_CHARGE_DISTRIBUTE_RULES.amount)}
                className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
              />
            </Field>
            <Field label="From" hint="Balances shown are derived from the ledger." rule={SERVICE_CHARGE_DISTRIBUTE_RULES.moneyAccountId}>
              <Select {...nativeAttrs(SERVICE_CHARGE_DISTRIBUTE_RULES.moneyAccountId)} defaultValue="" className="w-full">
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {peso(a.balance)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payday" rule={SERVICE_CHARGE_DISTRIBUTE_RULES.paidOn}>
              <Input {...nativeAttrs(SERVICE_CHARGE_DISTRIBUTE_RULES.paidOn)} type="date" defaultValue={today()} className="w-full" />
            </Field>
            <SubmitButton pendingLabel="Saving…">Distribute</SubmitButton>
          </CheckedForm>
          </FormModal>
        )}
      </div>
    </Page>
  );
}

function Field({ label, hint, rule, className, children }: { label: React.ReactNode; hint?: string; rule?: FieldRule; className?: string; children: React.ReactNode }) {
  const body = (
    <>      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    
    </>
  );
  // T-440: a ruled field keeps its label and puts the live helper line OUTSIDE it (never part of the accessible name).
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div className={className}>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}
