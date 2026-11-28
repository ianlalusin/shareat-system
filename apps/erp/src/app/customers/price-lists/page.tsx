import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { createPriceListAction, setDefaultPriceListAction } from '../actions';
import { listLists } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, CardGrid, ConfirmDestructive, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { PRICE_LIST_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Price lists — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function PriceListsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/customers/price-lists');
  const lists = await listLists(actor.orgId);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-[16rem]">
          <Link href="/customers" className={NAV_LINK}>
            ← Customers
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Price lists</h1>
          <PageDescription>
            What the business charges, per item. A customer is given one list, and an order line takes
            its rate; a customer with no list uses the <strong>default list</strong>. Each item has{' '}
            <strong>one price per list</strong>: a fixed rate, or the delivery cost plus an amount or a
            percent. No volume discounts or dated promotions.
          </PageDescription>
        </div>
        {/* T-448: the add form opens from the header instead of sitting under the list. */}
        <FormModal trigger="+ New price list" title="New price list" size="sm">
          <CheckedForm rules={PRICE_LIST_ADD_RULES} action={createPriceListAction} className="space-y-3">
            <FormGrid layout="fields">
              <Field width="name" label="Name" rule={PRICE_LIST_ADD_RULES.name}>
                <Input {...nativeAttrs(PRICE_LIST_ADD_RULES.name)} placeholder="Wholesale — meat" className="w-full" />
              </Field>
              <Field width="long" label="Description" hint="Optional.">
                <Input name="description" className="w-full" />
              </Field>
            </FormGrid>
            <DialogActions>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </DialogActions>
          </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {lists.length > 0 ? (
        <CardGrid min="sm">
          {lists.map((l) => (
            <div key={l.id} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/customers/price-lists/${l.id}`}
                  className="underline underline-offset-2"
                >
                  {l.name}
                </Link>
                {l.isDefault && <Badge tone="success" label="Default" />}
              </div>
              {l.description && (
                <div className="text-xs text-neutral-500 dark:text-neutral-500">
                  {l.description}
                </div>
              )}
              {/* T-649: one list is the default. A confirm first: it changes what every customer with no list of their own is charged. */}
              <form action={setDefaultPriceListAction} className="mt-2">
                {l.isDefault ? (
                  <ConfirmDestructive
                    tier="confirm"
                    quiet
                    label="Stop being default"
                    consequence={`${l.name} stops being the default. A customer with no list of their own then has rates typed on each order.`}
                  />
                ) : (
                  <>
                    <input type="hidden" name="priceListId" value={l.id} />
                    <ConfirmDestructive
                      tier="confirm"
                      quiet
                      label="Make default"
                      consequence={`Make ${l.name} the default list? A customer with no list of their own is then priced from it.${lists.some((x) => x.isDefault) ? ' The current default stops being the default.' : ''}`}
                    />
                  </>
                )}
              </form>
            </div>
          ))}
        </CardGrid>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No price lists yet.</p>
      )}
    </Page>
  );
}
