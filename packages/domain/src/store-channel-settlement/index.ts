/**
 * Store channel-settlement wiring — T-564 (T-515 re-applied on main).
 *
 * ⚠️ **STORED, NOT YET READ BY INTAKE.** The store key, match labels, file hints and email-ingest opt-in are kept so the payout
 * parser and the wastage email ingest can read them later; nothing resolves a store from them today, and this module has no
 * resolver on purpose. The only reader is `settlementWiringWarnings`, which makes the settlement preview say what is missing.
 *
 * The platform and the statement store code are NOT here: they are `sales_channels.platform` / `platform_store_code`
 * (T-511 S2a), which main already owns and audits.
 *
 * This is configuration, so the write is `manage_store_settings` (store-scoped, manager yes), the same capability as the sales
 * channels it routes. The database owns uniqueness; this module owns the sentences, the audit row and the one rule the database
 * cannot express as a column check: the store key is immutable once saved.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, storeChannelSettlementRepo, storesRepo, type Tx, type StoreChannelSettlementConfigRow } from '@shareat/db';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SETTINGS_STORE_SETTLEMENT_RULES } from '../field-rules/settings';
import { refuse } from '../shared/refusal';

export type StoreChannelSettlementConfig = StoreChannelSettlementConfigRow;

function cleanList(raw: readonly string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((s) => s.trim()).filter(Boolean))];
}

/** ⚠️ Only to recognise the unique index refusing a key (a race the pre-read cannot see); the cause chain is walked. */
function isStoreKeyTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'store_channel_settlement_configs_org_key_unique') return true;
  }
  return false;
}

export async function getStoreChannelSettlementConfig(
  tx: Tx,
  actor: Actor,
  storeId: string,
): Promise<StoreChannelSettlementConfig | null> {
  return storeChannelSettlementRepo.getConfigByStore(tx, actor.orgId, storeId);
}

/**
 * What is missing from a store's wiring, in plain words. A pure read: it never blocks a post, it only tells the person why a
 * payout statement could not later be matched to this store. No row means no store key.
 */
export function settlementWiringWarnings(config: StoreChannelSettlementConfig | null): string[] {
  if (!config) {
    return [
      'This store has no store key yet. Add one under Settings, then Sales channels, in the Settlement wiring panel; without it a payout statement cannot be matched to this store.',
    ];
  }
  if (config.matchLabels.length === 0 && config.fileHints.length === 0) {
    return [
      'This store has a key but no outlet-name labels and no file hints, so there is nothing to match a payout statement to this store by. Add them under Settings, then Sales channels.',
    ];
  }
  return [];
}

export interface SaveStoreChannelSettlementInput {
  storeId: string;
  storeKey: string;
  matchLabels?: readonly string[];
  fileHints?: readonly string[];
  wastageEmailIngestEnabled?: boolean;
}

function payload(c: { matchLabels: string[]; fileHints: string[]; wastageEmailIngestEnabled: boolean }) {
  return { matchLabels: c.matchLabels, fileHints: c.fileHints, wastageEmailIngestEnabled: c.wastageEmailIngestEnabled };
}

function keyCannotChange(saved: string) {
  return refuse(
    'saveStoreChannelSettlement: the store key is immutable once saved.',
    `This store's key is “${saved}” and it cannot be changed once saved, because other records use it by that name.`,
  );
}

export async function saveStoreChannelSettlement(
  tx: Tx,
  actor: Actor,
  input: SaveStoreChannelSettlementInput,
): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId });

  const store = await storesRepo.getById(tx, actor.orgId, input.storeId);
  if (!store) throw refuse('saveStoreChannelSettlement: store not found.', 'That store does not exist in this organisation.');

  const existing = await storeChannelSettlementRepo.getConfigByStore(tx, actor.orgId, input.storeId);
  // Omitted lists keep what is saved (like the email opt-in); a list that IS given replaces it, and an empty one clears it.
  const matchLabels = input.matchLabels === undefined ? (existing?.matchLabels ?? []) : cleanList(input.matchLabels);
  const fileHints = input.fileHints === undefined ? (existing?.fileHints ?? []) : cleanList(input.fileHints);
  const { storeKey } = assertFieldRules(SETTINGS_STORE_SETTLEMENT_RULES, {
    storeKey: input.storeKey.trim().toLowerCase(),
    matchLabels: matchLabels.join(','),
    fileHints: fileHints.join(','),
  });
  if (!storeKey) throw new Error('saveStoreChannelSettlement: a checked store key came back empty.');

  if (existing && existing.storeKey !== storeKey) throw keyCannotChange(existing.storeKey);

  // Only to WORD the refusal: the unique (org, store_key) index is the authority, including for a race this read cannot see.
  const clash = (await storeChannelSettlementRepo.listConfigs(tx, actor.orgId)).find(
    (c) => c.storeId !== input.storeId && c.storeKey === storeKey,
  );
  if (clash) {
    throw refuse('saveStoreChannelSettlement: key held by another store.', `Another store already uses the key “${storeKey}”. A store key must be unique.`);
  }

  const next = {
    matchLabels,
    fileHints,
    wastageEmailIngestEnabled: input.wastageEmailIngestEnabled ?? existing?.wastageEmailIngestEnabled ?? false,
  };
  // Same values: nothing to write (no `updated_at` move, no audit row).
  if (existing && JSON.stringify(payload(existing)) === JSON.stringify(next)) return { wrote: false };

  try {
    await storeChannelSettlementRepo.upsertConfig(tx, { orgId: actor.orgId, storeId: input.storeId, storeKey, ...next });
  } catch (err) {
    if (isStoreKeyTaken(err)) {
      throw refuse('saveStoreChannelSettlement: the unique index refused the key.', `Another store already uses the key “${storeKey}”. A store key must be unique.`);
    }
    throw err;
  }

  // The upsert never writes `store_key` on a conflict, so two first saves racing for one store can leave the OTHER person's key
  // stored. Re-read what is really there: the audit row records it, and a key that was not stored is refused, not recorded.
  const saved = await storeChannelSettlementRepo.getConfigByStore(tx, actor.orgId, input.storeId);
  if (!saved) throw new Error('saveStoreChannelSettlement: the saved row could not be read back.');
  if (saved.storeKey !== storeKey) throw keyCannotChange(saved.storeKey);

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'store_settlement.wiring_saved',
    storeId: input.storeId,
    entityId: input.storeId,
    before: existing ? { storeKey: existing.storeKey, ...payload(existing) } : null,
    after: { storeKey: saved.storeKey, ...payload(saved) },
    source: 'web',
  });
  return { wrote: true };
}
