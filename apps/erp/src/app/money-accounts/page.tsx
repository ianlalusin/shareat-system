import { accountLabel } from '@/lib/account-label';
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
  INSTRUMENT_LABEL,
  listAll,
  listStores,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { MONEY_ACCOUNT_RENAME } from './typed-forms';
import { CheckedForm, EditableRecord, FieldCheck } from '@/components/forms';
import { MONEY_ACCOUNT_CREATE_RULES, MONEY_ACCOUNT_RENAME_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { Banner, ConfirmDestructive, FlashBanner, Input, Select } from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';

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
  const sp = await withFlash(searchParams);
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
        <PageDescription>
          Every place money sits — a drawer, a safe, each e-wallet and bank account — and{' '}
          <strong>who holds it</strong>. Five are marked{' '}
          <em>always present</em>: every store has them from the day it opens and cannot close
          them while it trades — but you can call them whatever you call them here. The books group these by account; you group them by
          custodian. Same ledger, two views.{' '}
          <Link href="/money-transfers" className="underline underline-offset-2">
            Move money between them
          </Link>
          .
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {active.length === 0 && (
        <Banner tone="warning">
          <strong className="font-medium">No money accounts yet.</strong> Until a store has at
          least one, online money cannot be recorded at all — an online payment and a day&apos;s
          online sales both have to say <em>which</em> account they moved.
        </Banner>
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
                      <span className="ml-2 rounded bg-closed-soft px-1.5 py-0.5 text-xs font-medium text-closed">
                        Retired
                      </span>
                    )}
                    {a.isFoundation && (
                      <span className="ml-2 rounded bg-info-soft px-1.5 py-0.5 text-xs font-medium text-info">
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
                    {accountLabel(a.glAccountCode)}
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
                      <EditableRecord action={renameMoneyAccountAction} label={a.name} hidden={{ moneyAccountId: a.id }} typed={typedFor(sp, MONEY_ACCOUNT_RENAME, a.id, actor.personId)} rules={MONEY_ACCOUNT_RENAME_RULES}>
                        <div className="flex flex-wrap justify-end gap-1">
                        <Field label={<span className="sr-only">Account name</span>} rule={MONEY_ACCOUNT_RENAME_RULES.name}>
                          <Input
                            {...nativeAttrs(MONEY_ACCOUNT_RENAME_RULES.name)}
                            defaultValue={a.name}
                            className="w-40 text-xs"
                          />
                        </Field>
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
                          <Field label={<span className="sr-only">Overdraft limit</span>} rule={MONEY_ACCOUNT_RENAME_RULES.overdraftLimit}>
                            <input
                              {...nativeAttrs(MONEY_ACCOUNT_RENAME_RULES.overdraftLimit)}
                              defaultValue={a.overdraftLimit}
                              title="How far below zero this drawer may go before a draw is refused. Entered positive; 0 means never."
                              className="w-24 rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-ink text-xs"
                            />
                          </Field>
                        )}
                        </div>
                      </EditableRecord>
                    )}
                    {a.isActive && !a.isFoundation && (
                      <form action={retireMoneyAccountAction}>
                        <input type="hidden" name="moneyAccountId" value={a.id} />
                        <ConfirmDestructive
                          tier="retype"
                          label="Retire money account"
                          consequence="Retires this money account."
                          expectedName={a.name}
                        />
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

        <CheckedForm rules={MONEY_ACCOUNT_CREATE_RULES} action={createMoneyAccountAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What staff call it — “GCash — cashier”, “BDO — office”" rule={MONEY_ACCOUNT_CREATE_RULES.name}>
              <Input {...nativeAttrs(MONEY_ACCOUNT_CREATE_RULES.name)} placeholder="GCash — cashier" className="w-full" />
            </Field>
            <Field label="Store" rule={MONEY_ACCOUNT_CREATE_RULES.storeId}>
              <Select {...nativeAttrs(MONEY_ACCOUNT_CREATE_RULES.storeId)} defaultValue="" className="w-full">
                <option value="">Choose a store…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kind">
              <Select name="instrument" defaultValue="ewallet" className="w-full">
                {MONEY_INSTRUMENTS.map((i) => (
                  <option key={i} value={i}>
                    {INSTRUMENT_LABEL[i] ?? i}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Held by"
              hint="A staff float is per person — the ledger names which one on each line"
            >
              <Select name="custodian" defaultValue="cashier" className="w-full">
                {CUSTODIANS.map((c) => (
                  <option key={c} value={c}>
                    {CUSTODIAN_LABEL[c] ?? c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Notes">
            <Input name="notes" className="w-full" />
          </Field>

          {/* ⭐ No GL-code field, deliberately. The books account is DERIVED from kind + holder —
              putting the chart of accounts in a form is how a typo becomes a wallet that reports
              as cash. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            The books account is chosen for you from the kind and the holder: cash lands in
            the cashier, staff or office cash account by who holds it, and every e-wallet or bank
            account shares the e-wallet account — the line names which one.
          </p>

          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
        </CheckedForm>
      </section>
    </Page>
  );
}

function Field({ label, hint, rule, className, children }: { label: React.ReactNode; hint?: string; rule?: FieldRule; className?: string; children: React.ReactNode }) {
  const body = (
    <>      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    
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

function CustodianBadge({ custodian }: { custodian: string }) {
  const cls =
    custodian === 'cashier'
      ? 'bg-info-soft text-info'
      : custodian === 'office'
        ? 'bg-success-soft text-success'
        : 'bg-warning-soft text-warning-ink';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {CUSTODIAN_LABEL[custodian] ?? custodian}
    </span>
  );
}
