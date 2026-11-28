'use server';

/**
 * Server actions for /menu/flavours (T-653). Thin adapters: read the form, call the domain (`startFlavourList`, `addFlavour`, `editFlavour`,
 * `reorderMenuOptionValues`, `mergeIntoFlavours`: each authorizes `manage_menu` first and writes one audit row), come back to the page with a banner.
 * Each action redirects AFTER its work, outside the `try`.
 */
import { addFlavour, assertFieldRules, editFlavour, mergeIntoFlavours, reorderMenuOptionValues, startFlavourList } from '@shareat/domain';
import { can } from '@shareat/auth';
import { MENU_OPTION_VALUE_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { menuErrorMessage, requireId, str, withOrgPrincipal } from '../lib';

const PATH = '/menu/flavours';

export async function startFlavourListAction(): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => startFlavourList(actor, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Your flavour list is ready. Add the flavours below.' });
}

export async function addFlavourAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 S9 (iii): the field check runs only for a caller addFlavour's own authorize() would let in.
      if (await can(tx, actor, 'manage_menu', {})) assertFieldRules(MENU_OPTION_VALUE_RULES, fd);
      return addFlavour(actor, { name: str(fd, 'name') }, tx);
    });
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Flavour added.' });
}

export async function renameFlavourAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  try {
    const id = requireId(fd, 'id', 'Choose a flavour.');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      if (await can(tx, actor, 'manage_menu', {})) assertFieldRules(MENU_OPTION_VALUE_RULES, fd);
      return editFlavour(actor, { id, name: str(fd, 'name') }, tx);
    });
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: 'Flavour renamed.' });
}

/** Retire (hide everywhere) or bring back, by the `status` the button sends. */
export async function setFlavourStatusAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  const status = str(fd, 'status') === 'retired' ? 'retired' : 'active';
  try {
    const id = requireId(fd, 'id', 'Choose a flavour.');
    await withOrgPrincipal(actor.orgId, (tx) => editFlavour(actor, { id, status }, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: status === 'retired' ? 'Flavour retired. It is hidden from every package and refill.' : 'Flavour brought back.' });
}

/** The screen sends the whole list as JSON; anything else becomes an empty list, which the domain refuses as "the list changed". */
function idsOf(fd: FormData): string[] {
  try {
    const parsed: unknown = JSON.parse(String(fd.get('ids') ?? ''));
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

export async function reorderFlavoursAction(fd: FormData): Promise<void> {
  const actor = await requireActor(PATH);
  let changed: boolean;
  try {
    const optionGroupId = requireId(fd, 'optionGroupId', 'Choose the flavour list.');
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => reorderMenuOptionValues(actor, { optionGroupId, ids: idsOf(fd) }, tx)));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(PATH, {}, { ok: changed ? 'Flavour order saved.' : 'The order is the same, so nothing was changed.' });
}

/** "Use these flavours": one transaction (the domain). The page showed the preview first. */
export async function mergeFlavoursAction(): Promise<void> {
  const actor = await requireActor(PATH);
  let done: Awaited<ReturnType<typeof mergeIntoFlavours>>;
  try {
    done = await withOrgPrincipal(actor.orgId, (tx) => mergeIntoFlavours(actor, tx));
  } catch (err) {
    return await redirectWithFlash(PATH, {}, { error: menuErrorMessage(err) });
  }
  return await redirectWithFlash(
    PATH,
    {},
    { ok: `Done. ${done.flavoursAdded} flavour${done.flavoursAdded === 1 ? '' : 's'} added to the list, ${done.linksMoved} item${done.linksMoved === 1 ? '' : 's'} now use it, ${done.groupsRetired} old group${done.groupsRetired === 1 ? '' : 's'} retired.` },
  );
}
