/**
 * T-455 S1 (migration 0217) - the customer lobby: per-store switches, check-in entries, pre-order lines, birthday-song requests, and
 * senior/PWD discount claims. docs/tasks/455-customer-lobby.md section 2 and the "Ian's answers (2026-10-24)" section.
 *
 * Every table carries its own org_id and composite (org_id, x) same-org FKs from birth (T-398), so none is in same-org-fk-exemptions.
 * No photo, no bytea and no price column anywhere (Ian, 24 Oct): the phone never prices, and no card picture is kept.
 * The forward-only status triggers, the claim cap, the partial UNIQUE indexes and the CHECKs that Drizzle cannot express are
 * hand-added in migration 0217 (see the NOTE comments).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { menuItemVariants, menuOptionValues } from './menu';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const LOBBY_ENTRY_SOURCES = ['lobby', 'staff'] as const;
export const LOBBY_ENTRY_STATUSES = ['waiting', 'called', 'seated', 'cancelled', 'removed', 'expired'] as const;
export const LOBBY_LINE_KINDS = ['package', 'a_la_carte'] as const;
export const LOBBY_BIRTHDAY_STATUSES = ['requested', 'accepted', 'declined', 'played', 'expired', 'cancelled'] as const;
export const LOBBY_CLAIM_KINDS = ['senior', 'pwd'] as const;
export const LOBBY_CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

/** Per-store lobby switches. Keyed (org_id, store_id); no id column. */
export const lobbyStores = pgTable(
  'lobby_stores',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    paused: boolean('paused').notNull().default(false),
    maxLiveEntries: integer('max_live_entries').notNull().default(60),
    birthdayEnabled: boolean('birthday_enabled').notNull().default(true),
    claimsEnabled: boolean('claims_enabled').notNull().default(true),
    /** Stamped by the POS lobby card's poll; the diner side refuses when it is older than 5 minutes. */
    posSeenAt: timestamp('pos_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.storeId], name: 'lobby_stores_pkey' }),
    check('lobby_stores_max_live_entries_check', sql`${t.maxLiveEntries} between 1 and 500`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'lobby_stores_store_id_same_org_fk' }).onDelete('restrict'),
  ],
);

