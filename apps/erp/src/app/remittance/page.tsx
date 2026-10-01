import { authorize, AuthorizationError, heldCapabilities } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { requireSession } from '../../lib/session';
import { listActingPersons } from '../expenses/lib';
import {
  createRemittanceAction,
  resolveVarianceAction,
  reverseRemittanceAction,
  setCashPolicyAction,
} from './actions';
import {
  CADENCE_LABEL,
  STATE_LABEL,
  cashCustodyFindings,
  cashierAccounts,
  defaultStoreFor,
  endDays,
  listStores,
  officeAccounts,
  openVarianceCountForOrg,
  openVariances,
  peso,
  recentRemittances,
  storeCashPolicy,
  today,
  withOrgPrincipal,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Remittance — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  store?: string;
}

export default async function RemittancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/remittance');

  const stores = await listStores(actor.orgId);
  const storeId =
    sp.store || (await defaultStoreFor(actor, stores.map((s) => s.id))) || stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">Remittance</h1>
        <PageDescription>No stores yet.</PageDescription>
      </Page>
    );
  }

  const [days, cashier, office, recent, variances, orgVarianceCount, people, findings, policy] = await Promise.all([
    endDays(actor.orgId, storeId, today()),
    cashierAccounts(actor.orgId, storeId),
    officeAccounts(actor.orgId, storeId),
    recentRemittances(actor.orgId, storeId),
    openVariances(actor.orgId, storeId),
    openVarianceCountForOrg(actor.orgId),
    listActingPersons(actor.orgId),
    cashCustodyFindings(actor.orgId, storeId),
    storeCashPolicy(actor.orgId, storeId),
  ]);

  const owing = days.filter((d) => Number(d.owed) > 0);
  const remittable = owing.filter((d) => d.remittable);
  const totalRemittable = remittable.reduce((s, d) => s + Number(d.owed), 0);
  const heldBack = owing.filter((d) => !d.remittable);
  const handoverFormRenders = remittable.length > 0 && cashier.length > 0 && office.length > 0;

  // T-324: a declared overage writes a POSITIVE variance, same as any other — the heading below
  // has to speak to both signs, not just the short case it was written for.
  const varianceShortCount = variances.filter((v) => Number(v.amount) < 0).length;
  const varianceOverCount = variances.length - varianceShortCount;

  // T-366 S3 audit finding 5 — both Charge and Recognise-as-income authorise the SAME capability
  // (`resolveRemittanceVariance` gates on `accept_remittance` regardless of action), so ONE
  // `authorize()` probe at the page's own `storeId` is the real narrowing — the same idiom
  // `channel-settlements/page.tsx` and `customers/[customerId]/page.tsx` use, not a new auth
  // helper. `authorize()` in the domain stays the real gate; this only decides what renders.
  // ⚠️ This single boolean is valid ONLY because `variances` (from `openVariances` above) is
  // itself scoped to this same `storeId` (Ian's ruling, round 2 — `listVariances` filters by
  // store, so every row shown is guaranteed to be at it). It is NOT a per-row check — if that
  // guarantee ever broke (a future caller passing an unscoped list, a join regression), a variance
  // from a DIFFERENT store could silently get this store's answer. The invariant below catches
  // that rather than trusting it silently.
  const canResolveVariances = await withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    if (!held.has('accept_remittance')) return false;
    try {
      await authorize(tx, actor, 'accept_remittance', { storeId });
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  });
  // T-366 S3 audit round 3 finding 3 — cheap invariant backing the comment above: if any variance
  // shown disagrees with the page's own store, `listVariances`' scoping did not hold, and this
  // falls back to refusing every control rather than trusting a single-store answer for a
  // multi-store list.
  const variancesAreStoreScoped = variances.every((v) => v.storeId === storeId);
  if (!variancesAreStoreScoped) {
    logger.error(
      { orgId: actor.orgId, storeId, otherStores: [...new Set(variances.map((v) => v.storeId))] },
      'remittance page: openVariances returned a variance from another store — refusing every control',
    );
  }

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Remittance</h1>
        <PageDescription>
          What the cashier holds, day by day, and the handover that clears it. A day is owed{' '}
          <strong>everything the cashier touched</strong> — sales, collections and returns in;
          expenses paid from the till, cash requests and advances out. One handover can settle
          several days.
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

      {/*
        ⭐ T-152 — the ceiling, the cadence, and DEF-082's float.

        These sit ABOVE the variances deliberately. A variance is money already found missing; these
        are money still sitting somewhere it should not be, which is the condition a variance grows
        out of. Row 129: "the pile becomes visible and unignorable to the person who can clear it,
        never a blocked till" — so nothing here stops a handover, a sale, or a verification.
      */}
      {findings.length > 0 && (
        <section className="space-y-2 rounded-lg border border-orange-300 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-950">
          <div className="text-sm font-medium text-orange-900 dark:text-orange-300">
            {findings.length} cash-custody {findings.length === 1 ? 'finding' : 'findings'}
          </div>
          <ul className="space-y-2">
            {findings.map((f) => (
              <li
                key={f.key}
                className="border-t border-orange-200 pt-2 text-sm text-orange-900 dark:border-orange-900 dark:text-orange-300"
              >
                {f.detail}
                {f.status === 'acknowledged' && (
                  // ⚠️ Acknowledged is not resolved: it is still counted, and it visibly ages.
                  <span className="ml-2 rounded bg-orange-200 px-1.5 py-0.5 text-xs dark:bg-orange-900">
                    accepted for now
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        ⭐ OPEN VARIANCES FIRST, AND THAT ORDER IS THE POINT (bible row 147).

        Ian: "it won't block — but it must be flagged and dedicate a separated table so it won't
        hide from sight like v1 does." It does not block the next handover; it simply cannot be
        got past without being seen.
      */}
      {/* T-366 S3 audit round 3 finding 1 (bible row 147) — the section renders whenever there is
          ANYTHING unresolved in the org, even 0 at the CURRENT store, so a variance elsewhere is
          counted and visible, never hidden by the store picker. Rows and controls stay
          store-scoped either way (finding 5). */}
      {(variances.length > 0 || orgVarianceCount > 0) && (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="text-sm text-amber-900 dark:text-amber-300">
            <strong className="font-medium">
              {variances.length} unresolved remittance{' '}
              {variances.length === 1 ? 'variance' : 'variances'} here
              {orgVarianceCount > variances.length &&
                ` · ${orgVarianceCount - variances.length} more at other stores`}
              .
            </strong>{' '}
            {variances.length > 0 &&
              (varianceShortCount > 0 && varianceOverCount > 0
                ? 'Money that was counted and signed for did not arrive, or arrived in excess of it.'
                : varianceOverCount > 0
                  ? 'Money arrived in excess of what was counted and signed for.'
                  : 'Money that was counted and signed for did not arrive.')}{' '}
            ⚠️ This is a{' '}
            <strong>custody</strong> question, not a counting one — the daily counts already
            reconciled, so the date below is where the arithmetic left the residual, not who was
            holding it.
          </div>
          {variances.map((v) => (
            <form
              key={v.id}
              action={resolveVarianceAction}
              className="flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3 dark:border-amber-900"
            >
              <input type="hidden" name="varianceId" value={v.id} />
              <input type="hidden" name="storeId" value={storeId} />
              <div className="mr-2 text-sm text-amber-900 dark:text-amber-300">
                <span className="font-mono tabular-nums">
                  {Number(v.amount) < 0 ? 'Short ' : 'Over '}
                  {peso(Math.abs(Number(v.amount)))}
                </span>
                <span className="ml-2 text-xs">on {v.businessDate}</span>
              </div>
              {/* T-366 S2/S3: a SHORTAGE is always charged to a person (Amendment A1 — there is
                  no write-off); an OVERAGE shows only the manager-confirmed recognise-as-income
                  action (S3, Q3 — never automatic at handover). T-366 S3 audit finding 5: neither
                  control renders for a viewer who does not hold accept_remittance at the page's
                  OWN store — resolveRemittanceVariance gates both actions on it, and showing the
                  form to a non-holder only to have the server refuse it is the same gap the
                  customer write-off/void section had. `canResolveVariances` is a single, page-level
                  boolean (not per-row) — see its own comment above for why that is safe here, and
                  `variancesAreStoreScoped` for the fallback if it ever were not. */}
              {!canResolveVariances || !variancesAreStoreScoped ? (
                <span className="text-xs text-amber-900 dark:text-amber-300">
                  You don&rsquo;t have permission to resolve this variance.
                </span>
              ) : Number(v.amount) < 0 ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                      Charge to
                    </span>
                    <select name="personId" defaultValue="" className={`${INPUT} w-44`}>
                      <option value="">Nobody yet…</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* R5: shown only when the handover came from more than one account — with one
                      there is nothing to choose. */}
                  {v.fromAccounts.length > 1 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                        Comes out of
                      </span>
                      <select name="fromMoneyAccountId" defaultValue="" className={`${INPUT} w-44`}>
                        <option value="">Choose an account…</option>
                        {v.fromAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                      Reason
                    </span>
                    <input name="reason" className={`${INPUT} w-48`} />
                  </label>
                  <button
                    type="submit"
                    name="action"
                    value="charge"
                    className="rounded bg-amber-700 px-3 py-2 text-xs font-medium text-white hover:bg-amber-600"
                  >
                    Charge
                  </button>
                </>
              ) : (
                <>
                  {/* R5: shown only when the handover came from more than one account. */}
                  {v.fromAccounts.length > 1 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                        Came into
                      </span>
                      <select name="fromMoneyAccountId" defaultValue="" className={`${INPUT} w-44`}>
                        <option value="">Choose an account…</option>
                        {v.fromAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                      Note (optional)
                    </span>
                    <input name="reason" className={`${INPUT} w-48`} />
                  </label>
                  <button
                    type="submit"
                    name="action"
                    value="recognise_income"
                    className="rounded bg-amber-700 px-3 py-2 text-xs font-medium text-white hover:bg-amber-600"
                  >
                    Recognise as other income (7350)
                  </button>
                </>
              )}
            </form>
          ))}
        </section>
      )}

      {/* ── Store picker ─────────────────────────────────────────────────────────────── */}
      {stores.length > 1 && (
        <form className="flex flex-wrap items-end gap-2 gap-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
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

      {/* ── The end-day reports ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">End-day reports</h2>
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            Ready to remit:{' '}
            <span className="font-mono font-medium tabular-nums">{peso(totalRemittable)}</span>
          </span>
        </div>

        {days.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing has moved through the cashier yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Cashier movement</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Still owed</th>
                  <th className="px-3 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr
                    key={d.businessDate}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">
                      {d.businessDate}
                      {!d.remittable && (
                        <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          {d.salesDayStatus ? `day ${d.salesDayStatus}` : 'no sales day'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(d.movement)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(d.allocated)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(d.owed)}</td>
                    <td className="px-3 py-2 text-xs">{STATE_LABEL[d.state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ⚠️ Named rather than hidden: a day with money in it that cannot yet be SETTLED is a
            thing somebody has to act on — verify the sales day — and silently excluding it from
            the total would leave them wondering where the money went. ⛔ Not settleable is not
            the same as not handable-over (T-324): the cash behind it can be declared as an
            overage and handed over today; only the verify-then-settle step waits. */}
        {heldBack.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {heldBack.length} day{heldBack.length === 1 ? '' : 's'} holding{' '}
            {peso(heldBack.reduce((s, d) => s + Number(d.owed), 0))} cannot be settled yet — the
            sales day has to be verified first, because that is the signed count behind it.
            {/* ⛔ Only true when the handover form below actually renders (spec §2: when every
                owing day is unverified, T-319's refusal fires first and there is nothing to
                declare an overage on yet — verifying is the only next step). */}
            {handoverFormRenders && (
              <>
                {' '}
                The cash itself can still be handed over today: declare it as an overage on the
                handover below.
              </>
            )}
          </p>
        )}
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Every figure is summed from the ledger on load, not stored — so a document type nobody
          has invented yet is already counted.
        </p>
      </section>

      {/* ── Record a handover ────────────────────────────────────────────────────────── */}
      {handoverFormRenders && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Record a handover</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              It settles the oldest days first. If it is short, the shortfall lands on the last day
              it reached — and is recorded as an open item, charged to nobody until somebody says
              who. If an account is handing over more than it moved over the settleable dates —
              cash from a day still waiting on verification, for instance — declare the overage
              beside that amount; nothing is accepted until you do. The balance shown below is
              what an account currently holds, not what it owes — holding is not owing.
            </p>
          </div>

          <form action={createRemittanceAction} className="space-y-4">
            <input type="hidden" name="storeId" value={storeId} />

            <div className="space-y-3">
              {cashier.map((a, i) => (
                <div key={a.id} className="grid gap-3 sm:grid-cols-3">
                  <input type="hidden" name="lineAccountId" value={a.id} />
                  <Field label={a.name} hint={`Holds ${peso(a.balance)}`}>
                    <input
                      name={`lineAmount_${i}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      className={INPUT}
                    />
                  </Field>
                  <Field
                    label="Declared overage"
                    hint="Only the amount over what this account moved — not a copy of the figure above"
                  >
                    <input
                      name={`lineOverage_${i}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      className={INPUT}
                    />
                  </Field>
                  {/* ⚠️ Defaults to the office account of the SAME KIND. Cash handed into a bank
                      account is a deposit, not a remittance, and letting the first office account
                      alphabetically win made "BDO — office" the default for the till. */}
                  <Field label="Lands in">
                    <select
                      name={`lineTo_${i}`}
                      defaultValue={
                        office.find((o) => o.instrument === a.instrument)?.id ?? office[0]?.id
                      }
                      className={INPUT}
                    >
                      {office.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date">
                <input
                  name="remittedOn"
                  type="date"
                  required
                  defaultValue={today()}
                  className={INPUT}
                />
              </Field>
              <Field label="Reference">
                <input name="reference" maxLength={120} className={INPUT} />
              </Field>
            </div>
            <Field label="Notes">
              <input name="notes" className={INPUT} />
            </Field>

            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Record handover
            </button>
          </form>
        </section>
      )}

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Recent handovers</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      r.status === 'reversed' ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{r.remittedOn}</td>
                    <td className="px-3 py-2">{r.reference ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.status === 'reversed' ? `Reversed — ${r.reverseReason}` : 'Posted'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === 'posted' && (
                        <form action={reverseRemittanceAction} className="flex justify-end gap-1">
                          <input type="hidden" name="remittanceId" value={r.id} />
                          <input type="hidden" name="storeId" value={storeId} />
                          <input
                            name="reason"
                            required
                            placeholder="Reason…"
                            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                          />
                          <button
                            type="submit"
                            className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                          >
                            Reverse
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Reversing writes opposite entries and un-settles the days — nothing is deleted, and the
            days simply become owed again.
          </p>
        </section>
      )}

      {/*
        ⭐ T-152 — the policy that governs everything above it, edited beside what it governs.

        ⚠️ This lives here rather than on a store-settings screen because v2 has no store-admin
        screen at all — named as a capability gap (docs/CAPABILITY-GAPS.md, 2026-08-29) rather than
        absorbed silently. Two fields beside the position they bound is right for two fields; it is
        not a pattern to repeat for the third.
      */}
      {policy && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-medium">Cash policy for {policy.name}</h2>
            <p className="max-w-2xl text-xs text-neutral-500 dark:text-neutral-500">
              How often the money is carried to the office, and how much may pile up before that
              becomes urgent. ⚠️ The till is still <strong>counted and handed over daily</strong>{' '}
              whatever this says — that is the control, and it is not what this changes.
            </p>
          </div>
          <form action={setCashPolicyAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="storeId" value={storeId} />
            {/* ⚠️ Both fields carry a hint so the control row lines up. With only one hinted, the
                select and the text input sat at different heights under `items-end`. */}
            <Field label="Remittance cadence" hint="How often the money is carried in.">
              <select
                name="remittanceCadence"
                defaultValue={policy.remittanceCadence}
                className={`${INPUT} w-44`}
              >
                {Object.entries(CADENCE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Un-remitted ceiling"
              hint="Required for any cadence but daily. Leave blank only when remitting daily."
            >
              <input
                name="unremittedCeiling"
                inputMode="decimal"
                defaultValue={policy.unremittedCeiling ?? ''}
                placeholder="e.g. 20000.00"
                className={`${INPUT} w-44`}
              />
            </Field>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Save policy
            </button>
          </form>
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Crossing the ceiling never blocks a sale or a handover — it raises a finding at the top
            of this page. The peso figure is business policy and belongs to whoever carries the
            risk.
          </p>
        </section>
      )}
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
