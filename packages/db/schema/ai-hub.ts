/**
 * T-640 (migration 0284, docs/tasks/640-ai-hub.md) - the AI hub: provider keys (encrypted), the models an admin activated, the caps, a per-store
 * switch, and the log of every model call.
 *
 *  - `ai_provider_keys`  one row per organisation and provider. `key_envelope` is the AES-256-GCM ciphertext (never the key); `key_last4` is the only
 *                        part ever shown. A repo LIST never selects `key_envelope`; one reader does (`getKeyEnvelope`), and the domain decrypts in memory.
 *  - `ai_models`         a model from the list in code, with the result of its last Test call. Active only after a test passed (CHECK), and active
 *                        exactly when it has a priority.
 *  - `ai_settings`       one row per organisation: the on/off switch, the monthly cap (pesos), the daily questions per person, the peso rate, the warning percent.
 *                        No row means the defaults in code; the first save writes it.
 *  - `ai_store_switches` a store the organisation switched OFF (or back on) for AI features. No row means on.
 *  - `ai_calls`          APPEND-ONLY. One row per model call attempt: who, which store, which feature, which provider and model, tokens, cost in micro-pesos,
 *                        time, tool calls, ok or the error code, and the prompt's SHA-256. NEVER the prompt text, never a key, never a reply.
 *
 * Money is a whole number (`cost_micro_php`: millionths of a peso) so no numeric column exists here (T-327 / T-371 guards never apply).
 *
 * NOTE: ENABLE + FORCE ROW LEVEL SECURITY, the org-isolation policies, the CHECKs the builder cannot say (regex shapes, the active/priority pair, ok/error pair),
 * the same-org composite FKs to persons and stores, the column-level UPDATE grants and the absence of UPDATE / DELETE on `ai_calls` are hand-added in migration 0284.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const AI_PROVIDER_NAMES = ['anthropic', 'google', 'openai'] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

export const aiProviderKeys = pgTable(
  'ai_provider_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    provider: text('provider', { enum: AI_PROVIDER_NAMES }).notNull(),
    /** `v1.<iv>.<tag>.<ciphertext>`: the encrypted key. Never returned to a browser, never logged, never in an audit row. */
    keyEnvelope: text('key_envelope').notNull(),
    /** The last four characters of the key: the only part ever shown. */
    keyLast4: text('key_last4').notNull(),
    setBy: uuid('set_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('ai_provider_keys_org_provider_unique').on(t.orgId, t.provider),
    check('ai_provider_keys_provider_check', sql`${t.provider} in ('anthropic', 'google', 'openai')`),
    check('ai_provider_keys_last4_check', sql`char_length(${t.keyLast4}) = 4`),
    check('ai_provider_keys_envelope_check', sql`${t.keyEnvelope} like 'v1.%' and char_length(${t.keyEnvelope}) between 20 and 4000`),
    foreignKey({ columns: [t.orgId, t.setBy], foreignColumns: [persons.orgId, persons.id], name: 'ai_provider_keys_set_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export const aiModels = pgTable(
  'ai_models',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    provider: text('provider', { enum: AI_PROVIDER_NAMES }).notNull(),
    /** A model name from the list in code (`MODEL_CATALOGUE`); the domain refuses any other. Never typed on screen. */
    model: text('model').notNull(),
    /** From the last PASSING test: did the model call the test tool? Null until a test has passed. */
    toolCalling: boolean('tool_calling'),
    /** The last time a test passed. A model can only be active when this is set. */
    passedAt: timestamp('passed_at', { withTimezone: true }),
    /** The result of the LAST test (null: never tested). A failed test never switches an active model off. */
    lastTestOk: boolean('last_test_ok'),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestLatencyMs: integer('last_test_latency_ms'),
    /** A plain sentence about the last test (never a provider's reply body: that can echo a key). */
    lastTestNote: text('last_test_note'),
    active: boolean('active').notNull().default(false),
    /** 1 is tried first. Set exactly when `active`. */
    priority: integer('priority'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('ai_models_org_provider_model_unique').on(t.orgId, t.provider, t.model),
    index('ai_models_org_active_idx').on(t.orgId, t.active, t.priority),
    check('ai_models_model_check', sql`char_length(${t.model}) between 1 and 80`),
    check('ai_models_active_needs_passed_test_check', sql`not ${t.active} or ${t.passedAt} is not null`),
    check('ai_models_priority_iff_active_check', sql`(${t.active} and ${t.priority} is not null and ${t.priority} >= 1) or (not ${t.active} and ${t.priority} is null)`),
    check('ai_models_note_check', sql`${t.lastTestNote} is null or char_length(${t.lastTestNote}) <= 300`),
    check('ai_models_latency_check', sql`${t.lastTestLatencyMs} is null or ${t.lastTestLatencyMs} >= 0`),
    // a model exists only while its provider has a key; removing a key removes its models first (the domain), so this restricts a stray delete
    foreignKey({ columns: [t.orgId, t.provider], foreignColumns: [aiProviderKeys.orgId, aiProviderKeys.provider], name: 'ai_models_provider_key_fk' }).onDelete('restrict'),
  ],
);

export const aiSettings = pgTable(
  'ai_settings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The organisation-wide switch for every AI feature. */
    enabled: boolean('enabled').notNull().default(true),
    /** The monthly cap, whole pesos (Manila calendar month). 0 means no AI call is allowed. */
    monthlyCapPesos: integer('monthly_cap_pesos').notNull().default(1000),
    /** Answered questions per person per Manila day; administrators are exempt. */
    dailyLimitPerPerson: integer('daily_limit_per_person').notNull().default(30),
    /** Pesos per US dollar, in hundredths (58.00 is 5800): the rate the cost of a call is worked out at. */
    pesosPerUsdHundredths: integer('pesos_per_usd_hundredths').notNull().default(5800),
    /** The share of the monthly cap, in percent, at which administrators are warned. */
    warnAtPercent: integer('warn_at_percent').notNull().default(80),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ai_settings_org_unique').on(t.orgId),
    check('ai_settings_cap_check', sql`${t.monthlyCapPesos} between 0 and 1000000`),
    check('ai_settings_daily_check', sql`${t.dailyLimitPerPerson} between 0 and 10000`),
    check('ai_settings_rate_check', sql`${t.pesosPerUsdHundredths} between 1000 and 30000`),
    check('ai_settings_warn_check', sql`${t.warnAtPercent} between 1 and 100`),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [persons.orgId, persons.id], name: 'ai_settings_updated_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export const aiStoreSwitches = pgTable(
  'ai_store_switches',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ai_store_switches_store_unique').on(t.storeId),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'ai_store_switches_store_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [persons.orgId, persons.id], name: 'ai_store_switches_updated_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'restrict' }),
    /** What asked, for the usage report: `ask_erp`, `hub.test`. A short lower-case name. */
    feature: text('feature').notNull(),
    provider: text('provider', { enum: AI_PROVIDER_NAMES }).notNull(),
    /** The model name (from the list in code). */
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    /** Millionths of a peso, worked out from the provider's token counts, the price in code and the peso rate in force. */
    costMicroPhp: bigint('cost_micro_php', { mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    ok: boolean('ok').notNull(),
    /** Set exactly when `ok` is false: the error kind (and status), e.g. `rate_limit_429`. Never a provider's reply text. */
    errorCode: text('error_code'),
    /** SHA-256 (64 lower-case hex characters) of the prompt AS SENT (after the privacy guard). The text itself is never stored. */
    promptSha256: text('prompt_sha256').notNull(),
    /** Attempts of one logical call (the fallback walk) share this reference. */
    groupRef: uuid('group_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_calls_org_created_idx').on(t.orgId, t.createdAt),
    index('ai_calls_org_person_created_idx').on(t.orgId, t.personId, t.createdAt),
    check('ai_calls_feature_check', sql`${t.feature} ~ '^[a-z][a-z0-9_.]{0,59}$'`),
    check('ai_calls_sha256_check', sql`${t.promptSha256} ~ '^[0-9a-f]{64}$'`),
    check('ai_calls_counts_check', sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.costMicroPhp} >= 0 and ${t.latencyMs} >= 0 and ${t.toolCalls} >= 0`),
    check('ai_calls_ok_error_check', sql`(${t.ok} and ${t.errorCode} is null) or (not ${t.ok} and ${t.errorCode} is not null and char_length(${t.errorCode}) <= 60)`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'ai_calls_store_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.personId], foreignColumns: [persons.orgId, persons.id], name: 'ai_calls_person_same_org_fk' }).onDelete('restrict'),
  ],
);

export type AiProviderKeyRow = typeof aiProviderKeys.$inferSelect;
export type AiModelRow = typeof aiModels.$inferSelect;
export type AiSettingsRow = typeof aiSettings.$inferSelect;
export type AiCallRow = typeof aiCalls.$inferSelect;
