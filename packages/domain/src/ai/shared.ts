/**
 * The AI hub's shared pieces. T-640. The gate every hub write goes through, the master key, the defaults, and the pure money and cap arithmetic.
 *
 * ⛔ A key is decrypted only inside a function of this folder, held in a local variable for one request, and never returned, logged, stored in an audit row or put in a message.
 */
import { AuthorizationError, authorize, isAdministrative, type Actor } from '@shareat/auth';
import { env } from '@shareat/core/env';
import { accessRepo, type Tx } from '@shareat/db';
import { isAiProvider, parseMasterKey, type AiProvider, type HttpClient } from '@shareat/ai';
import { refuse } from '../shared/refusal';

/** Runs a function in a fresh transaction for one org. The hub's two network paths (a Test call, a real call) never hold a transaction open across the provider's reply. */
export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** Injectable for tests: the master key (null = not set) and the HTTP client (a fake; no real network in tests). */
export interface HubDeps {
  readonly masterKey?: Buffer | null;
  readonly http?: HttpClient;
}

/** What an organisation with no `ai_settings` row gets. Equal to the table's own defaults (a test pins the two together). */
export const AI_DEFAULTS = {
  enabled: true,
  monthlyCapPesos: 1000,
  dailyLimitPerPerson: 30,
  pesosPerUsdHundredths: 5800,
  warnAtPercent: 80,
} as const;

export interface HubSettings {
  enabled: boolean;
  monthlyCapPesos: number;
  dailyLimitPerPerson: number;
  pesosPerUsdHundredths: number;
  warnAtPercent: number;
}

/**
 * The gate for every hub read and write: the capability (super admin only), then a role of admin or above. The second check is belt and braces: a person grant of `manage_ai_hub`
 * given by mistake to a manager still opens nothing, because the hub holds the company's keys and the spending cap. ⛔ Nothing else may run before this.
 */
export async function authorizeHub(tx: Tx, actor: Actor): Promise<void> {
  await authorize(tx, actor, 'manage_ai_hub', {});
  const role = (await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role;
  if (!isAdministrative(role)) {
    throw new AuthorizationError(
      'manage_ai_hub: the person holds the capability but not an admin or super admin role',
      'manage_ai_hub',
      'Only a super admin can use the AI hub.',
    );
  }
}

export type MasterKeyState = 'ok' | 'missing' | 'invalid';

/** The server's master key and what state it is in. The key itself never leaves this module's callers. */
export function masterKeyOf(deps: HubDeps = {}): { state: MasterKeyState; key: Buffer | null } {
  if (deps.masterKey !== undefined) return deps.masterKey ? { state: 'ok', key: deps.masterKey } : { state: 'missing', key: null };
  const raw = env().AI_KEYS_MASTER_KEY;
  if (raw === undefined) return { state: 'missing', key: null };
  const key = parseMasterKey(raw);
  return key ? { state: 'ok', key } : { state: 'invalid', key: null };
}

/** The master key, or a refusal in a sentence (the hub works with nothing else set up when the key is absent). */
export function requireMasterKey(deps: HubDeps = {}): Buffer {
  const { state, key } = masterKeyOf(deps);
  if (key) return key;
  if (state === 'invalid') {
    throw refuse(
      'ai hub: AI_KEYS_MASTER_KEY is not a 32-byte key',
      'The encryption key set on the server for the AI hub is not valid. It must be 64 hex characters (or base64 of 32 bytes). Ask whoever runs the server to fix it, then try again.',
    );
  }
  throw refuse(
    'ai hub: AI_KEYS_MASTER_KEY is not set',
    'The AI hub cannot store or use keys yet: the server has no encryption key set for it (AI_KEYS_MASTER_KEY). Ask whoever runs the server to set it, then try again.',
  );
}

/** A provider name from a form, or a refusal. */
export function providerOf(raw: string): AiProvider {
  if (!isAiProvider(raw)) throw refuse(`ai hub: unknown provider ${raw.slice(0, 20)}`, 'Choose Anthropic, Google or OpenAI.');
  return raw;
}

export const MICRO = 1_000_000;

/** Micro-pesos as an exact decimal string with two places ("12.34"), rounded to the nearest centavo, worked in BigInt (no float touches money). */
export function pesosText(micro: number): string {
  const centavos = (BigInt(Math.max(0, Math.floor(micro))) + 5_000n) / 10_000n;
  return `${centavos / 100n}.${String(centavos % 100n).padStart(2, '0')}`;
}

export type UsageLevel = 'ok' | 'warn' | 'capped';

/** Where this month's spend stands against the cap: at or over the cap is `capped` (a cap of 0 is always capped), at or over the warning share is `warn`. Whole numbers only. */
export function usageLevel(spentMicro: number, capPesos: number, warnAtPercent: number): UsageLevel {
  const cap = BigInt(capPesos) * BigInt(MICRO);
  const spent = BigInt(Math.max(0, Math.floor(spentMicro)));
  if (spent >= cap) return 'capped';
  if (spent * 100n >= cap * BigInt(warnAtPercent)) return 'warn';
  return 'ok';
}

/** The percent of the cap spent, rounded down, never above 100 (0 when the cap is 0). */
export function percentOfCap(spentMicro: number, capPesos: number): number {
  if (capPesos <= 0) return 0;
  const p = (BigInt(Math.max(0, Math.floor(spentMicro))) * 100n) / (BigInt(capPesos) * BigInt(MICRO));
  return Number(p > 100n ? 100n : p);
}

export function settingsOrDefaults(row: HubSettings | null): HubSettings {
  return row ? { enabled: row.enabled, monthlyCapPesos: row.monthlyCapPesos, dailyLimitPerPerson: row.dailyLimitPerPerson, pesosPerUsdHundredths: row.pesosPerUsdHundredths, warnAtPercent: row.warnAtPercent } : { ...AI_DEFAULTS };
}

/** 5800 as "58.00". */
export function rateText(hundredths: number): string {
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}
