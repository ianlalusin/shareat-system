import Link from 'next/link';
import { can, type Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { formatBusinessDateTime, type BusinessDate } from '@shareat/core/datetime';
import { humanDate } from '@shareat/domain/refusal-leaf';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { KeepParams, NoMatches, SearchBox, SearchCount } from '@/components/SearchBox';
import { clearSearchHref, matchesQuery, readQ } from '@/lib/search';
import { Badge, Banner, Button, Checkbox, Field, FlashBanner, FormGrid, FormModal, Input, Select, Table, Td, Th } from '@/components/ui';
import { linkItemAction, seedLinkAction, switchSourceAction, unlinkItemAction } from './actions';
import { loadUsageSourcePage, type UsageSourcePageData } from './lib';
import { storesInScope, withOrgPrincipal } from '../lib';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Where stock usage comes from - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  compare?: string;
  q?: string;
}

const SOURCE_LABEL = { menu_rules: 'Menu rules', v1_pos_map: 'POS item maps' } as const;

/** Presentation only: whether to draw a control. The domain's own gate is the control. */
async function mayDo(tx: Tx, actor: Actor, capability: 'manage_pos_map' | 'switch_usage_source', storeId: string): Promise<boolean> {
  return can(tx, actor, capability, { storeId });
}

export default async function UsageSourcePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/usage-source');
  if (refusal) return refusal;

  const loaded = await withOrgPrincipal(actor.orgId, async (tx) => {
    const stores = await storesInScope(tx, actor);
    // A store outside the person's scope is never drawn: an unknown or foreign ?store= falls back to their first store.
    const store = stores.find((s) => s.id === sp.store) ?? stores[0] ?? null;
    if (!store) return { stores, store: null, data: null, canLink: false, canSwitch: false };
    const data = await loadUsageSourcePage(tx, actor, store.id, sp.compare === '1');
    return {
      stores,
      store,
      data,
      canLink: await mayDo(tx, actor, 'manage_pos_map', store.id),
      canSwitch: await mayDo(tx, actor, 'switch_usage_source', store.id),
    };
  });
  const { stores, store, data, canLink, canSwitch } = loaded;
  const q = readQ(sp.q); // T-645

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Where stock usage comes from</h1>
          <PageDescription className="mt-1">
            A store&apos;s daily stock usage comes from either its POS item maps or the menu&apos;s stock rules. Link each POS item to its menu item,
            compare the two, then switch. You can switch back at any time.
          </PageDescription>
        </div>
        <Link href="/menu" className={NAV_LINK}>
          Back to the menu
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {!store || !data ? (
        <p className="text-sm text-muted">You are not assigned to any store, so there is no usage source for you to see here.</p>
      ) : (
        <>
          <FilterRow>
            <label className="text-sm">
              <span className="block text-muted">Store</span>
              <Select name="store" defaultValue={store.id}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <SearchBox q={q} placeholder="POS item or menu item…" />
            <KeepParams params={{ compare: sp.compare }} />
          </FilterRow>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Current source</h2>
            <p>
              <Badge tone={data.source === 'menu_rules' ? 'info' : 'closed'} label={SOURCE_LABEL[data.source]} />
            </p>
            <History data={data} />
          </section>

          <Links data={data} storeId={store.id} canLink={canLink} q={q} clearHref={clearSearchHref('/menu/usage-source', { store: store.id, compare: sp.compare })} />
          <Compare data={data} storeId={store.id} canSwitch={canSwitch} />
        </>
      )}
    </Page>
  );
}