export const lobbyEntries = pgTable(
  'lobby_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    source: text('source', { enum: LOBBY_ENTRY_SOURCES }).notNull(),
    /** 4 digits, a counter-side label, never a key. Unique among the store's live entries. */
    code: text('code').notNull(),
    /** NULL only once the entry is closed (the nightly purge). */
    displayName: text('display_name'),
    partySize: integer('party_size').notNull(),
    note: text('note'),
    /** Staff-parked walk-ins only. */
    phone: text('phone'),
    status: text('status', { enum: LOBBY_ENTRY_STATUSES }).notNull().default('waiting'),
    /** HMAC of the diner's cookie secret; NULL for staff entries and after the purge. */
    deviceHash: text('device_hash'),
    ipHash: text('ip_hash'),
    clientRequestId: text('client_request_id'),
    /** POS session id (text: the session lives in Firebase until P3). */
    sessionRef: text('session_ref'),
    standLabel: text('stand_label'),
    /** A bearer link: returned once to the owning cookie, then cleared. */
    handoffUrl: text('handoff_url'),
    handoffExpiresAt: timestamp('handoff_expires_at', { withTimezone: true }),
    calledAt: timestamp('called_at', { withTimezone: true }),
    seatedAt: timestamp('seated_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    actedByPersonId: uuid('acted_by_person_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('lobby_entries_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: hand-added in migration 0217 - trigger lobby_entries_forward_only (forward-only status, terminal frozen, key columns frozen,
    // purge columns NULL-able on closed rows).
    // The two live-only UNIQUE indexes below are partial (WHERE status IN ('waiting','called')): a closed entry frees its code and device.
    uniqueIndex('lobby_entries_live_code_unique').on(t.storeId, t.code).where(sql`${t.status} in ('waiting','called')`),
    uniqueIndex('lobby_entries_live_device_unique').on(t.storeId, t.deviceHash).where(sql`${t.status} in ('waiting','called')`),
    uniqueIndex('lobby_entries_client_request_unique').on(t.storeId, t.clientRequestId),
    index('lobby_entries_org_store_status_idx').on(t.orgId, t.storeId, t.status, t.createdAt),
    check('lobby_entries_source_check', sql`${t.source} in ('lobby','staff')`),
    check('lobby_entries_status_check', sql`${t.status} in ('waiting','called','seated','cancelled','removed','expired')`),
    check('lobby_entries_party_size_check', sql`${t.partySize} between 1 and 30`),
    check('lobby_entries_code_check', sql`${t.code} ~ '^[1-9][0-9]{3}$'`),
    check(
      'lobby_entries_display_name_check',
      sql`coalesce(char_length(${t.displayName}) between 1 and 40, ${t.status} in ('seated','cancelled','removed','expired'))`,
    ),
    check('lobby_entries_handoff_pair_check', sql`(${t.handoffUrl} is null) = (${t.handoffExpiresAt} is null)`),
    check('lobby_entries_note_check', sql`${t.note} is null or char_length(${t.note}) <= 60`),
    check('lobby_entries_phone_staff_only_check', sql`${t.phone} is null or ${t.source} = 'staff'`),
    check('lobby_entries_seated_needs_session_check', sql`${t.status} <> 'seated' or (${t.sessionRef} is not null and ${t.standLabel} is not null)`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'lobby_entries_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.actedByPersonId], foreignColumns: [persons.orgId, persons.id], name: 'lobby_entries_acted_by_person_id_same_org_fk' }).onDelete('restrict'),
  ],
);

/** One pre-order choice. No price column: the phone never prices. */
export const lobbyEntryLines = pgTable(
  'lobby_entry_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    qty: integer('qty').notNull(),
    lineKind: text('line_kind', { enum: LOBBY_LINE_KINDS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('lobby_entry_lines_org_id_id_unique').on(t.orgId, t.id),
    index('lobby_entry_lines_entry_idx').on(t.entryId),
    check('lobby_entry_lines_qty_check', sql`${t.qty} between 1 and 20`),
    check('lobby_entry_lines_line_kind_check', sql`${t.lineKind} in ('package','a_la_carte')`),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [lobbyEntries.orgId, lobbyEntries.id], name: 'lobby_entry_lines_entry_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.variantId], foreignColumns: [menuItemVariants.orgId, menuItemVariants.id], name: 'lobby_entry_lines_variant_id_same_org_fk' }).onDelete('restrict'),
  ],
);

/** The flavours / options chosen on one pre-order line, one row each. */
export const lobbyEntryLineOptions = pgTable(
  'lobby_entry_line_options',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    lineId: uuid('line_id').notNull(),
    optionValueId: uuid('option_value_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('lobby_entry_line_options_org_id_id_unique').on(t.orgId, t.id),
    unique('lobby_entry_line_options_line_value_unique').on(t.lineId, t.optionValueId),
    index('lobby_entry_line_options_option_value_idx').on(t.optionValueId),
    foreignKey({ columns: [t.orgId, t.lineId], foreignColumns: [lobbyEntryLines.orgId, lobbyEntryLines.id], name: 'lobby_entry_line_options_line_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.optionValueId], foreignColumns: [menuOptionValues.orgId, menuOptionValues.id], name: 'lobby_entry_line_options_option_value_id_same_org_fk' }).onDelete('restrict'),
  ],
);

export const lobbyBirthdayRequests = pgTable(
  'lobby_birthday_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').notNull(),
    celebrantName: text('celebrant_name'),
    status: text('status', { enum: LOBBY_BIRTHDAY_STATUSES }).notNull().default('requested'),
    /** NULL until accepted; KEPT afterwards (accepted -> played / expired / cancelled keep it). */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** When the cashier accepted; (scheduled_at IS NULL) = (accepted_at IS NULL). Always stamped by the trigger on requested -> accepted. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    playedAt: timestamp('played_at', { withTimezone: true }),
    actedByPersonId: uuid('acted_by_person_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('lobby_birthday_requests_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: hand-added in migration 0217 - trigger lobby_birthday_requests_forward_only (forward-only status, terminal frozen, stamps accepted_at).
    // The index below is partial (WHERE status <> 'cancelled'): one live request per entry.
    uniqueIndex('lobby_birthday_requests_live_entry_unique').on(t.entryId).where(sql`${t.status} <> 'cancelled'`),
    check('lobby_birthday_requests_status_check', sql`${t.status} in ('requested','accepted','declined','played','expired','cancelled')`),
    check('lobby_birthday_requests_celebrant_name_check', sql`${t.celebrantName} is null or char_length(${t.celebrantName}) <= 40`),
    check('lobby_birthday_requests_accepted_shape_check', sql`(${t.scheduledAt} is null) = (${t.acceptedAt} is null)`),
    check(
      'lobby_birthday_requests_status_time_check',
      sql`case when ${t.status} in ('accepted','played') then ${t.scheduledAt} is not null when ${t.status} in ('requested','declined') then ${t.scheduledAt} is null else true end`,
    ),
    check('lobby_birthday_requests_played_check', sql`(${t.status} = 'played') = (${t.playedAt} is not null)`),
    check(
      'lobby_birthday_requests_decline_reason_check',
      sql`case when ${t.status} = 'declined' then ${t.declineReason} is not null else ${t.declineReason} is null end`,
    ),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [lobbyEntries.orgId, lobbyEntries.id], name: 'lobby_birthday_requests_entry_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.actedByPersonId], foreignColumns: [persons.orgId, persons.id], name: 'lobby_birthday_requests_acted_by_person_id_same_org_fk' }).onDelete('restrict'),
  ],
);

export const lobbyDiscountClaims = pgTable(
  'lobby_discount_claims',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').notNull(),
    kind: text('kind', { enum: LOBBY_CLAIM_KINDS }).notNull(),
    /** Present only while status = 'pending' (row 353): NULL after approve, reject or expiry. */
    holderName: text('holder_name'),
    idNumber: text('id_number'),
    idLast4: text('id_last4').notNull(),
    ocrAssisted: boolean('ocr_assisted').notNull().default(false),
    status: text('status', { enum: LOBBY_CLAIM_STATUSES }).notNull().default('pending'),
    sessionRef: text('session_ref'),
    statutoryDinerRef: text('statutory_diner_ref'),
    rejectReason: text('reject_reason'),
    actedByPersonId: uuid('acted_by_person_id'),
    /** NOT NULL exactly when approved: the cashier ticked "I have seen the card". */
    cardSeenAt: timestamp('card_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    unique('lobby_discount_claims_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: hand-added in migration 0217 - triggers lobby_discount_claims_forward_only (pending -> approved | rejected | expired, terminal frozen)
    // and lobby_discount_claims_cap (pending + approved claims never exceed the entry's party_size).
    index('lobby_discount_claims_entry_idx').on(t.entryId),
    check('lobby_discount_claims_kind_check', sql`${t.kind} in ('senior','pwd')`),
    check('lobby_discount_claims_status_check', sql`${t.status} in ('pending','approved','rejected','expired')`),
    check('lobby_discount_claims_last4_check', sql`char_length(${t.idLast4}) between 1 and 4`),
    check(
      'lobby_discount_claims_personal_data_check',
      sql`case when ${t.status} = 'pending' then coalesce(char_length(${t.holderName}) between 1 and 40 and char_length(${t.idNumber}) between 1 and 40, false) else ${t.holderName} is null and ${t.idNumber} is null end`,
    ),
    check('lobby_discount_claims_card_seen_check', sql`(${t.status} = 'approved') = (${t.cardSeenAt} is not null)`),
    check(
      'lobby_discount_claims_approved_shape_check',
      sql`${t.status} <> 'approved' or (${t.sessionRef} is not null and ${t.statutoryDinerRef} is not null and ${t.actedByPersonId} is not null)`,
    ),
    check('lobby_discount_claims_rejected_reason_check', sql`${t.status} <> 'rejected' or ${t.rejectReason} is not null`),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [lobbyEntries.orgId, lobbyEntries.id], name: 'lobby_discount_claims_entry_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.actedByPersonId], foreignColumns: [persons.orgId, persons.id], name: 'lobby_discount_claims_acted_by_person_id_same_org_fk' }).onDelete('restrict'),
  ],
);

export type LobbyStore = typeof lobbyStores.$inferSelect;
export type LobbyEntry = typeof lobbyEntries.$inferSelect;
export type LobbyEntryLine = typeof lobbyEntryLines.$inferSelect;
export type LobbyEntryLineOption = typeof lobbyEntryLineOptions.$inferSelect;
export type LobbyBirthdayRequest = typeof lobbyBirthdayRequests.$inferSelect;
export type LobbyDiscountClaim = typeof lobbyDiscountClaims.$inferSelect;
