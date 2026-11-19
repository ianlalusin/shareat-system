'use server';

/**
 * Server actions behind the shared "Copy from another store" window (T-611 S1). docs/tasks/611-copy-settings-between-stores.md.
 *
 * `previewCopyAction` is read-only: per target, what a copy would add, leave and keep. `copyFromStoreAction` is Tier P (T-412): an administrator's
 * PIN, verified here against the target store, BEFORE the domain call; then ONE transaction per target (its approval row and its copy), so one
 * target's refusal never undoes another's. The gate (admin role, the edit right at each target, same organisation) is the domain's.
 */
import { copySettingsToStore, previewCopyToStore, type CopyCounts, type CopyKind, type CopyLine } from '@shareat/domain';
import { verifyAdminApproval, type Capability } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';
import { redirectWithFlash } from '@/lib/flash';
import { requireActor } from '../../lib/session';
import { isUuid, menuErrorMessage, str, withOrgPrincipal } from '../menu/lib';
import { copyStoreChoices } from './lib';

const PATH: Record<CopyKind, string> = { hours: '/menu/hours', prices: '/menu/prices' };
const CAPABILITY: Record<CopyKind, Capability> = { hours: 'manage_store_settings', prices: 'set_menu_price' };
const isKind = (v: unknown): v is CopyKind => v === 'hours' || v === 'prices';

export type CopyPreviewResult =
  | { storeId: string; ok: true; name: string; counts: CopyCounts; lines: CopyLine[] }
  | { storeId: string; ok: false; error: string };

/** What a copy would do at each target. The browser sends ids and choices only; the plan is computed here from the database. */
export async function previewCopyAction(input: { kind: string; sourceStoreId: string; targetStoreIds: string[]; replace: boolean }): Promise<CopyPreviewResult[]> {
  const kind = input.kind;
  if (!isKind(kind)) return [];
  const actor = await requireActor(PATH[kind]);
  const ids = Array.isArray(input.targetStoreIds) ? input.targetStoreIds : [];
  const out: CopyPreviewResult[] = [];
  for (const storeId of [...new Set(ids)].filter((s) => typeof s === 'string' && isUuid(s))) {
    try {
      const p = await withOrgPrincipal(actor.orgId, (tx) =>
        previewCopyToStore(actor, { kind, sourceStoreId: String(input.sourceStoreId), targetStoreId: storeId, replace: input.replace === true }, tx),
      );
      out.push({ storeId, ok: true, name: p.targetName, counts: p.counts, lines: p.lines });
    } catch (err) {
      out.push({ storeId, ok: false, error: menuErrorMessage(err) });
    }
  }
  return out;
}

export async function copyFromStoreAction(fd: FormData): Promise<void> {
  const kind = str(fd, 'kind');
  if (!isKind(kind)) return await redirectWithFlash('/menu', {}, { error: 'Choose what to copy.' });
  const here = PATH[kind];
  const actor = await requireActor(here);
  const current = str(fd, 'storeId');
  const nav = isUuid(current) ? { store: current } : {};
  const sourceStoreId = str(fd, 'sourceStoreId');
  const targets = [...new Set(fd.getAll('targetStoreId').filter((v): v is string => typeof v === 'string' && isUuid(v)))];
  if (!isUuid(sourceStoreId) || targets.length === 0) {
    return await redirectWithFlash(here, nav, { error: 'Choose the store to copy from and tick at least one store to copy to.' });
  }
  const replace = str(fd, 'replace') === 'on';
  const capability = CAPABILITY[kind];
  let approval: { approverPersonId: string };
  try {
    // T-412 Tier P: an administrator's PIN, verified against the first target store as loaded from the database (never a form field).
    const target = await loadDestructiveTarget(actor, 'store', targets[0]!, [capability]);
    approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability });
  } catch (err) {
    return await redirectWithFlash(here, nav, { error: menuErrorMessage(err) });
  }
  const names = new Map((await withOrgPrincipal(actor.orgId, (tx) => copyStoreChoices(tx, actor.orgId))).map((s) => [s.id, s.name]));
  const said: string[] = [];
  let failed = false;
  for (const targetStoreId of targets) {
    const name = names.get(targetStoreId) ?? 'That store';
    try {
      const r = await withOrgPrincipal(actor.orgId, async (tx) => {
        await recordApproval(tx, actor, approval, { capability, entityType: 'store', entityId: targetStoreId, storeId: targetStoreId });
        return copySettingsToStore(actor, { kind, sourceStoreId, targetStoreId, replace, approverPersonId: approval.approverPersonId }, tx);
      });
      said.push(`${name}: ${r.counts.added} added, ${r.counts.replaced} replaced, ${r.counts.skipped} left as they were.`);
    } catch (err) {
      failed = true;
      said.push(`${name}: nothing copied. ${menuErrorMessage(err)}`);
    }
  }
  return await redirectWithFlash(here, nav, failed ? { error: said.join(' ') } : { ok: said.join(' ') });
}
