import { notFound } from 'next/navigation';
import { authorize, can as canDo } from '@shareat/auth';
import { salesDaysRepo, journalRepo, posV1Repo } from '@shareat/db';
import { packageCapExcess, unpostedUsageDraftCount } from '@shareat/domain';
import { add, compare, formatMoney, money, ZERO } from '@shareat/core/money';
import { addDays, formatBusinessDateTime, parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { listStores, listActingPersons, getStoreLink } from '../lib';
import { requireSession } from '../../../lib/session';
import { postPosCorrectionAction, recheckPosDayAction, reimportSalesDayAction, setPlatformSalesAction, submitSalesDayAction, verifySalesDayAction, voidSalesDayAction } from '../actions';
import { withOrgPrincipal } from '../../expenses/lib';
import { canOverrideClosedMonth } from '../../expenses/reimbursements/lib';
import { closedMonthOf, closedMonths } from '../../../lib/period-override';
import { ClosedMonthOverride } from '@/components/ClosedMonthOverride';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { personName } from '@/lib/person-name';
import { accountLabel, accountCodeAndName } from '@/lib/account-label';

import { typedFor } from '@/lib/keep-typing';
import { PLATFORM_SALES_EDIT } from '../typed-forms';
import { CheckedForm, EditableRecord, FieldCheck } from '@/components/forms';
import { SALES_DAY_CORRECTION_RULES, SALES_DAY_VOID_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { ACTION_LINK } from '@/components/action-link';
import { Badge, Banner, Button, ConfirmDestructive, FlashBanner, FormGrid, Input } from '@/components/ui';

export const metadata = { title: 'Sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function SalesDayDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);

  const { actor } = await requireSession(`/sales-days/${id}`);
  const orgId = actor.orgId;

  const day = await withOrgPrincipal(orgId, (tx) => salesDaysRepo.getById(tx, orgId, id));
  if (!day) notFound();

  const [channels, stores, persons] = await Promise.all([
    withOrgPrincipal(orgId, (tx) => salesDaysRepo.getChannelsForDay(tx, day.id)),
    listStores(orgId),
    listActingPersons(orgId),
  ]);

  // Shown whenever an entry EXISTS, not only while verified — a void is a REVERSAL and both
  // entries stand, so hiding them on void would make the page contradict its own void copy.
  const entryId = day.journalEntryId;
  const { lines, reversalId, reversalLines } = entryId
    ? await withOrgPrincipal(orgId, async (tx) => {
        const original = await journalRepo.findLinesForEntryWithAccountCodes(tx, entryId);
        const reversal = await journalRepo.findReversalOfEntry(tx, orgId, entryId);
        return {
          lines: original,
          reversalId: reversal?.id ?? null,
          reversalLines: reversal ? await journalRepo.findLinesForEntryWithAccountCodes(tx, reversal.id) : [],
        };
      })
    : { lines: [], reversalId: null, reversalLines: [] };

  // T-369 S3 (DEF-479): what this viewer may DO to the day, probed with the real `authorize()` so a
  // control renders only where it can be used (bible row 262). The domain re-checks on submit. An open
  // day is edited under `submit_sales_day`, a submitted one under `verify_sales_day`; a void needs
  // `void_sales_day`.
  const can = await withOrgPrincipal(orgId, async (tx) => {
    const probe = (capability: 'submit_sales_day' | 'verify_sales_day' | 'void_sales_day' | 'verify_own_sales_day') =>
      canDo(tx, actor, capability, { storeId: day.storeId });
    return {
      edit: await probe(day.status === 'submitted' ? 'verify_sales_day' : 'submit_sales_day'),
      void: await probe('void_sales_day'),
      verify: await probe('verify_sales_day'),
      // T-385 S3: the submitter may verify their own day only with verify_own_sales_day (super-admin). A probe of the
      // same capability the domain checks; the domain still refuses a forged post.
      ownBlocked:
        day.status === 'submitted' && day.submittedBy === actor.personId && !(await probe('verify_own_sales_day')),
    };
  });
  const unverified = day.status === 'open' || day.status === 'submitted';

  // T-487 (DEF-779): a submitted day whose month has since been closed can only be posted by an administrator, with a reason.
  // The override fields are OFFERED only to a holder of `override_period_lock` and only when the day's own date is in a CLOSED
  // month; `verifySalesDay` / `postEntry` are what enforce it.
  const canOverride = day.status === 'submitted' && can.verify ? await canOverrideClosedMonth(actor) : false;
  const closedMonth = canOverride ? closedMonthOf(await closedMonths(orgId), day.businessDate) : undefined;

  // T-401 S6 (Ian 15 Oct; A11): a WARNING, never a block - how many of this store's usage drafts dated the day BEFORE THE SALES DAY BEING VIEWED still wait for a manager.
  // Shown only to someone who can post them; the count is the domain's own read.
  const unpostedUsage = await withOrgPrincipal(orgId, async (tx) =>
    (await canDo(tx, actor, 'post_usage', { storeId: day.storeId }))
      ? unpostedUsageDraftCount(tx, actor, { storeId: day.storeId, businessDate: addDays(parseBusinessDate(day.businessDate), -1) })
      : 0,
  );

  // T-375 S3: where the figures came from. A feed day is imported (and re-imported while unverified); a typed day
  // belongs to a store that was not linked to POS when it was typed, and is the only kind that is edited by hand.
  const isFeedDay = day.source === 'pos_v1_day_feed';
  const storeLink = await getStoreLink(orgId, day.storeId);
  // W1: POS's package figure can exceed the day's sales; the difference is not booked. Computed from the stored
  // feed on read (no column).
  const capExcess =
    isFeedDay && day.posV1DayFeedId
      ? packageCapExcess(
          (await withOrgPrincipal(orgId, (tx) => posV1Repo.getFeedById(tx, orgId, day.posV1DayFeedId!)))?.payload,
          money(day.unliSales),
        )
      : ZERO;

  // T-375 S4 (R8): platform sales are the one thing typed on a feed day - the store's NON-remitted channels, while the
  // day is unverified. A remitted channel comes from POS and is never offered here.
  const platformChannels =
    isFeedDay && unverified && can.edit
      ? (await withOrgPrincipal(orgId, (tx) => salesDaysRepo.listChannels(tx, orgId, day.storeId, { activeOnly: true }))).filter(
          (c) => !c.isRemittedDaily,
        )
      : [];

  // T-375 S6 (R10): a verified feed day's corrections, and whether POS has changed it since it was posted. The drift
  // is the same question the posDayFeedDrift finding asks (one repo function), so the two can never disagree.
  const corrections =
    isFeedDay
      ? await withOrgPrincipal(orgId, (tx) => posV1Repo.listCorrectionsForDay(tx, orgId, day.id))
      : [];
  const drift =
    isFeedDay && day.status === 'verified'
      ? (await withOrgPrincipal(orgId, (tx) => posV1Repo.feedDrift(tx, orgId, day.id)))[0]
      : undefined;

  const storeName = stores.find((s) => s.id === day.storeId)?.name ?? day.storeId;

  const carry = new URLSearchParams();
  if (sp.store) carry.set('store', sp.store);

  // T-371 C4: summed and compared as Money (exact centavos), never as floats.
  const discountsTotal = add(money(day.seniorDiscount), money(day.pwdDiscount), money(day.otherDiscount));
  const nonRemitted = channels.filter((c) => !c.isRemittedDaily);
  const nonRemittedTotal = add(ZERO, ...nonRemitted.map((c) => money(c.amount)));
  const isPositive = (v: string) => compare(money(v), ZERO) > 0;

  // ⭐ Only the DOCUMENT is named here. Who is acting comes from the session (T-138) — this used
  // to carry an actingPersonId, which is what made the submit/verify segregation unenforceable.
  const hiddenIds = (
    <>
      <input type="hidden" name="storeId" value={sp.store ?? ''} />
      <input type="hidden" name="salesDayId" value={day.id} />
    </>
  );

  const hasPlatformRows = channels.some((r) => platformChannels.some((c) => c.id === r.channelId));
  return (
    <Page view="detail" sectioned density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a
            href={`/sales-days?${carry.toString()}`}
            className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
          >
            ← All sales days
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{day.businessDate}</h1>
          <PageDescription>
            {storeName} ·{' '}
            {isFeedDay
              ? `Imported from POS at ${day.posSourcedAt ? formatBusinessDateTime(day.posSourcedAt) : 'an unknown time'}`
              : 'Typed — store not linked to POS'}
          </PageDescription>
        </div>
        <div className="text-right">
          <Badge status={day.status} />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(money(day.totalSales))}</p>
        </div>
      </div>

      <FlashBanner flash={sp} />

      {day.status !== 'verified' && day.status !== 'voided' && (
        <Banner tone="warning">
          ⚠️ <strong>This day recognises no revenue yet.</strong> Nothing is posted to the ledger
          until it is verified, and no newer day can be created for this store meanwhile.
        </Banner>
      )}

      {unpostedUsage > 0 && (
        <Banner tone="warning">
          <strong>Yesterday&apos;s usage not posted.</strong> {unpostedUsage} usage {unpostedUsage === 1 ? 'draft is' : 'drafts are'} still waiting for
          a manager. Check each line against what POS says was sold, then post it; a draft made from POS sales that is still
          unposted is posted at the expected quantity at 14:00 the next day. This does not stop the day from being submitted or verified.{' '}
          <a href={`/inventory/usage?store=${day.storeId}`} className={ACTION_LINK}>
            Open the usage queue →
          </a>
        </Banner>
      )}

      {compare(capExcess, ZERO) > 0 && (
        <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          POS&apos;s package figure was {formatMoney(capExcess)} higher than the day&apos;s sales; the difference is not
          booked.
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <Panel title="Revenue">
          <Row label="Unlimited" value={formatMoney(money(day.unliSales))} />
          <Row label="À la carte" value={formatMoney(money(day.alaCarteSales))} />
          <Row label="Total" value={formatMoney(money(day.totalSales))} strong />
        </Panel>

        <Panel title="Tender">
          <Row label="Cash" value={formatMoney(money(day.cashCollected))} />
          <Row label="Online" value={formatMoney(money(day.onlineCollected))} />
          {isPositive(day.creditSales) && (
            <Row label="Credit / on account" value={formatMoney(money(day.creditSales))} />
          )}
          {compare(nonRemittedTotal, ZERO) > 0 && (
            <Row label="Non-remitted channels" value={formatMoney(nonRemittedTotal)} />
          )}
          <Row label="Discounts" value={formatMoney(discountsTotal)} />
          <Row label="Comps" value={formatMoney(money(day.comps))} />
          {isPositive(day.refunds) && <Row label="Refunds (POS)" value={formatMoney(money(day.refunds))} />}
          {isPositive(day.otherCharges) && (
            <Row label="Other charges" value={formatMoney(money(day.otherCharges))} />
          )}
          {/* ⭐ A float — neither revenue nor AP. Fills here, empties through payroll, and never
              reaches the P&L (bible row 135). */}
          {isPositive(day.serviceCharge) && (
            <Row label="Service charge (held for staff)" value={formatMoney(money(day.serviceCharge))} />
          )}
        </Panel>

        <Panel title="Discounts, itemised">
          {/* Separate because RR 5-2017 requires the breakout — statutory, not reporting taste. */}
          <Row label="Senior" value={formatMoney(money(day.seniorDiscount))} />
          <Row label="PWD" value={formatMoney(money(day.pwdDiscount))} />
          <Row label="Other" value={formatMoney(money(day.otherDiscount))} />
        </Panel>

        <Panel title="Trail">
          <Row label="Created by" value={personName(persons, day.createdBy)} />
          <Row label="Submitted by" value={personName(persons, day.submittedBy)} />
          <Row label="Verified by" value={personName(persons, day.verifiedBy)} />
          {day.status === 'voided' && (
            <>
              <Row label="Voided by" value={personName(persons, day.voidedBy)} />
              <Row label="Void reason" value={day.voidReason ?? '—'} />
            </>
          )}
        </Panel>
      </section>

      {channels.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Channels</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Remittance</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{c.channelName}</td>
                    <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {c.isRemittedDaily ? 'reaches the till' : `settles later → ${accountLabel(c.receivableAccountCode)}`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {/* ⭐ "confirmed no sales" is a different claim from a blank, and from a zero. */}
                      {c.noSales ? (
                        <span className="text-xs italic text-neutral-500 dark:text-neutral-400">
                          confirmed no sales
                        </span>
                      ) : (
                        formatMoney(money(c.amount))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {entryId && (
        <section className="space-y-4">
          <div className="space-y-2">
            <h2 className="font-medium">
              Ledger entry{' '}
              <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{entryId}</span>
            </h2>
            <LedgerTable lines={lines} />
          </div>
          {reversalId && (
            <div className="space-y-2">
              <h2 className="font-medium">
                Reversing entry{' '}
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{reversalId}</span>
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                The void posted this. <strong>Both entries stand</strong> — the ledger records what
                happened and what undid it.
              </p>
              <LedgerTable lines={reversalLines} />
            </div>
          )}
        </section>
      )}

      {isFeedDay && day.status === 'verified' && (corrections.length > 0 || drift) && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="font-medium">Corrections</h2>
          {corrections.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
                    <th className="px-3 py-2 font-medium">Dated</th>
                    <th className="px-3 py-2 font-medium">Reason</th>
                    <th className="px-3 py-2 font-medium">Posted by</th>
                    <th className="px-3 py-2 font-medium">Entry</th>
                  </tr>
                </thead>
                <tbody>
                  {corrections.map((c) => (
                    <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      <td className="px-3 py-2">{c.entryDate}</td>
                      <td className="px-3 py-2">{c.reason}</td>
                      <td className="px-3 py-2">{personName(persons, c.postedBy)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-neutral-500 dark:text-neutral-400">{c.journalEntryId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {drift && (
            <p className="text-neutral-700 dark:text-neutral-300">
              POS now reports {formatMoney(money(drift.paidNow))} paid for this day; it was {formatMoney(money(drift.paidThen))} when the
              day was posted. The ledger still holds the old figures.
            </p>
          )}
          {drift && can.verify && (
            <CheckedForm rules={SALES_DAY_CORRECTION_RULES} action={postPosCorrectionAction} className="flex flex-wrap items-end gap-3">
              {hiddenIds}
              <input type="hidden" name="feedId" value={drift.latestFeedId} />
              <Field label="Dated" rule={SALES_DAY_CORRECTION_RULES.entryDate}>
                <Input
                  type="date"
                  {...nativeAttrs(SALES_DAY_CORRECTION_RULES.entryDate)}
                  defaultValue={toBusinessDate().localeCompare(day.businessDate) < 0 ? day.businessDate : toBusinessDate()}
                />
              </Field>
              <Field label="Reason" rule={SALES_DAY_CORRECTION_RULES.reason} className="min-w-[16rem] flex-1">
                <Input {...nativeAttrs(SALES_DAY_CORRECTION_RULES.reason)} placeholder="What changed in POS?" />
              </Field>
              <Button type="submit" variant="secondary">
                Post correction
              </Button>
            </CheckedForm>
          )}
        </section>
      )}

      {isFeedDay && day.status !== 'voided' && can.verify && (
        <form action={recheckPosDayAction} className="space-y-2 text-sm">
          {hiddenIds}
          <Button type="submit" variant="secondary">
            Check POS again
          </Button>
          <p className="text-neutral-600 dark:text-neutral-400">
            Asks POS what it says about this day now and stores the answer. Nothing is posted by checking.
          </p>
        </form>
      )}

      {unverified && can.edit && isFeedDay && (
        <form action={reimportSalesDayAction} className="space-y-2 text-sm">
          {hiddenIds}
          <Button type="submit" variant="secondary">
            Re-import from POS
          </Button>
          <p className="text-neutral-600 dark:text-neutral-400">
            Brings in whatever POS says now. Platform sales you entered stay as they are.
          </p>
        </form>
      )}

      {unverified && can.edit && !isFeedDay && !storeLink && (
        <div>
          <a
            href={`/sales-days/${day.id}/edit?${carry.toString()}`}
            className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
          >
            Edit this day
          </a>
        </div>
      )}

      {platformChannels.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="font-medium">Platform sales</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            Orders that were not rung through POS. They are added to this day when it is verified. Leave a box blank for
            none, or tick &quot;no sales&quot; to confirm there were none.
          </p>
          {(() => {
            const platformFields = (
            <FormGrid>
              {platformChannels.map((c) => {
                const row = channels.find((r) => r.channelId === c.id);
                return (
                  <div key={c.id} className="min-w-0 space-y-1">
                    <label htmlFor={`channel_${c.id}`} className="block">
                      {c.name}
                    </label>
                    <Input
                      id={`channel_${c.id}`}
                      name={`channel_${c.id}`}
                      inputMode="decimal"
                      defaultValue={row && !row.noSales ? row.amount : ''}
                      className="w-full text-right tabular-nums"
                    />
                    <label className="flex items-center gap-1 text-neutral-600 dark:text-neutral-400">
                      <input type="checkbox" name={`nosales_${c.id}`} defaultChecked={row?.noSales ?? false} />
                      no sales
                    </label>
                  </div>
                );
              })}
            </FormGrid>
            );
            return hasPlatformRows ? (
              <EditableRecord
                key={platformChannels.map((c) => { const r = channels.find((x) => x.channelId === c.id); return `${c.id}:${r?.amount ?? ''}:${r?.noSales ? 1 : 0}`; }).join('|')}
                action={setPlatformSalesAction}
                label="platform sales"
                hidden={{ storeId: sp.store ?? '', salesDayId: day.id }}
                typed={typedFor(sp, PLATFORM_SALES_EDIT, day.id, actor.personId)}
              >
                {platformFields}
              </EditableRecord>
            ) : (
              <form action={setPlatformSalesAction} className="space-y-3">
                <input type="hidden" name="storeId" value={sp.store ?? ''} />
                <input type="hidden" name="salesDayId" value={day.id} />
                {platformFields}
                <Button type="submit" variant="secondary">
                  Save
                </Button>
              </form>
            );
          })()}
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        {day.status === 'open' && (
          <form action={submitSalesDayAction} className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {hiddenIds}
            <h2 className="font-medium">Submit</h2>
            <p className="text-neutral-600 dark:text-neutral-400">
              Hands the day on for checking. <strong>Still recognises nothing</strong> — submitting
              is not verifying.
            </p>
            <p className="text-neutral-600 dark:text-neutral-400">
              Verify &amp; post comes after this, on the submitted day.
            </p>
            <Button type="submit" variant="primary">
              Submit
            </Button>
          </form>
        )}

        {day.status === 'submitted' && can.verify && can.ownBlocked && (
          <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            <h2 className="font-medium">Verification</h2>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">You submitted this day, so someone else has to verify it.</p>
          </div>
        )}

        {day.status === 'submitted' && can.verify && !can.ownBlocked && (
          <form action={verifySalesDayAction} className="flex flex-col justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {hiddenIds}
            <div>
              <h2 className="font-medium">Verify &amp; post</h2>
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                <strong>This is what recognises the revenue.</strong> The entry dates on{' '}
                {day.businessDate}, not today.
              </p>
            </div>
            {closedMonth && (
              <>
                <input type="hidden" name="salesDayDate" value={day.businessDate} />
                <ClosedMonthOverride closedMonths={[closedMonth]} dateFieldName="salesDayDate" initialDate={day.businessDate} />
              </>
            )}
            <Button type="submit" variant="primary">
              Verify &amp; post
            </Button>
          </form>
        )}
      </section>

      {unverified && can.void && (
        <CheckedForm rules={SALES_DAY_VOID_RULES} action={voidSalesDayAction} className="space-y-3 rounded-lg border border-danger p-4 text-sm">
          {hiddenIds}
          <h2 className="font-medium text-danger">Withdraw this unverified day</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            Nothing was posted for this day, so <strong>nothing is reversed</strong> — it is simply
            taken off the books. Anything else attached to it (a POS usage pull, recorded wastage, a
            counted handover) has to be undone first. A reason is required. A manager can enter this
            date again afterwards.
          </p>
          <div className="flex gap-2">
            <Field label={<span className="sr-only">Reason</span>} rule={SALES_DAY_VOID_RULES.reason} className="flex-1">
              <Input {...nativeAttrs(SALES_DAY_VOID_RULES.reason)} placeholder="Why is this being withdrawn?" />
            </Field>
            <Button type="submit" variant="danger">
              Withdraw day
            </Button>
          </div>
        </CheckedForm>
      )}

      {day.status === 'verified' && can.void && (
        <CheckedForm rules={SALES_DAY_VOID_RULES} action={voidSalesDayAction} className="space-y-3 rounded-lg border border-danger p-4 text-sm">
          {hiddenIds}
          <h2 className="font-medium text-danger">Void (reverses the posting)</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            A verified day is voided by <strong>reversing</strong> its entry — the original stays
            visible and both sides remain in the ledger. A reason is required.
          </p>
          <div className="flex gap-2">
            <Field label={<span className="sr-only">Reason</span>} rule={SALES_DAY_VOID_RULES.reason} className="flex-1">
              <Input {...nativeAttrs(SALES_DAY_VOID_RULES.reason)} placeholder="Why is this being voided?" />
            </Field>
            <ConfirmDestructive
              tier="admin-pin"
              label="Void sales day"
              consequence="Reverses this verified day's posting. An administrator must approve with their own PIN."
            />
          </div>
        </CheckedForm>
      )}
    </Page>
  );
}

type EntryLine = Awaited<ReturnType<typeof journalRepo.findLinesForEntryWithAccountCodes>>[number];

function LedgerTable({ lines }: { lines: EntryLine[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Party</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
              <td className="px-3 py-2 text-neutral-400">{l.lineNo}</td>
              <td className="px-3 py-2">{accountCodeAndName(l.accountCode)}</td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {l.partyType ? `${l.partyType}:${l.partyId}` : '—'}
              </td>
              {/* Blank, not ₱0.00 — compared numerically because Postgres returns "0.00". */}
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.debit) === 0 ? '' : formatMoney(money(l.debit))}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.credit) === 0 ? '' : formatMoney(money(l.credit))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <h2 className="mb-3 font-medium">{title}</h2>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-neutral-200 pt-1.5 font-medium dark:border-neutral-800' : ''}`}>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function Field({ label, rule, className, children }: { label: React.ReactNode; rule: FieldRule; className?: string; children: React.ReactNode }) {
  // T-440: the label keeps its look; the live helper line sits OUTSIDE it (never part of the accessible name).
  return (
    <div className={className}>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
        {children}
      </label>
      <FieldCheck rule={rule} />
    </div>
  );
}
