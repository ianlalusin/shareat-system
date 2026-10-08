import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SHORTAGE_REASONS } from '@shareat/db/schema';
import { compareQuantity, quantity, ZERO_QUANTITY } from '@shareat/domain';
import { requireSession } from '../../../../lib/session';
import {
  acceptOrderAction,
  addLineAction,
  decideLineAction,
  dispatchOrderAction,
  fulfilLineAction,
  markReadyAction,
  postMessageAction,
  proposeLineAction,
  receiveOrderAction,
  rejectOrderAction,
  removeLineAction,
  submitOrderAction,
  updateLineAction,
  withdrawOrderAction,
} from './actions';
import { BRANCH_ORDER_STAGE_LABEL, actorStoreIds, orderView, peso, today, type OrderView } from '../lib';
import { Page } from '@/components/shell/Page';
import { EditableRecord } from '@/components/forms';
import { FormGrid } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Branch order — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const BTN_SECONDARY =
  'rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_DANGER =
  'rounded-md border border-red-300 px-4 py-2.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950';
const LABEL = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';
const PANEL = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';

const REASON_LABEL: Record<string, string> = {
  not_received: 'Not received',
  supplier_short: 'Packed short',
  damaged_in_transit: 'Damaged in transit',
  damaged_on_arrival: 'Damaged on arrival',
  quality_reject: 'Quality reject',
  count_correction: 'Count correction',
  other: 'Other',
};

function when(d: Date | null): string {
  return d ? new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
}

