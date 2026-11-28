import Link from 'next/link';
import { menuRepo } from '@shareat/db';
import { previewFlavourMerge } from '@shareat/domain';
import { heldCapabilities } from '@shareat/auth';
import { MENU_OPTION_VALUE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requirePageAccess } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { CheckedForm } from '@/components/forms';
import { Badge, Banner, Button, Field, FlashBanner, FormGrid, Input } from '@/components/ui';
import { NAV_LINK } from '@/components/action-link';
import { withOrgPrincipal } from '../lib';
import { ArrangeList } from '../arrange/ArrangeList';
import { addFlavourAction, mergeFlavoursAction, renameFlavourAction, reorderFlavoursAction, setFlavourStatusAction, startFlavourListAction } from './actions';

export const metadata = { title: 'Flavours - Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

/**
 * T-653: ONE list of flavours for the whole menu. Add, rename, retire and arrange them here; each package and each refill then ticks the flavours it allows on its own page
 * (Menu, the item, "Flavours this package allows" / "Flavours this refill allows"). A flavour retired here disappears from every package and refill.
 */
export default async function FlavoursPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/flavours');
  if (refusal) return refusal;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    const canManage = held.has('manage_menu');
    const group = await menuRepo.getFlavoursGroup(tx, actor.orgId);
    const values = group ? await menuRepo.valuesOfGroup(tx, actor.orgId, group.id) : [];
    const preview = canManage ? await previewFlavourMerge(actor, tx) : null;
    return { canManage, group, values, preview };
  });
  const { canManage, group, values, preview } = data;
  const active = [...values].filter((v) => v.status === 'active').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const retired = values.filter((v) => v.status === 'retired');

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Flavours</h1>
          <PageDescription className="mt-1">
            One list of flavours for the whole menu. Each package and each refill then ticks the flavours it allows, on its own page. Retire a flavour here and it disappears from every package and refill.
          </PageDescription>
        </div>
        <Link href="/menu" className={NAV_LINK}>
          Back to the menu
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {sp.ok && <Banner tone="success">{sp.ok}</Banner>}

      {!group ? (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Start your flavour list</h2>
          <p className="text-sm">You have no flavour list yet. Start one, add your flavours, then tick the flavours each package and refill allows.</p>
          {canManage ? (
            <form action={startFlavourListAction}>
              <Button type="submit" variant="primary">
                Start your flavour list
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted">Only a menu manager can start it.</p>
          )}
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="min-w-0 space-y-3 rounded-[14px] border border-surface-border p-4">
            <h2 className="text-lg font-semibold">Your flavours</h2>
            {canManage && (
              <CheckedForm rules={MENU_OPTION_VALUE_RULES} action={addFlavourAction} className="space-y-3">
                <FormGrid>
                  <Field label="New flavour" className="text-sm" rule={MENU_OPTION_VALUE_RULES.name}>
                    <Input {...nativeAttrs(MENU_OPTION_VALUE_RULES.name)} className="w-full" />
                  </Field>
                </FormGrid>
                <Button type="submit" variant="secondary">
                  Add flavour
                </Button>
              </CheckedForm>
            )}
            {active.length === 0 ? (
              <p className="text-sm text-muted">No flavours yet. Add the first one above.</p>
            ) : canManage ? (
              <ArrangeList
                key={`f:${active.map((v) => v.id).join()}`}
                rows={active.map((v) => ({ id: v.id, label: v.name }))}
                action={reorderFlavoursAction}
                hidden={{ optionGroupId: group.id }}
                noun="flavour"
              />
            ) : (
              <ol className="list-decimal pl-5 text-sm">
                {active.map((v) => (
                  <li key={v.id}>{v.name}</li>
                ))}
              </ol>
            )}
          </section>

          {canManage && (
            <section className="min-w-0 space-y-4 rounded-[14px] border border-surface-border p-4">
              <h2 className="text-lg font-semibold">Rename or retire</h2>
              {active.map((v) => (
                <div key={v.id} className="flex flex-wrap items-end gap-3 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
                  <CheckedForm rules={MENU_OPTION_VALUE_RULES} action={renameFlavourAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="id" value={v.id} />
                    <Field label={`Rename ${v.name}`} className="text-sm" rule={MENU_OPTION_VALUE_RULES.name}>
                      <Input {...nativeAttrs(MENU_OPTION_VALUE_RULES.name)} placeholder={v.name} className="w-full" />
                    </Field>
                    <Button type="submit" variant="secondary">
                      Rename
                    </Button>
                  </CheckedForm>
                  <form action={setFlavourStatusAction}>
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="status" value="retired" />
                    <Button type="submit" variant="secondary" aria-label={`Retire ${v.name}`}>
                      Retire
                    </Button>
                  </form>
                </div>
              ))}
              {retired.length > 0 && (
                <div className="space-y-2 border-t border-surface-border pt-3">
                  <h3 className="font-medium">Retired</h3>
                  {retired.map((v) => (
                    <form key={v.id} action={setFlavourStatusAction} className="flex flex-wrap items-center gap-3">
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="status" value="active" />
                      <span className="text-sm">{v.name}</span>
                      <Badge status="retired" />
                      <Button type="submit" variant="secondary" aria-label={`Bring back ${v.name}`}>
                        Bring back
                      </Button>
                    </form>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {canManage && preview && (
        <section className="space-y-3 rounded-[14px] border border-surface-border p-4">
          <h2 className="text-lg font-semibold">Use these flavours</h2>
          <p className="text-sm">
            You already built flavour groups on individual items. This brings them into the one list. Nothing is deleted: the old groups are retired and keep their history, and each item keeps the same flavours it offers now.
          </p>
          <div className="space-y-1 text-sm">
            <p className="font-medium">{`Goes on your flavour list (${preview.names.length}${preview.hasList ? '' : ', a new list'})`}</p>
            <p>{preview.names.map((n) => (n.isNew ? n.name : `${n.name} (already there)`)).join(', ')}</p>
          </div>
          <div className="space-y-2 text-sm">
            {preview.groups.map((g) => (
              <div key={g.groupId}>
                <p className="font-medium">{`${g.name}: ${g.values.join(', ') || 'no flavours'}`}</p>
                {g.targets.length === 0 ? (
                  <p className="text-muted">Not used by any item, so it is simply retired.</p>
                ) : (
                  <ul className="list-disc pl-5">
                    {g.targets.map((t) => (
                      <li key={`${t.kind}:${t.id}`}>{`${t.label}: guests pick ${t.min} to ${t.max}${t.skipped ? '. Already uses the flavour list, so it is left as it is.' : ''}`}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <form action={mergeFlavoursAction}>
            <Button type="submit" variant="primary">
              Use these flavours
            </Button>
          </form>
        </section>
      )}
    </Page>
  );
}
