import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '../../../../lib/page-access';
import { daypartsForStore, posModeFor, storeDetail } from '../lib';
import { DaypartsSection } from '../../../menu/DaypartsSection';
import {
  deactivateStoreAction,
  reactivateStoreAction,
  setStoreOpeningDateAction,
  setStorePosModeAction,
  setStoreStockModelAction,
  updateStoreAction,
} from '../actions';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { ADMIN_STORE_DETAILS_RULES, ADMIN_STORE_OPENING_DATE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, ConfirmDestructive, DisclosureCard, FlashBanner, FormGrid, Field, Input, Textarea } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { STORE_DETAILS, STORE_OPENING_DATE, STORE_POS_MODE, STORE_STOCK_MODEL } from '../typed-forms';
import { PosModeForm } from './PosModeForm';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { formatBusinessDateTime, formatBusinessDayLong } from '@shareat/core/datetime';
import { countOf } from '@shareat/core/sentence';

export const metadata = { title: 'Store — Shareat System' };
export const dynamic = 'force-dynamic';

/** T-587 S4: what the stored values mean, in words. A value the maps do not know is shown as it is. */
const STOCK_WORDS: Record<string, string> = { single_room: 'One room', multi_room: 'Several rooms' };
const CASH_WORDS: Record<string, string> = { daily: 'Cash remitted daily', every_3_days: 'Cash remitted every 3 days', weekly: 'Cash remitted weekly', monthly: 'Cash remitted monthly' };
const CARD = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';
/** T-599 S1: a settings link is a full-width row; the chevron is drawn by CSS so the link text stays plain words. */
const SECTION_LINK = "flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 text-sm font-semibold text-ink hover:bg-canvas after:text-neutral-500 after:content-['›']";

/** One saved value, or "Not set" in muted text. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  const text = value?.trim();
  return (
    <>
      <dt className="text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className={text ? 'whitespace-pre-line' : 'text-muted italic'}>{text || 'Not set'}</dd>
    </>
  );
}

/**
 * T-222 — one store, its cash-custody policy, and the readiness checklist.
 *
 * ⭐ **The checklist is computed on read from the live tables. Nothing about readiness is stored**,
 * and that is bible row 123's lesson rather than a style preference: v1's OIL layer stored `state`
 * per finding, so resolving one suppressed tomorrow's recompute *while the condition still held*. A
 * stored "store is ready" flag is the same defect — someone ticks it, the sales channel is later
 * deleted, and the store reports ready forever.
 */