export default async function BranchOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/commissary/orders/${id}`);
  const [view, scope] = await Promise.all([orderView(actor.orgId, id), actorStoreIds(actor)]);
  if (!view) notFound();
  const { order, stage, lines, commissary, branch, rooms, catalogue, items, messages, authors, pendingCount } = view;

  // ⚠️ Which SIDE(S) this person may act for decides what is shown — the domain decides what is
  // allowed, against the same scope rows, on every action. An admin holding both sees both.
  const branchSide = scope.includes(order.requestedByStoreId);
  const commissarySide = scope.includes(order.storeId);

  const draft = stage === 'draft';
  const packing = stage === 'accepted' || stage === 'ready';
  const receiving = stage === 'dispatched' && branchSide;
  const goods = lines.filter((l) => l.approval === 'not_required' || l.approval === 'approved');

  return (
    <Page density="table">
      <div>
        <Link href={`/commissary/orders?store=${branchSide ? branch.id : commissary.id}`} className="text-sm underline underline-offset-4">
          ← Branch orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {commissary.name} → {branch.name}
        </h1>
        <PageDescription className="mt-1">
          {order.orderDate} · <strong>{BRANCH_ORDER_STAGE_LABEL[stage]}</strong> · {peso(order.totalAmount)}
          {order.referenceNo && <> · ref {order.referenceNo}</>}
        </PageDescription>
        {order.notes && <p className="mt-1 text-xs text-neutral-500">{order.notes}</p>}
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          You are on this order as{' '}
          {branchSide && commissarySide
            ? 'both stores'
            : branchSide
              ? `the branch (${branch.name})`
              : commissarySide
                ? `the commissary (${commissary.name})`
                : 'neither store — read-only'}
          .
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      {/* ---- The lines ------------------------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Lines</h2>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Asked → packed → signed for. The gap between the first two is a fulfilment decision; between
            the last two, a transit discrepancy.
          </span>
        </div>
        {lines.length === 0 && <p className="text-sm text-neutral-500">Nothing on this order yet.</p>}

        {receiving ? (
          <form action={receiveOrderAction} className="space-y-3">
            <input type="hidden" name="orderId" value={order.id} />
            {lines.map((l) => (
              <LineCard key={l.id} line={l} view={view} branchSide={branchSide} commissarySide={commissarySide} receiving />
            ))}
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="grow">
                <h3 className="font-medium">Confirm receipt</h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Sign for what actually landed, per line. ⭐ This is the event where BOTH stores&rsquo; books move —
                  your stock arrives at the transfer price, the commissary&rsquo;s in-transit is relieved at cost, and
                  any shortfall opens a transit discrepancy for the commissary to dispose of.
                </p>
              </div>
              <label className={LABEL}>
                Received on
                <input name="receivedOn" type="date" defaultValue={today()} className={INPUT} />
              </label>
              <button type="submit" className={BTN}>
                Receive
              </button>
            </div>
          </form>
        ) : (
          lines.map((l) => (
            <LineCard key={l.id} line={l} view={view} branchSide={branchSide} commissarySide={commissarySide} receiving={false} />
          ))
        )}

        {lines.length > 0 && (
          <p className="text-right text-sm">
            <span className="text-neutral-500">Total (counted lines only)</span>{' '}
            <span className="font-mono tabular-nums">{peso(order.totalAmount)}</span>
            {pendingCount > 0 && (
              <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                {pendingCount} proposed line{pendingCount === 1 ? '' : 's'} not counted until the branch answers
              </span>
            )}
          </p>
        )}
      </section>

      {/* ---- The branch's controls ------------------------------------------------------------ */}
      {draft && branchSide && (
        <section className={PANEL}>
          <h2 className="font-medium">Add a line</h2>
          <form action={addLineAction} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_7rem_9rem_auto] sm:items-end">
            <input type="hidden" name="orderId" value={order.id} />
            <label className={`${LABEL} col-span-2 sm:col-span-1`}>
              Item (the commissary&rsquo;s catalogue)
              <select name="itemId" required defaultValue="" className={INPUT}>
                <option value="">— pick —</option>
                {catalogue.map((c) => (
                  <option key={c.commissaryItemId} value={c.commissaryItemId}>
                    {c.name} ({c.baseUnit}){c.priced ? ` — ₱${c.price}` : ' — no price, state one'}
                    {c.blocker ? ` — ⚠ ${c.blocker}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Quantity
              <input name="quantity" required inputMode="decimal" placeholder="0.000" className={`${INPUT} tabular-nums`} />
            </label>
            <label className={LABEL}>
              Rate ₱ (blank = default)
              <input name="rate" inputMode="decimal" className={`${INPUT} tabular-nums`} />
            </label>
            <button type="submit" className={BTN_SECONDARY}>
              Save
            </button>
          </form>
          <div className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <form action={submitOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <button type="submit" className={BTN}>
                Submit to {commissary.name}
              </button>
            </form>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Submit is refused while any line is unmapped or has no expense category — fix those under{' '}
              <Link href={`/commissary/catalogue?commissary=${commissary.id}&branch=${branch.id}`} className="underline underline-offset-4">
                Commissary catalogue
              </Link>
              . After submit the ask is frozen.
            </span>
          </div>
        </section>
      )}

      {/* ---- The commissary's controls -------------------------------------------------------- */}
      {stage === 'submitted' && commissarySide && (
        <section className={PANEL}>
          <h2 className="font-medium">Accept this order?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Accepting copies every asked quantity into the packing list; you adjust from there. Nothing posts.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <form action={acceptOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <button type="submit" className={BTN}>
                Accept
              </button>
            </form>
            <RejectForm orderId={order.id} />
          </div>
        </section>
      )}

      {stage === 'accepted' && commissarySide && (
        <section className={PANEL}>
          <h2 className="font-medium">Propose a substitution or an addition</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Out of something? Set that line to 0 (or pick it as &ldquo;replaces&rdquo; here) and propose what you can send.
            A proposed line counts toward nothing until the branch approves it, and the order cannot be marked ready
            until they answer — the reason goes on the thread.
          </p>
          <form action={proposeLineAction} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 sm:items-end">
            <input type="hidden" name="orderId" value={order.id} />
            <label className={`${LABEL} col-span-2 sm:col-span-1`}>
              Item
              <select name="itemId" required defaultValue="" className={INPUT}>
                <option value="">— pick —</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.baseUnit})
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Quantity
              <input name="quantity" required inputMode="decimal" className={`${INPUT} tabular-nums`} />
            </label>
            <label className={LABEL}>
              Rate ₱ (blank = default)
              <input name="rate" inputMode="decimal" className={`${INPUT} tabular-nums`} />
            </label>
            <label className={LABEL}>
              From room
              <select name="sourceLocationId" defaultValue="" className={INPUT}>
                <option value="">default room</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Replaces (optional)
              <select name="replacesLineId" defaultValue="" className={INPUT}>
                <option value="">nothing — an addition</option>
                {lines
                  .filter((l) => l.origin === 'requested')
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.itemName}
                    </option>
                  ))}
              </select>
            </label>
            <label className={`${LABEL} col-span-2 sm:col-span-1`}>
              Why (goes on the thread)
              <input name="note" className={INPUT} />
            </label>
            <button type="submit" className={`${BTN_SECONDARY} col-span-2 sm:col-span-1`}>
              Propose
            </button>
          </form>
        </section>
      )}

      {packing && commissarySide && (
        <section className={PANEL}>
          <div className="flex flex-wrap items-end gap-3">
            {stage === 'accepted' && (
              <form action={markReadyAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button type="submit" className={BTN}>
                  Mark ready
                </button>
              </form>
            )}
            {stage === 'ready' && (
              <form action={dispatchOrderAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button type="submit" className={BTN}>
                  Dispatch
                </button>
              </form>
            )}
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {stage === 'accepted'
                ? 'Ready means the list is final — after it the order can only be dispatched or rejected.'
                : 'Dispatch is the posting event: stock leaves into in-transit (1340) at real FIFO cost — manager or admin only. It is refused if the commissary holds less than a line says, or has never tracked the item at all.'}
            </span>
            <RejectForm orderId={order.id} />
          </div>
        </section>
      )}

      {/* ---- Withdraw / void ------------------------------------------------------------------ */}
      {((draft || stage === 'submitted' || packing) && (branchSide || commissarySide)) && (
        <form action={withdrawOrderAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="orderId" value={order.id} />
          <label className={`${LABEL} min-w-[14rem] flex-1`}>
            {branchSide ? 'Withdraw this order — say why' : 'Cancel this order — say why'}
            <input name="reason" required placeholder="reason" className={`${INPUT} w-full`} />
          </label>
          <button type="submit" className={BTN_DANGER}>
            {branchSide ? 'Withdraw' : 'Cancel order'}
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Nothing has moved; nothing posts.</span>
        </form>
      )}
      {stage === 'dispatched' && commissarySide && !receiving && (
        <form action={withdrawOrderAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="orderId" value={order.id} />
          <label className={`${LABEL} min-w-[14rem] flex-1`}>
            Void the dispatch — say why
            <input name="reason" required placeholder="truck never left" className={`${INPUT} w-full`} />
          </label>
          <button type="submit" className={BTN_DANGER}>
            Void dispatch
          </button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            The in-transit posting is <strong>reversed</strong>, never deleted, and the stock returns to its layers.
          </span>
        </form>
      )}

      {/* ---- The facts ------------------------------------------------------------------------ */}
      {(stage === 'dispatched' || stage === 'received' || stage === 'rejected' || stage === 'cancelled' || order.acceptedAt) && (
        <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-400">
          <dt className="text-neutral-400">Accepted</dt>
          <dd>{when(order.acceptedAt)}</dd>
          <dt className="text-neutral-400">Ready</dt>
          <dd>{when(order.readyAt)}</dd>
          <dt className="text-neutral-400">Dispatched</dt>
          <dd>{when(order.dispatchedAt)}</dd>
          <dt className="text-neutral-400">Received</dt>
          <dd>{when(order.receivedAt)}</dd>
          {order.journalEntryId && (
            <>
              <dt className="text-neutral-400">Dispatch entry</dt>
              <dd className="font-mono">{order.journalEntryId}</dd>
            </>
          )}
          {stage === 'rejected' && (
            <>
              <dt className="text-neutral-400">Rejected</dt>
              <dd>
                {when(order.rejectedAt)} — {order.rejectReason}
              </dd>
            </>
          )}
          {stage === 'cancelled' && (
            <>
              <dt className="text-neutral-400">Cancelled</dt>
              <dd>
                {when(order.voidedAt)} — {order.voidReason}
              </dd>
            </>
          )}
        </dl>
      )}

      {/* ---- The thread (T-175) --------------------------------------------------------------- */}
      <section>
        <h2 className="text-lg font-medium">Thread</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Append-only. In v1 this was a phone call, so the reason a line changed did not survive the
          people who changed it. Proposals, decisions and rejections are written here automatically.
        </p>
        <ul className="mt-4 space-y-3">
          {messages.length === 0 && <li className="text-sm text-neutral-500">Nothing said about this order yet.</li>}
          {messages.map((m) => (
            <li key={m.id} className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <div className="text-xs text-neutral-500">
                {authors.get(m.authorId) ?? 'Someone'} · {new Date(m.createdAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
        <form action={postMessageAction} className="mt-4 flex gap-2">
          <input type="hidden" name="orderId" value={order.id} />
          <input name="body" placeholder="Say something about this order…" className={`${INPUT} flex-1`} />
          <button type="submit" className={BTN_SECONDARY}>
            Post
          </button>
        </form>
      </section>

      {goods.length === 0 && lines.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Nothing on this order counts yet.</p>
      )}
    </Page>
  );
}

function RejectForm({ orderId }: { orderId: string }) {
  return (
    <form action={rejectOrderAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <label className={`${LABEL} min-w-[14rem] flex-1`}>
        Reject — say why
        <input name="reason" required placeholder="the branch reads this" className={`${INPUT} w-full`} />
      </label>
      <button type="submit" className={BTN_DANGER}>
        Reject
      </button>
    </form>
  );
}

/**
 * One line, as a card — phone-portrait first (memory: the APK canvas), and because each editable
 * line is its own <form>, which a table cell cannot legally hold.
 */
function LineCard({
  line: l,
  view,
  branchSide,
  commissarySide,
  receiving,
}: {
  line: OrderView['lines'][number];
  view: OrderView;
  branchSide: boolean;
  commissarySide: boolean;
  receiving: boolean;
}) {
  const { order, stage, rooms } = view;
  const packed = l.fulfilledQuantity ?? null;
  const declined = l.approval === 'rejected';
  const pending = l.approval === 'pending';
  const editAsk = stage === 'draft' && branchSide;
  const editPack = stage === 'accepted' && commissarySide && !declined;

  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        declined
          ? 'border-neutral-200 opacity-60 dark:border-neutral-800'
          : pending
            ? 'border-amber-300 dark:border-amber-800'
            : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <Link href={`/items/${l.itemId}`} className="font-medium underline underline-offset-4">
          {l.itemName}
        </Link>
        <span className="font-mono text-xs text-neutral-500">{l.itemCode}</span>
        {l.origin === 'commissary_added' && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
            proposed by the commissary ·{' '}
            {pending ? 'awaiting the branch' : l.approval === 'approved' ? 'approved' : 'declined'}
          </span>
        )}
        {l.isLedgerOnly && <span className="text-xs text-neutral-500">ledger-only — moves no branch stock</span>}
        {l.suggestedQuantity && <span className="text-xs text-neutral-500">auto-suggested {l.suggestedQuantity}</span>}
        {packed !== null && Number(packed) === 0 && !declined && (
          <span className="text-xs text-red-700 dark:text-red-400">none of this will be sent</span>
        )}
      </div>

      {/* THREE quantities, and collapsing any two loses the story. */}
      <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs sm:grid-cols-6">
        <dt className="text-neutral-400">Asked</dt>
        <dd className="tabular-nums">{l.requestedQuantity ? `${l.requestedQuantity} ${l.unit}` : '—'}</dd>
        <dt className="text-neutral-400">Packed</dt>
        <dd className="tabular-nums">{packed !== null ? `${packed} ${l.unit}` : '—'}</dd>
        <dt className="text-neutral-400">Signed for</dt>
        <dd className="tabular-nums">{l.receivedQuantity ? `${l.receivedQuantity} ${l.unit}` : '—'}</dd>
        <dt className="text-neutral-400">Rate</dt>
        <dd className="font-mono tabular-nums">{peso(l.rate)}</dd>
        <dt className="text-neutral-400">Room</dt>
        <dd>{l.roomName ?? (l.sourceLocationId ? l.sourceLocationId : 'default')}</dd>
        <dt className="text-neutral-400">Total</dt>
        <dd className="font-mono tabular-nums">{peso(l.lineTotal)}</dd>
        {l.dispatchCost && (
          <>
            <dt className="text-neutral-400">At cost</dt>
            <dd className="font-mono tabular-nums text-neutral-500">{peso(l.dispatchCost)}</dd>
          </>
        )}
      </dl>

      {editAsk && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <EditableRecord action={updateLineAction} label={`${l.itemName} line`} hidden={{ orderId: order.id, lineId: l.id }}>
              <FormGrid>
                <label className={`${LABEL} min-w-0`}>
                  Quantity ({l.unit})
                  <input name="quantity" inputMode="decimal" defaultValue={l.requestedQuantity ?? l.quantity} className={`${INPUT} w-full tabular-nums`} />
                </label>
                <label className={`${LABEL} min-w-0`}>
                  Rate ₱
                  <input name="rate" inputMode="decimal" defaultValue={l.rate} className={`${INPUT} w-full tabular-nums`} />
                </label>
              </FormGrid>
            </EditableRecord>
          </div>
          <form action={removeLineAction}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="lineId" value={l.id} />
            <button type="submit" className={BTN_DANGER}>
              Remove
            </button>
          </form>
        </div>
      )}

      {editPack && (
        <div className="mt-3">
          {packed !== null ? (
            <EditableRecord action={fulfilLineAction} label={`${l.itemName} packing`} hidden={{ orderId: order.id, lineId: l.id }}>
              <FormGrid>
              <label className={`${LABEL} min-w-0`}>
                Send ({l.unit}) — 0 means none
                <input name="quantity" inputMode="decimal" defaultValue={packed ?? l.quantity} className={`${INPUT} w-full tabular-nums`} />
              </label>
              <label className={`${LABEL} min-w-0`}>
                Rate ₱
                <input name="rate" inputMode="decimal" defaultValue={l.rate} className={`${INPUT} w-full tabular-nums`} />
              </label>
              <label className={`${LABEL} min-w-0`}>
                From room
                <select name="sourceLocationId" defaultValue={l.sourceLocationId ?? ''} className={`${INPUT} w-full`}>
                  <option value="">default room</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </FormGrid>
            </EditableRecord>
          ) : (
            <form action={fulfilLineAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="lineId" value={l.id} />
              <FormGrid>
              <label className={`${LABEL} min-w-0`}>
                Send ({l.unit}) — 0 means none
                <input name="quantity" inputMode="decimal" defaultValue={packed ?? l.quantity} className={`${INPUT} w-full tabular-nums`} />
              </label>
              <label className={`${LABEL} min-w-0`}>
                Rate ₱
                <input name="rate" inputMode="decimal" defaultValue={l.rate} className={`${INPUT} w-full tabular-nums`} />
              </label>
              <label className={`${LABEL} min-w-0`}>
                From room
                <select name="sourceLocationId" defaultValue={l.sourceLocationId ?? ''} className={`${INPUT} w-full`}>
                  <option value="">default room</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </FormGrid>
              <button type="submit" className={`mt-3 ${BTN_SECONDARY}`}>
                Save
              </button>
            </form>
          )}
        </div>
      )}

      {pending && (stage === 'accepted' || stage === 'ready') && branchSide && (
        <form action={decideLineAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="hidden" name="lineId" value={l.id} />
          <span className="text-xs text-neutral-600 dark:text-neutral-400">The commissary proposes this. Your answer:</span>
          <button type="submit" name="decision" value="approved" className={BTN}>
            Approve
          </button>
          <button type="submit" name="decision" value="rejected" className={BTN_DANGER}>
            Decline
          </button>
        </form>
      )}

      {receiving && !declined && packed !== null && compareQuantity(quantity(packed), ZERO_QUANTITY) > 0 && !l.isLedgerOnly && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="lineId" value={l.id} />
          <label className={`${LABEL} min-w-[7rem] flex-1`}>
            Signed for ({l.unit})
            <input name="receivedQuantity" inputMode="decimal" defaultValue={packed} className={`${INPUT} w-full tabular-nums`} />
          </label>
          <label className={LABEL}>
            If short: why?
            <select name="shortageReason" defaultValue="" className={INPUT}>
              <option value="">—</option>
              {SHORTAGE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
