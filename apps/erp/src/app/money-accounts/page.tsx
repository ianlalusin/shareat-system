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
import { CheckedForm, EditableRecord } from '@/components/forms';
import { MONEY_ACCOUNT_CREATE_RULES, MONEY_ACCOUNT_RENAME_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Card, ConfirmDestructive, EmptyState, Field, FlashBanner, FormGrid, FormModal, Input, NumTd, Select, Table, Td, Th, DialogActions } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { SubmitButton } from '@/components/feedback/SubmitButton';

export const metadata = { title: 'Money accounts — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  store?: string;
  kind?: string;
  q?: string;
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

  const storeFilter = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : '';
  const kindFilter =
    sp.kind && (MONEY_INSTRUMENTS as readonly string[]).includes(sp.kind) ? sp.kind : '';
  const query = (sp.q ?? '').trim().toLowerCase();
  const filtered = accounts.filter((a) => {
    const store = storeById.get(a.storeId);
    if (storeFilter && a.storeId !== storeFilter) return false;
    if (kindFilter && a.instrument !== kindFilter) return false;
    if (!query) return true;
    return [a.name, a.notes, store?.name, store?.code, accountLabel(a.glAccountCode)]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(query));
  });
  const grouped = new Map<string, typeof filtered>();
  for (const account of filtered) {
    const rows = grouped.get(account.name) ?? [];
    rows.push(account);
    grouped.set(account.name, rows);
  }
  const groups = [...grouped.entries()].sort(([nameA, rowsA], [nameB, rowsB]) => {
    const foundation = Number(rowsB.some((a) => a.isFoundation)) - Number(rowsA.some((a) => a.isFoundation));
    return foundation || nameA.localeCompare(nameB);
  });

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

      {accounts.length > 0 && (
        <>
          <FilterRow>
            <label className="text-sm">
              <span className="block text-muted">Store</span>
              <Select name="store" defaultValue={storeFilter} className="mt-1">
                <option value="">All stores</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="block text-muted">Kind</span>
              <Select name="kind" defaultValue={kindFilter} className="mt-1">
                <option value="">All kinds</option>
                {MONEY_INSTRUMENTS.map((instrument) => (
                  <option key={instrument} value={instrument}>
                    {INSTRUMENT_LABEL[instrument] ?? instrument}
                  </option>
                ))}
              </Select>
            </label>
            <label className="min-w-48 flex-1 text-sm">
              <span className="block text-muted">Search</span>
              <Input name="q" defaultValue={sp.q ?? ''} placeholder="Account, store or books account" className="mt-1 w-full" />
            </label>
          </FilterRow>

          <p className="text-xs text-muted">
            {filtered.length} of {accounts.length} accounts · {active.length} active · {retired.length} retired
          </p>

          {filtered.length === 0 ? (
            <EmptyState
              illustration="magnifier"
              title="No accounts match"
              body="Clear the store, kind or search filter to see the rest of the register."
            />
          ) : (
            <div className="space-y-7">
              {groups.map(([name, rows]) => (
                <section key={name} className="space-y-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="text-sm font-semibold">{name}</h2>
                    {rows.some((a) => a.isFoundation) && (
                      <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info">
                        Always present
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {rows.length} {rows.length === 1 ? 'store' : 'stores'}
                    </span>
                  </div>
                  <Table card={{ title: 'Store', subtitle: 'Held by', keys: ['Limit'] }}>
                    <thead>
                      <tr>
                        <Th>Store</Th>
                        <Th>Held by</Th>
                        <Th>Books</Th>
                        <Th numeric>Limit</Th>
                        <Th className="w-20" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => {
                        const store = storeById.get(a.storeId);
                        return (
                          <tr key={a.id} className={a.isActive ? undefined : 'opacity-60'}>
                            <Td>
                              <span className="font-mono text-xs">{store?.code ?? '—'}</span>
                              <span className="block text-xs text-muted">{store?.name ?? 'Unknown store'}</span>
                              {!a.isActive && (
                                <span className="mt-1 inline-flex rounded-full bg-closed-soft px-2 py-0.5 text-[11px] font-medium text-closed">
                                  Retired
                                </span>
                              )}
                              {a.notes && <span className="mt-1 block text-xs text-muted">{a.notes}</span>}
                            </Td>
                            <Td>
                              <CustodianBadge custodian={a.custodian} />
                            </Td>
                            <Td className="text-xs text-muted">{accountLabel(a.glAccountCode)}</Td>
                            <NumTd>{a.custodian === 'cashier' ? a.overdraftLimit : '—'}</NumTd>
                            <Td className="text-right whitespace-nowrap">
                              <div data-card-ignore className="flex items-center justify-end gap-1">
                              {a.isActive && a.isFoundation && (
                                <EditableRecord
                                  action={renameMoneyAccountAction}
                                  label={a.name}
                                  hidden={{ moneyAccountId: a.id }}
                                  typed={typedFor(sp, MONEY_ACCOUNT_RENAME, a.id, actor.personId)}
                                  rules={MONEY_ACCOUNT_RENAME_RULES}
                                >
                                  <FormGrid layout="fields">
                                    <Field label="Name" width="name" rule={MONEY_ACCOUNT_RENAME_RULES.name}>
                                      <Input {...nativeAttrs(MONEY_ACCOUNT_RENAME_RULES.name)} defaultValue={a.name} className="w-full" />
                                    </Field>
                                    {a.custodian === 'cashier' && (
                                      <Field
                                        label="May go to −"
                                        width="short"
                                        rule={MONEY_ACCOUNT_RENAME_RULES.overdraftLimit}
                                        hint="How far below zero this drawer may go before a draw is refused. Entered positive; 0 means never."
                                      >
                                        <Input {...nativeAttrs(MONEY_ACCOUNT_RENAME_RULES.overdraftLimit)} defaultValue={a.overdraftLimit} className="w-full" />
                                      </Field>
                                    )}
                                  </FormGrid>
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
                              </div>
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Add one ──────────────────────────────────────────────────────────────────── */}
      {/* T-448: the add form opens from a button, not sitting open on the page. */}
      <Card className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Add a money account</h2>
          <FormModal trigger="+ Add money account" title="Add a money account" size="md">
            <CheckedForm rules={MONEY_ACCOUNT_CREATE_RULES} action={createMoneyAccountAction} className="space-y-4">
              <FormGrid layout="fields">
                <Field label="Name" width="name" hint="What staff call it — “GCash — cashier”, “BDO — office”" rule={MONEY_ACCOUNT_CREATE_RULES.name}>
                  <Input {...nativeAttrs(MONEY_ACCOUNT_CREATE_RULES.name)} placeholder="GCash — cashier" className="w-full" />
                </Field>
                <Field label="Store" width="name" rule={MONEY_ACCOUNT_CREATE_RULES.storeId}>
                  <Select {...nativeAttrs(MONEY_ACCOUNT_CREATE_RULES.storeId)} defaultValue="" className="w-full">
                    <option value="">Choose a store…</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Kind" width="code">
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
                  width="code"
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
                <Field label="Notes" width="long">
                  <Input name="notes" className="w-full" />
                </Field>
              </FormGrid>

              {/* ⭐ No GL-code field, deliberately. The books account is DERIVED from kind + holder —
                  putting the chart of accounts in a form is how a typo becomes a wallet that reports
                  as cash. */}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                The books account is chosen for you from the kind and the holder.
              </p>

              <DialogActions>
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </DialogActions>
            </CheckedForm>
          </FormModal>
        </div>
        <p className="text-sm text-muted">
          <strong>Admin only.</strong> A money account is an account in the books, not a setting.
        </p>
      </Card>
    </Page>
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
