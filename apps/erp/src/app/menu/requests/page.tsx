import Link from 'next/link';
import { heldCapabilities } from '@shareat/auth';
import { menuRepo } from '@shareat/db';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Button, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import {
  approveItemRequestAction,
  markItemRequestDuplicateAction,
  rejectItemRequestAction,
  submitItemRequestAction,
  withdrawItemRequestAction,
} from './actions';
import { ITEM_REQUEST } from './typed-forms';
import { confirmTokenFor, listActiveItemNames, listCategories, myRequests, openRequests, storesInScope, withOrgPrincipal, type RequestRow } from '../lib';

export const metadata = { title: 'Item requests - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

const TYPE_LABEL: Record<string, string> = { a_la_carte: 'A la carte', package: 'Package', refill: 'Refill' };

/** How a request ended, in words. */
function outcome(r: RequestRow): string {
  switch (r.status) {
    case 'open':
      return 'Open';
    case 'approved':
      return r.resolvedItemName ? `Approved: added as ${r.resolvedItemName}` : 'Approved';
    case 'duplicate':
      return `Duplicate of ${r.resolvedItemName ?? 'an item already on the menu'}`;
    case 'rejected':
      return r.resolutionNote ? `Rejected: ${r.resolutionNote}` : 'Rejected';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

export default async function MenuRequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/requests');
  if (refusal) return refusal;

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    const resolver = held.has('add_menu_item');
    const stores = await storesInScope(tx, actor);
    const categories = await listCategories(tx, actor.orgId);
    const mine = await myRequests(tx, actor);
    const queue = resolver ? await openRequests(tx, actor.orgId) : [];
    const likely = new Map<string, { id: string; name: string }[]>();
    for (const q of queue) likely.set(q.id, (await menuRepo.similarMenuItems(tx, actor.orgId, q.name)).map((m) => ({ id: m.id, name: m.name })));
    const items = resolver ? await listActiveItemNames(tx, actor.orgId) : [];
    return { resolver, stores, categories, mine, queue, likely, items };
  });
  const { resolver, stores, categories, mine, queue, likely, items } = loaded;
  const activeCategories = categories.filter((c) => c.status === 'active');

  const typed = typedFor(sp, ITEM_REQUEST, '', actor.personId);
  const kept = typed?.kind === 'typed' ? typed.fields : {};
  const one = (name: string): string => {
    const v = kept[name];
    return typeof v === 'string' ? v : '';
  };
  // "Send request anyway" replaces the button only while the look-alike warning is on screen.
  const showAnyway = Boolean(sp.warning) && one('name') !== '';

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Item requests</h1>
          <PageDescription className="mt-1">
            Ask for an item that is not on the menu yet. We check the name against what is already there first, so the same dish is not
            added twice. The head office adds the item or tells you why not.
          </PageDescription>
        </div>
        <Link href="/menu" className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
          Back to the menu
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {resolver && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">{`Waiting for a decision (${queue.length})`}</h2>
          {queue.length === 0 && <p className="text-sm text-muted">Nothing is waiting.</p>}
          {queue.map((q) => {
            const matches = likely.get(q.id) ?? [];
            return (
              <div key={q.id} className="space-y-2 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
                <p className="text-sm">
                  <span className="font-medium">{q.name}</span>
                  {` - ${TYPE_LABEL[q.itemType] ?? q.itemType}, asked by ${q.requesterName} for ${q.storeName}.`}
                  {q.note ? ` Note: ${q.note}` : ''}
                </p>
                {matches.length > 0 && <p className="text-sm">{`Looks like: ${matches.map((m) => m.name).join(', ')}`}</p>}
                <div className="grid gap-4 md:grid-cols-3">
                  <form action={approveItemRequestAction} className="space-y-2">
                    <Field label="Category for the new item" className="text-sm">
                      <Select name="categoryId" defaultValue={q.categoryId ?? activeCategories[0]?.id} className="w-full">
                        {activeCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button type="submit" name="id" value={q.id} variant="primary">
                      Approve
                    </Button>
                  </form>
                  <form action={markItemRequestDuplicateAction} className="space-y-2">
                    <Field label="Already on the menu as" className="text-sm">
                      <Select name="itemId" defaultValue={matches[0]?.id ?? ''} className="w-full">
                        <option value="">-</option>
                        {items.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button type="submit" name="id" value={q.id} variant="secondary">
                      Mark duplicate
                    </Button>
                  </form>
                  <form action={rejectItemRequestAction} className="space-y-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Field label="Reason" className="text-sm">
                      <Input name="note" required className="w-full" />
                    </Field>
                    <Button type="submit" variant="danger">
                      Reject
                    </Button>
                  </form>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
        <h2 className="text-lg font-semibold">Request an item</h2>
        {stores.length === 0 ? (
          <p className="text-sm text-muted">You are not assigned to any store, so you cannot send a request.</p>
        ) : (
          <form action={submitItemRequestAction} className="space-y-3">
            <FormGrid>
              <Field label="For store" className="text-sm">
                <Select name="storeId" defaultValue={one('storeId') || stores[0]?.id} className="w-full">
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Name" className="text-sm">
                <Input name="name" defaultValue={one('name')} required className="w-full" />
              </Field>
              <Field label="Type" className="text-sm">
                <Select name="itemType" defaultValue={one('itemType') || 'a_la_carte'} className="w-full">
                  <option value="a_la_carte">A la carte</option>
                  <option value="package">Package</option>
                  <option value="refill">Refill</option>
                </Select>
              </Field>
              <Field label="Category (a hint, optional)" className="text-sm">
                <Select name="categoryId" defaultValue={one('categoryId')} className="w-full">
                  <option value="">-</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Note (optional)" span="wide" className="text-sm">
                <Input name="note" defaultValue={one('note')} className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary" name={showAnyway ? 'confirmed' : undefined} value={showAnyway ? confirmTokenFor(one('name')) : undefined}>
              {showAnyway ? 'Send request anyway' : 'Request item'}
            </Button>
          </form>
        )}
      </section>

      <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
        <h2 className="text-lg font-semibold">Your requests</h2>
        {mine.length === 0 && <p className="text-sm text-muted">You have not asked for anything yet.</p>}
        <ul className="divide-y divide-surface-border">
          {mine.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted">{`${TYPE_LABEL[r.itemType] ?? r.itemType}, ${r.storeName}`}</span>
              <Badge status={r.status} />
              <span>{outcome(r)}</span>
              {r.status === 'open' && (
                <form action={withdrawItemRequestAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button type="submit" variant="ghost">
                    Withdraw
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