export default async function StoreDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string; confirm?: string; plan?: string; openingDate?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/admin/stores/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const detail = await storeDetail(actor, id);
  if (!detail) notFound();

  const { store, readiness } = detail;

  // ⭐ A manager can reach this URL — the nav link is not gated per-role and the list page is a
  // plain read. Before this, `storeReadiness`'s `authorize()` threw and they got an HTTP 500; the
  // T-222 smoketest is what caught it. A refusal is a sentence, never a stack trace.
  if (!readiness) {
    return (
      <Page view="detail" sectioned density="table" className="space-y-4">
        <Link href="/admin/stores" className="text-sm underline underline-offset-2">
          ← Stores
        </Link>
        <h1 className="text-2xl font-semibold">
          {store.code} — {store.name}
        </h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Only an admin or super-admin can open or close a store. You can see this store in the
          list, but its readiness checklist and settings are not yours to read or change.
        </p>
      </Page>
    );
  }

  const blocking = readiness.filter((c) => !c.ok && c.blocking);
  const hours = await daypartsForStore(actor, id);
  const pos = await posModeFor(actor, id);
  const posTyped = typedFor(sp, STORE_POS_MODE, store.id, actor.personId);
  const posTypedFields = posTyped?.kind === 'typed' ? posTyped.fields : {};
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const niceDay = formatBusinessDayLong;
  const failing = readiness.filter((c) => !c.ok).length;

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href="/admin/stores" className="text-sm underline underline-offset-2">
          ← Stores
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {store.code} — {store.name}
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {store.isActive ? 'Active' : 'Inactive'} · {STOCK_WORDS[store.stockModel] ?? store.stockModel} · {CASH_WORDS[store.remittanceCadence] ?? store.remittanceCadence}
          {store.unremittedCeiling ? ` · Cash on hand limit ₱${store.unremittedCeiling}` : ''}
        </p>
      </div>

      <FlashBanner flash={sp} />

      {blocking.length > 0 && (
        <Banner tone="warning">
          <strong>
            {countOf(blocking.length, 'thing')} still {blocking.length === 1 ? 'stops' : 'stop'} this store working.
          </strong>{' '}
          {blocking.length === 1 ? 'It is' : 'They are'} listed below.
        </Banner>
      )}

      {/* T-599 S1: on a phone one column in reading order (the `order-*` classes work through the `contents` wrappers); from lg, main 2/3 and side 1/3. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:items-start xl:gap-4">
        <div className="contents lg:col-span-2 lg:block lg:min-w-0 lg:space-y-4">
        <section className={`${CARD} order-1 lg:order-none`}>
          <h2 className="text-sm font-medium">Readiness</h2>
          {/* Closed when every check passes; open, with the count, when one does not. */}
          <details open={failing > 0} className="group">
            <summary className="flex min-h-11 w-full cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span>{failing === 0 ? 'Ready ✓' : `${countOf(failing, 'thing')} ${failing === 1 ? 'needs' : 'need'} attention`}</span>
              {failing === 0 && <span className="font-normal text-muted group-open:hidden">· Show the checks</span>}
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="ml-auto h-4 w-4 shrink-0 text-neutral-500 transition-transform group-open:rotate-90">
                <path d="M7 5l5 5-5 5" />
              </svg>
            </summary>
            <ul className="space-y-3 pt-1">
              {readiness.map((c) => (
                <li key={c.key} className="text-sm">
                  <div className="flex items-start gap-2">
                    <span className={c.ok ? 'text-success' : 'text-warning-ink'}>
                      {c.ok ? '✓' : '⚠'}
                    </span>
                    <div>
                      <div className="font-medium">
                        {c.label}
                        {!c.ok && <span className="ml-2 text-xs font-normal text-warning-ink">— needs attention</span>}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">{c.detail}</div>
                      {/* ⭐ T-243 / DEF-216 — one generic renderer replaces what T-230 and T-229
                          slice 3 each hand-wired for their own check. `remedy` is absent for a check
                          (`adminScope`) that no single screen clears. */}
                      {!c.ok && c.remedy && (
                        <Link href={c.remedy.href} className={ACTION_LINK}>
                          {c.remedy.label}
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </section>

        <section className={`${CARD} order-3 lg:order-none`}>
          <h2 className="text-sm font-medium">About this store</h2>
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <Row label="Name" value={store.name} />
              <Row label="Trading address" value={store.address} />
              <Row label="Contact number" value={store.contactNumber} />
              <Row label="TIN branch code" value={store.tinBranchCode} />
              <Row label="Timezone" value={store.timezone} />
            </dl>
            <EditableRecord action={updateStoreAction} label={store.name} hidden={{ storeId: store.id }} typed={typedFor(sp, STORE_DETAILS, store.id, actor.personId)} rules={ADMIN_STORE_DETAILS_RULES}>
              <FormGrid className="text-sm">
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Name</span>} rule={ADMIN_STORE_DETAILS_RULES.name}>
                  <Input {...nativeAttrs(ADMIN_STORE_DETAILS_RULES.name)} defaultValue={store.name} className="mt-1 w-full" />
                </Field>
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Timezone</span>}>
                  <Input name="timezone" defaultValue={store.timezone} className="mt-1 w-full" />
                </Field>
                {/* ⭐ T-229 slice 4 / DEF-208 — what a document printed for THIS BRANCH carries. The
                    registered name, the TIN and the tax type belong to the organisation and are set
                    once, on /settings/organization: in PH a corporation holds one TIN and each branch
                    carries a code against it, so duplicating the number per store (as v1 did) is one
                    number in N places to go wrong. */}
                <Field span="full" label={<span className="text-neutral-600 dark:text-neutral-400">Trading address</span>}>
                  <Textarea name="address" defaultValue={store.address ?? ''} rows={2} className="mt-1 w-full" />
                </Field>
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Contact number</span>}>
                  <Input name="contactNumber" defaultValue={store.contactNumber ?? ''} className="mt-1 w-full" />
                </Field>
                <Field
                  label={
                    <span className="text-neutral-600 dark:text-neutral-400">
                      TIN branch code <span className="text-neutral-500 dark:text-neutral-400">— digits, e.g. 00001</span>
                    </span>
                  }
                  rule={ADMIN_STORE_DETAILS_RULES.tinBranchCode}
                >
                  <Input {...nativeAttrs(ADMIN_STORE_DETAILS_RULES.tinBranchCode)} defaultValue={store.tinBranchCode ?? ''} className="mt-1 w-full tabular-nums" />
                </Field>
              </FormGrid>
              <p className="mt-3 text-xs text-neutral-500">
                The store code (<code>{store.code}</code>) cannot be changed, and the registered name and TIN are{' '}
                <Link href="/settings/organization" className="underline underline-offset-2">
                  set once for the whole business
                </Link>
                .
              </p>
            </EditableRecord>
          </div>
          <div className="space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          {/**
            * ⭐ T-346 S1 (DEF-428). Its own form, not a field on Details above — same reasoning as
            * `stock_model` below: `setStoreOpeningDate` carries a refusal (has this store already
            * traded?) a general "save details" call should not have to know about.
            *
            * ⭐ T-346 S2 (DEF-427), §3.2 step 3 / R4.5. Moving the date can cascade a reversal
            * across every `'store_opening'`-sourced follower asset — `setStoreOpeningDate` plans
            * that and refuses once (naming every affected asset) unless confirmed. `sp.confirm`
            * is that refusal's OWN message, shown verbatim as an in-page step — never
            * `window.confirm()` — with a resubmit that carries the plan token as `confirmedPlan`.
            */}
            {/* T-599 S1: with a date saved, the EditableRecord below is the read view. With none, a one-line row says so and the "Set" disclosure holds the add form. */}
            {store.openingDate === null && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
                <dt className="text-neutral-600 dark:text-neutral-400">Opening date</dt>
                <dd className="text-muted italic">Not opened yet</dd>
              </dl>
            )}
            {store.openingDate !== null && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
                <Row label="Opening date" value={formatBusinessDayLong(store.openingDate)} />
              </dl>
            )}
            {sp.confirm && (
              <Banner tone="warning">{sp.confirm}</Banner>
            )}
            {/* The confirm step is a COMMAND, not an edit: the date to save rides in a hidden input
                (`??`-style: `sp.openingDate` is `''` for a DELIBERATELY CLEARED date and must stay `''`),
                and clicking "Confirm and save" IS the confirmation. ⛔ A hidden input, not a checkbox - a
                checkbox's native box is unresolvable-by-construction for the touch-target sweep
                (Ian's ruling §6.1, T-262). The helper drops the refill whole when the cookie is over
                budget (never shortens it); then the locked form below carries the plan instead. */}
            {sp.confirm && sp.openingDate !== undefined ? (
              <form action={setStoreOpeningDateAction} className="space-y-3 text-sm">
                <input type="hidden" name="storeId" value={store.id} />
                <input type="hidden" name="openingDate" value={sp.openingDate} />
                <input type="hidden" name="confirmedPlan" value={sp.plan ?? ''} />
                <p className="text-neutral-600 dark:text-neutral-400">
                  Opening date to save: <strong>{sp.openingDate === '' ? 'blank (not opened)' : formatBusinessDayLong(sp.openingDate)}</strong>
                </p>
                <Button type="submit" variant="primary">
                  Confirm change
                </Button>
              </form>
            ) : (
              <>
                {sp.confirm && (
                  <p className="text-xs text-neutral-500">
                    The date you typed could not be carried over. Enter it again before you confirm.
                  </p>
                )}
                {store.openingDate !== null ? (
                <EditableRecord
                  action={setStoreOpeningDateAction}
                  label="opening date"
                  hidden={{ storeId: store.id, ...(sp.confirm ? { confirmedPlan: sp.plan ?? '' } : {}) }}
                  typed={typedFor(sp, STORE_OPENING_DATE, store.id, actor.personId)}
                  rules={ADMIN_STORE_OPENING_DATE_RULES}
                >
                  <FormGrid className="text-sm">
                    <Field
                      label={<span className="text-neutral-600 dark:text-neutral-400">Opening date</span>}
                      hint="Leave blank if it has not opened. The first day this store trades."
                      rule={ADMIN_STORE_OPENING_DATE_RULES.openingDate}
                    >
                      <Input type="date" {...nativeAttrs(ADMIN_STORE_OPENING_DATE_RULES.openingDate)} defaultValue={sp.openingDate ?? store.openingDate ?? ''} className="mt-1 w-full" />
                    </Field>
                  </FormGrid>
                </EditableRecord> 
                ) : (
                  /* No date saved yet: an ADD, folded into "Set the opening date"; it opens by itself on a confirm step or a typed refill. */
                  <DisclosureCard id="opening-date" title="Set the opening date" action="Set" open={Boolean(sp.confirm) || typedFor(sp, STORE_OPENING_DATE, store.id, actor.personId) !== null}>
                  <CheckedForm rules={ADMIN_STORE_OPENING_DATE_RULES} action={setStoreOpeningDateAction} className="space-y-3">
                    <input type="hidden" name="storeId" value={store.id} />
                    {sp.confirm ? <input type="hidden" name="confirmedPlan" value={sp.plan ?? ''} /> : null}
                    <FormGrid className="text-sm">
                    <Field
                      label={<span className="text-neutral-600 dark:text-neutral-400">Opening date</span>}
                      hint="Leave blank if it has not opened. The first day this store trades."
                      rule={ADMIN_STORE_OPENING_DATE_RULES.openingDate}
                    >
                      <Input type="date" {...nativeAttrs(ADMIN_STORE_OPENING_DATE_RULES.openingDate)} defaultValue={sp.openingDate ?? store.openingDate ?? ''} className="mt-1 w-full" />
                    </Field>
                  </FormGrid>
                    <Button type="submit" variant="secondary">
                      Save
                    </Button>
                  </CheckedForm>
                  </DisclosureCard>
                )}
              </>
            )}
          </div>
          <div className="space-y-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          {/**
            * ⭐ T-284 / DEF-316 — Ian: *"shareat lipa needs more than 1 storage room, i can not
            * edit the store."* `stores.stock_model` was created by migration `0062` and has had
            * NO writer of any kind since; every store sat on the default `single_room` with no
            * path off it. This is that path.
            *
            * ⛔ Its own form, not a field on Details above, because narrowing to single-room runs
            * a room-count pre-flight the database does not have on this side (DEF-316) — folding
            * it in would route the column past that check.
            */}
            <h3 className="text-sm font-medium">How this store keeps stock</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
              <Row label="Stock is kept in" value={STOCK_WORDS[store.stockModel] ?? store.stockModel} />
            </dl>
            <EditableRecord action={setStoreStockModelAction} label="stock model" hidden={{ storeId: store.id }} typed={typedFor(sp, STORE_STOCK_MODEL, store.id, actor.personId)}>
            <div className="space-y-3">
            <p className="text-xs text-neutral-500">
              A Receiving room never counts here, because every store needs somewhere to put a delivery.
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
              <input
                type="radio"
                name="stockModel"
                value="single_room"
                defaultChecked={store.stockModel === 'single_room'}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">One room</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  For a kiosk or small store that keeps all its stock in one place.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
              <input
                type="radio"
                name="stockModel"
                value="multi_room"
                defaultChecked={store.stockModel === 'multi_room'}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">Several rooms</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  For a commissary, or a store with a separate stockroom and kitchen. After saving, add the rooms under Inventory / Locations.
                  {/* ⚠️ Named, not linked. An inline <Link> inside `text-xs` help text models at
                      16px against T-262's 24px touch-target floor, and `action-link-sweep`
                      counted it as a NEW FAIL — a real undersized control, not a bookkeeping
                      gap. Baselining it would have accepted an accessibility defect to save a
                      sentence; the success banner after saving names the destination anyway. */}
                </span>
              </span>
            </label>

            <p className="text-xs text-neutral-500">
              To go back to one room, first deactivate or merge the extra rooms. Receiving does not count.
            </p>

            </div>
            </EditableRecord>
          </div>
        </section>
        </div>

        <div className="contents lg:block lg:min-w-0 lg:space-y-4">
          {/**
            * ⭐ T-533 S1 — which POS owns this store's sales days. `off` and `test` book nothing; `live` from a date means the new POS closes the day and the v1 day
            * feed stops from that date. Admin and super-admin only (the page itself is `manage_stores`; `setStorePosMode` checks the role again).
            */}
          <section className={`${CARD} order-2 lg:order-none`}>
            <h2 className="text-sm font-medium">New POS</h2>
            <p className="text-sm">
              Mode: <strong>{pos.mode === 'live' && pos.liveFrom ? `Live from ${niceDay(pos.liveFrom)}` : pos.mode === 'test' ? 'Test' : 'Off'}</strong>
            </p>
            <p className="text-xs text-neutral-500">
              {pos.changedAt ? `Last changed by ${pos.changedByName ?? 'someone'} on ${formatBusinessDateTime(pos.changedAt, { dateStyle: 'long', timeStyle: 'short' })}.` : 'Never switched on for this store.'}
            </p>
            <p className="text-sm">
              Pre-flight:{' '}
              {pos.preflight.blocking.length === 0
                ? 'nothing blocks going live'
                : `${pos.preflight.blocking.length} thing${pos.preflight.blocking.length === 1 ? '' : 's'} block${pos.preflight.blocking.length === 1 ? 's' : ''} going live`}
              {pos.preflight.warnings.length > 0 ? `, ${pos.preflight.warnings.length} warning${pos.preflight.warnings.length === 1 ? '' : 's'}` : ''}.{' '}
              <Link href={`/admin/stores/${id}/pos-preflight`} className={ACTION_LINK}>
                See the pre-flight list →
              </Link>
            </p>
            {sp.needsConfirmation && posTyped?.kind === 'typed' ? (
              <form action={setStorePosModeAction} className="space-y-3 text-sm">
                <input type="hidden" name="storeId" value={store.id} />
                <input type="hidden" name="mode" value={one(posTypedFields.mode) ?? ''} />
                <input type="hidden" name="liveFrom" value={one(posTypedFields.liveFrom) ?? ''} />
                <input type="hidden" name="reason" value={one(posTypedFields.reason) ?? ''} />
                <Banner tone="warning">{sp.needsConfirmation}</Banner>
                <p className="text-neutral-600 dark:text-neutral-400">Reason: {one(posTypedFields.reason)}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <SubmitButton variant="primary" pendingLabel="Switching…" icon={null}>
                    Confirm and switch
                  </SubmitButton>
                  <Link href={`/admin/stores/${id}`} className={ACTION_LINK}>
                    Cancel
                  </Link>
                </div>
              </form>
            ) : (
              <PosModeForm storeId={store.id} storeName={store.name} currentMode={pos.mode} today={pos.today} typed={posTyped} />
            )}
          </section>

          <section className={`${CARD} order-4 lg:order-none`}>
            <h2 className="text-sm font-medium">Store settings</h2>
            <nav aria-label="Store settings" className="-mx-2">
              <ul>
                <li><Link href={`/kitchen?store=${id}`} className={SECTION_LINK}>Kitchen stations</Link></li>
                <li><Link href={`/menu/hours?store=${id}`} className={SECTION_LINK}>Menu hours</Link></li>
                <li><Link href={`/settings/sales-channels?store=${id}`} className={SECTION_LINK}>Sales channels and payouts</Link></li>
                <li><Link href={`/settings/pos-link?store=${id}`} className={SECTION_LINK}>Link to POS store</Link></li>
                <li><Link href={`/remittance?store=${id}`} className={SECTION_LINK}>Cash settings</Link></li>
              </ul>
            </nav>
          </section>

          <div className="order-5 lg:order-none">
            <DaypartsSection storeId={store.id} dayparts={hours.dayparts} canManage={hours.canManage} />
          </div>
        </div>
      </div>

      {store.isActive ? (
        <form
          action={deactivateStoreAction}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input type="hidden" name="storeId" value={store.id} />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-medium">Close this store</h2>
            <p className="text-xs text-neutral-500">
              Closing never deletes anything. Its journal entries, attendance and stock stay.
            </p>
          </div>
          <ConfirmDestructive
            tier="retype"
            label="Close this store"
            showLabel
            consequence="Closes this store. Nothing is deleted, but it stops trading until someone reopens it."
            expectedName={store.name}
          />
        </form>
      ) : (
        <form
          action={reactivateStoreAction}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input type="hidden" name="storeId" value={store.id} />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-medium">Reopen this store</h2>
            <p className="text-xs text-neutral-500">
              Reopening gives every admin access to this store again, including any admin added while it was closed.
            </p>
          </div>
          <Button type="submit" variant="secondary">
            Reactivate
          </Button>
        </form>
      )}
    </Page>
  );
}
