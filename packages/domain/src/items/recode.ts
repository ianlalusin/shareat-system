/**
 * T-386 R11 - the one-time recode. Every item of the org whose code is not of the shape `AAAA-NNN` (NNN above 000) gets a
 * code allocated from its name, oldest first so the oldest item takes -001. Idempotent: a second run finds nothing to do.
 * Touches `items.code` and the audit log only (I7: no money, stock or ledger rows).
 */
import { auditLogRepo, itemsRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { ITEM_CODE_RE, itemCodeStem } from './code';
import { allocateItemCode } from './code-allocation';

export interface RecodeRow {
  itemId: string;
  name: string;
  status: string;
  from: string;
  to: string | null;
  note: string;
}

export async function recodeItems(tx: Tx, actor: Actor, input: { orgId: string }): Promise<RecodeRow[]> {
  await authorize(tx, actor, 'approve_item', {});
  const all = await itemsRepo.listItems(tx, input.orgId, { includeInactive: true });
  const legacy = all
    .filter((i) => !ITEM_CODE_RE.test(i.code))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  const rows: RecodeRow[] = [];
  for (const item of legacy) {
    const stem = itemCodeStem(item.name);
    if (stem === null) {
      rows.push({
        itemId: item.id,
        name: item.name,
        status: item.status,
        from: item.code,
        to: null,
        note: 'skipped: name has no letters or numbers',
      });
      continue;
    }
    const code = await allocateItemCode(tx, input.orgId, stem);
    await itemsRepo.updateItem(tx, input.orgId, item.id, { code });
    await auditLogRepo.append(tx, input.orgId, {
      actorPersonId: actor.personId,
      action: 'recode_item',
      entity: 'items',
      entityId: item.id,
      before: { code: item.code },
      after: { code },
      source: 'etl',
    });
    rows.push({ itemId: item.id, name: item.name, status: item.status, from: item.code, to: code, note: 'recoded' });
  }
  return rows;
}
