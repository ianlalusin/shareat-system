'use server';

/**
 * Server actions for `/settings/ai-hub`. T-640 (docs/tasks/640-ai-hub.md).
 *
 * ⛔ No rule is re-implemented here. Every domain function this calls begins with `authorizeHub` (the capability `manage_ai_hub`, super admin only, plus a role of admin or above)
 * and only then checks a field, and owns every sentence. This file reads the form, calls the function and shows the sentence that comes back.
 *
 * ⛔ THE KEY: `saveKeyAction` hands the pasted key straight to `saveProviderKey` and keeps it nowhere else. A refused save puts only the refusal sentence in the flash: the key is never kept
 * for retyping (not in `keepTyping`, not in the address, not in a log), and the sentence never repeats it.
 *
 * Each action does its work inside the `try`, and redirects AFTER it: a redirect throws, and inside the `try` it would be shown as an error.
 */
import { revalidatePath } from 'next/cache';
import { activateAiModel, deactivateAiModel, moveAiModel, setAiModelOrder, removeProviderKey, saveAiSettings, saveProviderKey, setAiStoreSwitch, testAiModel, type TxRunner } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { keepTyping } from '../../../lib/keep-typing';
import { withOrgPrincipal } from '../../expenses/lib';
import { AI_SETTINGS_EDIT } from './typed-forms';

const ROUTE = '/settings/ai-hub';

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

// T-640: each exported action calls redirectWithFlash itself (no-typed-values-in-urls G1b allows it only there).

export async function saveKeyAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  let replaced: boolean;
  try {
    // the raw (untrimmed) value goes to the domain, which trims and checks it; it is not read again here
    ({ replaced } = await withOrgPrincipal(actor.orgId, (tx) => saveProviderKey(tx, actor, { provider: str(fd, 'provider'), key: String(fd.get('key') ?? '') })));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: replaced
      ? 'The key is replaced. The old one is gone, and only the last 4 characters of the new one stay in view. Test the models again before relying on them.'
      : 'The key is saved, encrypted. Only its last 4 characters will ever be shown. Now test a model below.', });
}

export async function removeKeyAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  let removed: number;
  try {
    removed = (await withOrgPrincipal(actor.orgId, (tx) => removeProviderKey(tx, actor, { provider: str(fd, 'provider') }))).modelsRemoved;
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: removed > 0 ? `The key is removed, and so ${removed === 1 ? 'is its model' : `are its ${removed} models`}. Type the key again to bring them back; they will need a new test.` : 'The key is removed.' });
}

export async function testModelAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  const model = str(fd, 'model');
  const run: TxRunner = (fn) => withOrgPrincipal(actor.orgId, fn);
  let result: { ok: boolean; note: string };
  try {
    result = await testAiModel(run, actor, { provider: str(fd, 'provider'), model });
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(ROUTE, {}, { error: `${model}: the test failed. ${result.note}` });
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: `${model}: ${result.note}` });
}

export async function activateModelAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => activateAiModel(tx, actor, { provider: str(fd, 'provider'), model: str(fd, 'model') }));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: 'The model is switched on, last in the order. Move it earlier if it should be tried first.' });
}

export async function deactivateModelAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => deactivateAiModel(tx, actor, { provider: str(fd, 'provider'), model: str(fd, 'model') }));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: 'The model is switched off. It keeps its test result.' });
}

export async function moveModelAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => moveAiModel(tx, actor, { provider: str(fd, 'provider'), model: str(fd, 'model'), direction: str(fd, 'direction') }));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: 'The order is changed. The first model is tried first; the next is used only when the one before it fails.' });
}

export async function setModelOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  // the drag sends the whole order as a JSON list of "provider/model"; anything else becomes an empty list, which the domain refuses as "not the active set"
  let order: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(fd.get('order') ?? ''));
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) order = parsed;
  } catch {
    order = [];
  }
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) => setAiModelOrder(tx, actor, { order })));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: changed ? 'The order is saved. Number 1 is tried first; the next is used only when the one before it fails.' : 'The order is the same, so nothing was changed.' });
}

export async function saveSettingsAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  let changed: boolean;
  try {
    ({ changed } = await withOrgPrincipal(actor.orgId, (tx) =>
      saveAiSettings(tx, actor, {
        enabled: str(fd, 'enabled'),
        monthlyCapPesos: str(fd, 'monthlyCapPesos'),
        dailyLimitPerPerson: str(fd, 'dailyLimitPerPerson'),
        pesosPerUsd: str(fd, 'pesosPerUsd'),
        warnAtPercent: str(fd, 'warnAtPercent'),
      }),
    ));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err), typed: keepTyping(fd, AI_SETTINGS_EDIT, '', { actorId: actor.personId }) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: changed ? 'Saved. The cap and limits apply to the very next AI question.' : 'Nothing was different, so nothing was changed.' });
}

export async function storeSwitchAction(fd: FormData): Promise<void> {
  const actor = await requireActor(ROUTE);
  const enabled = str(fd, 'enabled') === '1';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setAiStoreSwitch(tx, actor, { storeId: str(fd, 'storeId'), enabled }));
  } catch (err) {
    return await redirectWithFlash(ROUTE, {}, { error: errorMessage(err) });
  }
  revalidatePath(ROUTE);
  return await redirectWithFlash(ROUTE, {}, { ok: enabled ? 'AI features are on for that store.' : 'AI features are off for that store.' });
}
