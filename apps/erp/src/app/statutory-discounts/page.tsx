import { toBusinessDate } from '@shareat/core/datetime';
import { listStatutoryDiscounts, summariseStatutoryDiscounts } from '@shareat/domain';
// ⛔ `peso()` and NOT `₱${formatMoney(...)}` — formatMoney already emits the symbol, and
// prefixing another rendered every figure on this page as ₱₱0.00. See lib/format.ts's header:
// five screens each grew their own broken copy, which is why there is one helper.
import { peso } from '../../lib/format';
import { listStores, withOrgPrincipal } from '../expenses/lib';
import { requireSession } from '../../lib/session';
import { recordStatutoryDiscountAction, voidStatutoryDiscountAction } from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, ConfirmDestructive, FlashBanner, FormGrid, Input, Select , FormSection} from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';

export const metadata = { title: 'SC/PWD register — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
  error?: string;
  showVoided?: string;
}

/** First and last day of the month a date falls in — the register is read by month in practice. */
function monthBounds(businessDate: string): { from: string; to: string } {
  const y = Number(businessDate.slice(0, 4));
  const m = Number(businessDate.slice(5, 7)) - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function StatutoryDiscountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);

  // ⭐ The org comes from the SESSION, not the URL — and RLS refuses cross-org reads underneath
  // even if someone edits the query string. That matters more here than on most screens: this
  // table holds customers' names and government ID numbers.
  const { actor } = await requireSession('/statutory-discounts');
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : undefined;
  const defaults = monthBounds(toBusinessDate());
  const from = sp.from && ISO_DATE.test(sp.from) ? sp.from : defaults.from;
  const to = sp.to && ISO_DATE.test(sp.to) ? sp.to : defaults.to;
  const includeVoided = sp.showVoided === '1';

  const query = { storeId, from, to, includeVoided };
  const { rows, summary } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    rows: await listStatutoryDiscounts(tx, actor, query),
    summary: await summariseStatutoryDiscounts(tx, actor, query),
  }));

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  const carry = { storeId: storeId ?? '', from, to };

  return (
    <Page density="table">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Senior citizen / PWD register</h1>
        <PageDescription>
          The per-transaction record required by <strong>RR 5-2017 §5.9</strong> (PWD) and{' '}
          <strong>RR 7-2010</strong> (senior citizen): name, ID number, gross, discount, date and
          invoice number, for every discounted sale.
        </PageDescription>
      </header>

      {/* ⛔ Bible row 75, on the face of the screen rather than buried in a doc. The disclaimer in
          POSTING-PATTERNS.md is doing real work and must not be quietly dropped; this is the same
          sentence where a reader will actually meet it. */}
      <Banner tone="warning">
        <strong>This is a business record, not a BIR return.</strong> Shareat System is a management
        ledger and computes no VAT — amounts here are recorded as the till calculated them. Nothing
        on this page posts to the ledger; the daily senior/PWD totals on the sales day remain the
        only figures that reach sales discounts in the ledger.
      </Banner>

      {/* ⛔ The honest caveat, and it is the important one on this screen. There is no paper
          logbook to copy from (bible row 164) — so a missing record cannot be recovered later, and
          a reader who assumes this register is complete will assume wrong. */}
      <div className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        <strong>A record must be entered while the customer is still at the counter.</strong> The
        till does not capture the holder&apos;s name or ID number and no paper logbook is kept, so
        nothing can reconstruct a sale that was not written down here. POS captures this itself from
        v2, after January.
      </div>

      <FlashBanner flash={sp} />

      {/* ── Filters ──────────────────────────────────────────────────────────────────── */}
      <form method="GET" className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Store</span>
          <Select name="store" defaultValue={storeId ?? ''}>
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">From</span>
          <Input type="date" name="from" defaultValue={from} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">To</span>
          <Input type="date" name="to" defaultValue={to} />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="showVoided" value="1" defaultChecked={includeVoided} className="h-5 w-5" />
          <span>Show voided</span>
        </label>
        <Button type="submit">Apply</Button>
      </form>

      {/* ── Summary ──────────────────────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: 'Records', v: String(summary.count), sub: `${summary.seniorCount} senior · ${summary.pwdCount} PWD` },
          { k: 'Gross', v: peso(summary.grossAmount) },
          { k: 'Discount granted', v: peso(summary.discountAmount) },
          { k: 'Net', v: peso(summary.netAmount) },
        ].map((c) => (
          <div key={c.k} className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">{c.k}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{c.v}</dd>
            {c.sub && <dd className="text-xs text-neutral-500">{c.sub}</dd>}
          </div>
        ))}
      </dl>

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Records</h2>
        {rows.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No records for this range. Every senior or PWD discount given in this period should have
            one row here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium">Invoice</th>
                  <th className="p-2 font-medium">Kind</th>
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">ID number</th>
                  <th className="p-2 text-right font-medium">Gross</th>
                  <th className="p-2 text-right font-medium">Discount</th>
                  <th className="p-2 text-right font-medium">Net</th>
                  <th className="p-2 font-medium">Store</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-neutral-200 dark:border-neutral-800 ${r.voidedAt ? 'text-neutral-400 line-through dark:text-neutral-600' : ''}`}
                  >
                    <td className="p-2 tabular-nums">{r.businessDate}</td>
                    <td className="p-2">{r.invoiceNumber}</td>
                    <td className="p-2">{r.kind === 'pwd' ? 'PWD' : 'Senior'}</td>
                    <td className="p-2">{r.holderName}</td>
                    <td className="p-2 tabular-nums">{r.idNumber}</td>
                    <td className="p-2 text-right tabular-nums">{peso(r.grossAmount)}</td>
                    <td className="p-2 text-right tabular-nums">{peso(r.discountAmount)}</td>
                    <td className="p-2 text-right tabular-nums">{peso(r.netAmount)}</td>
                    <td className="p-2">{storeName(r.storeId)}</td>
                    <td className="p-2 text-right">
                      {r.voidedAt ? (
                        <span title={r.voidReason ?? ''} className="text-xs">voided</span>
                      ) : (
                        <form action={voidStatutoryDiscountAction} className="flex items-center justify-end gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="storeId" value={carry.storeId} />
                          <input type="hidden" name="from" value={carry.from} />
                          <input type="hidden" name="to" value={carry.to} />
                          <Input name="voidReason" required placeholder="Reason" className="w-28 text-xs" />
                          <ConfirmDestructive
                            tier="admin-pin"
                            label="Void statutory discount"
                            consequence="Voids this statutory discount. An administrator must approve with their own PIN."
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
      </section>

      {/* ── Entry ────────────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Add a record</h2>
        <form action={recordStatutoryDiscountAction} className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <input type="hidden" name="from" value={carry.from} />
          <input type="hidden" name="to" value={carry.to} />
          <>
            <FormSection title="Sale document">
              <FormGrid layout="fields">
                <div className="min-w-0">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Store</span>
                    <Select name="storeId" required defaultValue={storeId ?? ''}>
                      <option value="" disabled>Choose a store</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </Select>
                  </label>
                </div>
                <div className="min-w-0 erp-field-date">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Date of sale</span>
                    <Input type="date" name="businessDate" required defaultValue={to} />
                  </label>
                </div>
                <div className="min-w-0 erp-field-code">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Invoice / OR number</span>
                    <Input name="invoiceNumber" required />
                  </label>
                </div>
              </FormGrid>
            </FormSection>
            <FormSection title="Beneficiary">
              <FormGrid layout="fields">
                <div className="min-w-0">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Discount kind</span>
                    <Select name="kind" required defaultValue="senior">
                      <option value="senior">Senior citizen (OSCA ID)</option>
                      <option value="pwd">PWD (PWD ID)</option>
                    </Select>
                    <span className="text-xs text-neutral-500">One only — a PWD who is also a senior claims one 20%, not both.</span>
                  </label>
                </div>
                <div className="min-w-0 erp-field-long">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Holder&apos;s name</span>
                    <Input name="holderName" required />
                  </label>
                </div>
                <div className="min-w-0 erp-field-code">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">ID number</span>
                    <Input name="idNumber" required />
                  </label>
                </div>
              </FormGrid>
            </FormSection>
            <FormSection title="Amounts">
              <FormGrid layout="fields">
                <div className="min-w-0">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Gross amount</span>
                    <Input name="grossAmount" inputMode="decimal" required placeholder="0.00" className="tabular-nums" />
                  </label>
                </div>
                <div className="min-w-0">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Discount granted</span>
                    <Input name="discountAmount" inputMode="decimal" required placeholder="0.00" className="tabular-nums" />
                  </label>
                </div>
              </FormGrid>
            </FormSection>
            <FormSection title="Sign-off and notes">
              <FormGrid layout="fields">
                <div className="min-w-0">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Signatory <span className="font-normal text-neutral-500">(optional)</span></span>
                    <Input name="signatory" />
                    <span className="text-xs text-neutral-500">Not required by the regulations — kept if your store&apos;s logbook has the column.</span>
                  </label>
                </div>
                <div className="min-w-0 erp-field-long">
                  <label className="flex flex-col gap-1 text-sm col-span-full">
                    <span className="font-medium">Notes <span className="font-normal text-neutral-500">(optional)</span></span>
                    <Input name="notes" />
                  </label>
                </div>
                <div className="col-span-full">
                  <SubmitButton pendingLabel="Saving…" className="w-full sm:w-auto">Save</SubmitButton>
                </div>
              </FormGrid>
            </FormSection>
          </>
        </form>
      </section>
    </Page>
  );
}