function History({ data }: { data: UsageSourcePageData }) {
  if (data.history.length === 0) return <p className="text-sm text-muted">This store has never been switched, so it reads the POS item maps.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Source</Th>
          <Th>Reason</Th>
          <Th numeric>Differences accepted</Th>
        </tr>
      </thead>
      <tbody>
        {data.history.map((r) => (
          <tr key={r.id}>
            <Td>{formatBusinessDateTime(r.createdAt, { dateStyle: 'long', timeStyle: 'short' })}</Td>
            <Td>{SOURCE_LABEL[r.source]}</Td>
            <Td>{r.reason ?? ''}</Td>
            <Td className="text-right tabular-nums">{r.differenceCount ?? ''}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Links({ data, storeId, canLink, q, clearHref }: { data: UsageSourcePageData; storeId: string; canLink: boolean; q: string; clearHref: string }) {
  const links = data.links.filter((l) => matchesQuery(q, l.posItemKey, l.posItemName, l.variantLabel, l.roomName));
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Links</h2>
        {/* T-589 B7: adding a link is a button here, not two forms under the table. Neither keeps typing, so neither opens on load. */}
        {canLink && (
          <div className="flex flex-wrap items-center gap-2">
            {data.unlinked.length > 0 && (
              <FormModal trigger="+ Link from the POS map" title="Link from the POS map" size="md">
                <form action={seedLinkAction} className="space-y-3">
                  <p className="text-sm text-muted">Copies the POS item map exactly: its room, and, if the menu item has no stock rule yet, its rule.</p>
                  <input type="hidden" name="storeId" value={storeId} />
                  <FormGrid>
                    <Field label="POS item" className="text-sm">
                      <Select name="posItemKey" className="w-full">
                        {data.unlinked.map((m) => (
                          <option key={m.posItemKey} value={m.posItemKey}>
                            {m.posItemName === m.posItemKey ? m.posItemKey : `${m.posItemName} (${m.posItemKey})`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Menu item" className="text-sm">
                      <Select name="variantId" className="w-full">
                        {data.variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </FormGrid>
                  <Button type="submit" variant="secondary">
                    Seed from map
                  </Button>
                </form>
              </FormModal>
            )}
            <FormModal trigger="+ Link to a menu item" title="Link to a menu item that already has a stock rule" size="md">
              <form action={linkItemAction} className="space-y-3">
                <input type="hidden" name="storeId" value={storeId} />
                <FormGrid>
                  <Field label="POS item code" className="text-sm">
                    <Input name="posItemKey" className="w-full" />
                  </Field>
                  <Field label="Menu item" className="text-sm">
                    <Select name="variantId" className="w-full">
                      {data.variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Room (empty = the default room)" className="text-sm">
                    <Select name="locationId" className="w-full" defaultValue="">
                      <option value="">The default room</option>
                      {data.rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </FormGrid>
                <Button type="submit" variant="secondary">
                  Save link
                </Button>
              </form>
            </FormModal>
          </div>
        )}
      </div>
      <p className="text-sm text-muted">
        A link says &quot;this POS item at this store is that menu item&quot;. Once the store is switched, a linked item uses the menu item&apos;s stock
        rule; an unlinked item keeps using its POS item map.
      </p>
      <SearchCount q={q} shown={links.length} total={data.links.length} />
      {data.links.length === 0 ? (
        <p className="text-sm text-muted">Nothing is linked at this store yet.</p>
      ) : links.length === 0 ? (
        <NoMatches q={q} clearHref={clearHref} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>POS item</Th>
              <Th>Menu item</Th>
              <Th>Room</Th>
              <Th>
                <span className="sr-only">Remove</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <Td>
                  {l.posItemKey}
                  {l.posItemName && l.posItemName !== l.posItemKey ? <span className="block text-muted">{l.posItemName}</span> : null}
                </Td>
                <Td>{l.variantLabel}</Td>
                <Td>{l.roomName ?? 'The default room'}</Td>
                <Td>
                  {canLink && (
                    <form action={unlinkItemAction}>
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="posItemKey" value={l.posItemKey} />
                      <Button type="submit" variant="ghost" aria-label={`Remove the link for ${l.posItemKey}`}>
                        Unlink
                      </Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {!canLink && (
        <p className="text-sm text-muted">You can read the links but not change them.</p>
      )}
    </section>
  );
}

function Compare({ data, storeId, canSwitch }: { data: UsageSourcePageData; storeId: string; canSwitch: boolean }) {
  const cmp = data.comparison;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Compare and switch</h2>
      <p className="text-sm text-muted">
        Compare checks the last 7 days both ways, with the POS item maps and with the menu rules, and lists every difference. It changes nothing.
      </p>
      <Link href={`/menu/usage-source?store=${storeId}&compare=1`} className={NAV_LINK}>
        Compare now
      </Link>
      {cmp && (
        <div className="space-y-2">
          {cmp.differences.length === 0 ? (
            <p className="text-sm">{`No differences over the ${cmp.daysCompared.length} day${cmp.daysCompared.length === 1 ? '' : 's'} compared.`}</p>
          ) : (
            <>
              <p className="text-sm">{`${cmp.differenceCount} item${cmp.differenceCount === 1 ? '' : 's'} would use stock differently.`}</p>
              <Table>
                <thead>
                  <tr>
                    <Th>Day</Th>
                    <Th>POS item</Th>
                    <Th>What differs</Th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.differences.map((d) => (
                    <tr key={`${d.businessDate ?? 'standing'}|${d.posItemKey}`}>
                      <Td>{d.businessDate ? humanDate(d.businessDate as BusinessDate) : 'Standing rule'}</Td>
                      <Td>{d.posItemKey}</Td>
                      <Td>{d.summary}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </div>
      )}

      {canSwitch ? (
        <div className="grid gap-4 md:grid-cols-2">
          <form action={switchSourceAction} className="space-y-3 rounded-[14px] border border-surface-border p-4">
            <h3 className="text-sm font-semibold">Switch to menu rules</h3>
            <p className="text-sm text-muted">
              If the two differ, you must accept the differences and give a reason. Not possible while a day&apos;s usage is still being imported.
            </p>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="source" value="menu_rules" />
            <Checkbox name="acceptDifferences" value="1" label="Accept the differences" />
            <Field label="Reason (needed to accept differences)" className="text-sm">
              <Input name="reason" className="w-full" />
            </Field>
            <Button type="submit" variant="secondary">
              Switch to menu rules
            </Button>
          </form>
          <form action={switchSourceAction} className="space-y-3 rounded-[14px] border border-surface-border p-4">
            <h3 className="text-sm font-semibold">Switch back</h3>
            <p className="text-sm text-muted">Goes back to the POS item maps at once. No comparison, nothing to type.</p>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="source" value="v1_pos_map" />
            <Button type="submit" variant="secondary">
              Switch back to POS item maps
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted">You can read this but not switch the source.</p>
      )}
    </section>
  );
}
