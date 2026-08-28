'use server';

/**
 * Server actions for the customer and price-list screens. T-129.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import { createCustomer, createPriceList, reconcileCustomer, setPrice } from '@shareat/domain';
import type { CustomerGroup } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function createCustomerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let message = '';
  try {
    // ⭐ ONE picker on the form, split here. Offering two independent dropdowns would let someone
    // fill both, and the whole point is that a customer has at most one counterparty.
    const link = str(formData, 'counterparty');
    const [kind, id] = link ? link.split(':') : ['', ''];

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createCustomer(tx, actor, {
        name: str(formData, 'name'),
        address: str(formData, 'address') || null,
        contactNo: str(formData, 'contactNo') || null,
        counterpartyStoreId: kind === 'store' ? id! : null,
        counterpartyOrgId: kind === 'org' ? id! : null,
        priceListId: str(formData, 'priceListId') || null,
        customerGroup: (str(formData, 'customerGroup') || 'wholesale') as CustomerGroup,
        notes: str(formData, 'notes') || null,
      }),
    );
    // ⚠️ Says what the treatment MEANS, because "internal" alone does not tell anyone that the
    // movement will not be revenue.
    message =
      result.treatment === 'internal'
        ? 'Recorded as one of our own stores — movements to it eliminate and are never revenue.'
        : result.treatment === 'inter_entity'
          ? 'Recorded as another company — movements to it are real revenue and a real receivable.'
          : 'Recorded as an external customer — real revenue.';
  } catch (err) {
    back('/customers', { error: errorMessage(err) });
  }
  back('/customers', { ok: message });
}

export async function reconcileCustomerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let message = '';
  try {
    const asOf = str(formData, 'asOf');
    if (!asOf) throw new Error('Say which date they were verified at zero.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reconcileCustomer(tx, actor, { customerId: str(formData, 'customerId'), asOf }),
    );
    message = `Anchored at ${asOf}. Everything before it is treated as settled.`;
  } catch (err) {
    back('/customers', { error: errorMessage(err) });
  }
  back('/customers', { ok: message });
}

export async function createPriceListAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createPriceList(tx, actor, {
        name: str(formData, 'name'),
        description: str(formData, 'description') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    back('/customers/price-lists', { error: errorMessage(err) });
  }
  back(`/customers/price-lists/${id}`, { ok: 'Created. Add rates to it below.' });
}

export async function setPriceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const priceListId = str(formData, 'priceListId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setPrice(tx, actor, {
        priceListId,
        // ⭐ T-145: the form picks a real item now. The old free-text code is what allowed the
        // same product to exist under three spellings on three lists.
        itemId: str(formData, 'itemId'),
        rate: str(formData, 'rate'),
        unit: str(formData, 'unit') || null,
      }),
    );
  } catch (err) {
    back(`/customers/price-lists/${priceListId}`, { error: errorMessage(err) });
  }
  back(`/customers/price-lists/${priceListId}`, {
    // ⚠️ Says "replaced", because re-quoting an item does not add a second row.
    ok: 'Rate saved. Re-quoting an item replaces its rate — a list holds one price per item.',
  });
}
