import Link from 'next/link';
import { CUSTODIANS, MONEY_INSTRUMENTS } from '@shareat/db';
import { requirePageAccess } from '../../lib/page-access';
import {
  createMoneyAccountAction,
  renameMoneyAccountAction,
  retireMoneyAccountAction,
} from './actions';
import {
  CUSTODIAN_LABEL,
  GL_LABEL,
  INSTRUMENT_LABEL,
  listAll,
  listStores,
} from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Money accounts — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function MoneyAccountsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/money-accounts');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, accounts] = await Promise.all([listStores(actor.orgId), listAll(actor.orgId)]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const active = accounts.filter((a) => a.isActive);
  const retired = accounts.filter((a) => !a.isActive);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Money accounts</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Every place money sits — a drawer, a safe, each e-wallet and bank account — and{' '}
          <strong>who holds it</strong>. Five are marked{' '}
          <em>always present</em>: every store has them from the day it opens and cannot close
          them while it trades — but you can call them whatever you call them here. The books group these by account; you group them by
          custodian. Same ledger, two views.{' '}
          <Link href="/money-transfers" className="underline underline-offset-2">
            Move money between them
          </Link>
          .
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok === 'created'
            ? 'Money account added.'
            : sp.ok === 'renamed'
              ? 'Saved.'
              : 'Money account retired.'}
        </div>
      )}

      {active.length === 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">No money accounts yet.</strong> Until a store has at
          least one, online money cannot be recorded at all — an online payment and a day&apos;s
          online sales both have to say <em>which</em> account they moved.
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {accounts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Held by</th>
                <th className="px-3 py-2 font-medium">Books</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {[...active, ...retired].map((a) => (
                <tr
                  key={a.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    a.isActive ? '' : 'opacity-50'
                  }`}
                >
                  <td className="px-3 py-2">
                    {a.name}
                    {!a.isActive && (
                      <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        Retired
                      </span>
                    )}
                    {a.isFoundation && (
                      <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                        Always present
                      </span>
                    )}
                    {a.notes && (
                      <div className="text-xs text-neutral-400 dark:text-neutral-600">{a.notes}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{storeById.get(a.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2">{INSTRUMENT_LABEL[a.instrument] ?? a.instrument}</td>
                  <td className="px-3 py-2">
                    <CustodianBadge custodian={a.custodian} />
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    <span className="font-mono">{a.glAccountCode}</span>{' '}
                    {GL_LABEL[a.glAccountCode] ?? ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/*
                      ⭐ THE FIVE GET A RENAME, NOT A RETIRE (bible row 156).

                      Ian: "these 5 accounts must always be present and available since they are
                      the foundation of money movement… unretirable but configurable in ui esp
                      name." So the control that exists is the one that is allowed — offering a
                      Retire button that always errors would teach people to distrust buttons.
                    */}
                    {a.isActive && a.isFoundation && (
                      <form action={renameMoneyAccountAction} className="flex justify-end gap-1">
                        <input type="hidden" name="moneyAccountId" value={a.id} />
                        <input
                          name="name"
                          required
                          defaultValue={a.name}
                          maxLength={120}
                          className="w-40 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                        />
                        {/* ⭐ Only a cashier drawer consults this — office and staff balances are
                            complete and block at zero regardless (row 154), so offering the field
                            there would imply an overdraft they do not have. */}
                        {a.custodian === 'cashier' && (
                          <span
                            className="self-center text-xs whitespace-nowrap text-neutral-500 dark:text-neutral-400"
                            title="How far below zero this drawer may go before a draw is refused."
                          >
                            may go to −
                          </span>
                        )}
                        {a.custodian === 'cashier' && (
                          <input
                            name="overdraftLimit"
                            inputMode="decimal"
                            defaultValue={a.overdraftLimit}
                            title="How far below zero this drawer may go before a draw is refused. Entered positive; 0 means never."
                            className="w-24 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                          />
                        )}
                        <button
                          type="submit"
                          className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                        >
                          Rename
                        </button>
                      </form>
                    )}
                    {a.isActive && !a.isFoundation && (
                      <form action={retireMoneyAccountAction}>
                        <input type="hidden" name="moneyAccountId" value={a.id} />
                        <button
                          type="submit"
                          className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                        >
                          Retire
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add one ──────────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Add a money account</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            ⛔ <strong>Admin only.</strong> A money account is an account in the books, not a
            setting — every peso entering it lands on the balance sheet.
          </p>
        </div>

        <form action={createMoneyAccountAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What staff call it — “GCash — cashier”, “BDO — office”">
              <input name="name" required maxLength={120} placeholder="GCash — cashier" className={INPUT} />
            </Field>
            <Field label="Store">
              <select name="storeId" required defaultValue="" className={INPUT}>
                <option value="">Choose a store…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kind">
              <select name="instrument" defaultValue="ewallet" className={INPUT}>
                {MONEY_INSTRUMENTS.map((i) => (
                  <option key={i} value={i}>
                    {INSTRUMENT_LABEL[i] ?? i}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Held by"
              hint="A staff float is per person — the ledger names which one on each line"
            >
              <select name="custodian" defaultValue="cashier" className={INPUT}>
                {CUSTODIANS.map((c) => (
                  <option key={c} value={c}>
                    {CUSTODIAN_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes">
            <input name="notes" className={INPUT} />
          </Field>

          {/* ⭐ No GL-code field, deliberately. The books account is DERIVED from kind + holder —
              putting the chart of accounts in a form is how a typo becomes a wallet that reports
              as cash. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            The books account is chosen for you from the kind and the holder: cash lands in
            1110/1120/1130 by who holds it, and every e-wallet or bank account shares 1140 —
            the line names which one.
          </p>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Add money account
          </button>
        </form>
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
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

function CustodianBadge({ custodian }: { custodian: string }) {
  const cls =
    custodian === 'cashier'
      ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
      : custodian === 'office'
        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {CUSTODIAN_LABEL[custodian] ?? custodian}
    </span>
  );
}
