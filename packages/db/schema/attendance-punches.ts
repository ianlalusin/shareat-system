/**
 * attendance_punches — the raw fact the whole phase rests on. T-156.
 * `docs/tasks/156-attendance-punches.md`, `docs/plans/phase-4-attendance.md` §4.1.
 *
 * ## The one rule this table exists to hold
 *
 * Bible §5.1, Lane B, quoted rather than paraphrased because the whole design is in it:
 *
 * > *"Events record **raw facts only** — 'staff X presented fingerprint at time T on device D.'
 * > They **never** carry a computed business outcome (late/OT/hours/pay). **Postgres adjudicates,
 * > always**, on the server, with the full ruleset."*
 *
 * And §4.2 rule 9 names this table specifically:
 *
 * > *"**Append-only where the audit trail matters** — ledger entries, stock movements, **attendance
 * > punches**. Correction = compensating entry, never `UPDATE`."*
 *
 * ⛔ **So there is no `computed_hours`, no `is_late`, no `shift_start_hour`, and no status meaning
 * "processed into pay".** If a reviewer can point at a column here and ask *"what rule produced
 * this value?"*, the column is in the wrong table. `attendance_days` (T-157) holds everything
 * derived. A test reads `information_schema.columns` against a pinned allow-list, so adding such a
 * column fails a test rather than a code review.
 *
 * ## Why v1 has no equivalent
 *
 * v1 has `attendanceSessions` (the adjudicated day) carrying `rawClockIn`/`rawClockOut`/`rawTapIds`,
 * plus an `attendancePunchLog/{clientPunchId}` document that exists **only** as an idempotency
 * marker. The raw fact of a live punch is therefore never a first-class record — it is folded into
 * the session on arrival, and a day that adjudicated wrongly cannot be re-derived from a record
 * that was overwritten by its own conclusion.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { employments } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { sessions } from './sessions';
import { stores } from './stores';

/**
 * How the person identified themselves. `manual` is a back-office entry by a manager.
 *
 * ⛔ **No `pin`.** D1, decided 2026-08-29 — Ian: *"in v2 only fingerprint face and card will be mode
 * of attendance no pin"*. Removed from the CHECK rather than switched off, so a PIN punch is
 * unrepresentable (migration 0085). `person_credentials.kind = 'pin'` still exists for signing in
 * to the app; clocking in is a different act.
 */
export const PUNCH_METHODS = ['nfc', 'qr', 'fingerprint', 'face', 'manual'] as const;
export type PunchMethod = (typeof PUNCH_METHODS)[number];

/**
 * ⭐ Breaks are punches, which is how v2 gets an offline break path for free.
 * Discovery 15 §1: *"v1 has **no offline path for breaks at all**"* — its offline UI omits the
 * Break buttons entirely (`time-clock/page.tsx:804`, comment "Breaks are hidden offline
 * (deferred)"). Here a break needs no new machinery: it is a punch with a different intent.
 */
export const PUNCH_INTENTS = ['in', 'out', 'break_start', 'break_end'] as const;
export type PunchIntent = (typeof PUNCH_INTENTS)[number];

export const PUNCH_SOURCES = ['online', 'offline_replay', 'manual_entry', 'import'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];

/** Ordinary device clock skew. Beyond this the device is broken, not merely imprecise. */
export const FUTURE_PUNCH_TOLERANCE = "interval '5 minutes'";

export const attendancePunches = pgTable(
  'attendance_punches',
  {
    /** uuid v7 — time-ordered by construction, which is how this table is read. */
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    /** ⭐ Resolved at INGEST, not at read. The employment a punch belongs to must not move if the
     *  person is later re-hired — a 2026 punch belongs to the 2026 job. */
    employmentId: uuid('employment_id')
      .notNull()
      .references(() => employments.id, { onDelete: 'restrict' }),

    /**
     * ⛔ **The idempotency key, and it is a UNIQUE constraint rather than a timer.**
     *
     * Bible §4.2 rule 10, verbatim: *"Idempotency keys are UNIQUE constraints… **This replaces
     * debounce/throttle guesswork.**"* v1 uses an 8-second debounce **and** a marker document; the
     * debounce is the half that caused a production incident on 2026-08-19, when clock-OUT wrote
     * its `lastClockPunchAt` stamp non-transactionally and a concurrent clock-IN read a stale
     * stamp and opened a duplicate session. Landmine #21: *"every temporal guard is a server/DB
     * constraint; UI is a courtesy."*
     *
     * Client-generated, and it is also the Firestore inbox document id (T-180), so the SDK's own
     * retry writes to the same path rather than creating a second event.
     */
    clientPunchId: text('client_punch_id').notNull(),

    /** When the credential was presented. ⚠️ A DEVICE clock — see the CHECK below and `receivedAt`. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    /**
     * Computed on write from `occurredAt`. Bible §6: *"Where a day boundary carries meaning, the row
     * has an explicit `business_date` computed on write — **never re-derived per query at read
     * time**."* ⚠️ This is the 05:00 SHIFT day, not the midnight business day.
     */
    shiftDay: date('shift_day').notNull(),

    method: text('method', { enum: PUNCH_METHODS }).notNull(),

    /**
     * ⭐ **The name is the specification: the device ASSERTS, the server ADJUDICATES.**
     *
     * Bible §5.1's own example of a raw fact — *"staff X presented fingerprint at time T on device
     * D"* — contains no intent at all, because intent is already an interpretation. An offline
     * terminal cannot make it reliably: v1's offline branch *"has no way to know if this is really
     * a clock-IN or clock-OUT (server state is unknown offline), so **both buttons are offered**
     * and whichever the operator taps is queued as-is"*.
     *
     * Which button was pressed is real information and is not thrown away. But T-157 may conclude a
     * punch asserted `in` was the day's `out`, and record that it did. ⛔ Nothing outside T-157 may
     * read this column to decide anything — a screen showing "clocked in at 09:02" reads
     * `attendance_days`.
     */
    assertedIntent: text('asserted_intent', { enum: PUNCH_INTENTS }).notNull(),

    /** The provisioned terminal. NULL for a back-office manual entry. */
    deviceId: text('device_id'),
    source: text('source', { enum: PUNCH_SOURCES }).notNull(),

    /**
     * The **verified** actor who worked the terminal, from `resolveActor` (T-138). v1 calls this
     * `clockInByUid` and takes it as a client-supplied parameter — landmine #17, *"the server
     * cannot verify who actually performed the action."*
     */
    capturedBySessionId: uuid('captured_by_session_id').references(() => sessions.id, {
      onDelete: 'restrict',
    }),

    /** When the SERVER first saw it. ⭐ `receivedAt − occurredAt` **is** the offline lag, and it is
     *  the only honest measure of it — everything else is the device's opinion. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),

    /** A correction points at what it corrects. There is no edit and no delete. */
    supersedesPunchId: uuid('supersedes_punch_id'),
    /** Set ONLY on the correcting row, never on the corrected one. */
    voidReason: text('void_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => persons.id, { onDelete: 'restrict' }),
  },
  (t) => [
    /** ⛔ The dedupe. Everything else about replay safety follows from this one index. */
    uniqueIndex('attendance_punches_client_punch_id_unique').on(t.clientPunchId),

    index('attendance_punches_store_shift_day_idx').on(t.storeId, t.shiftDay),
    index('attendance_punches_employment_occurred_idx').on(t.employmentId, t.occurredAt),
    /** The ingest-lag monitor: an event that arrived long after it happened is alertable. */
    index('attendance_punches_store_received_idx').on(t.storeId, t.receivedAt),

    check('attendance_punches_method_check', sql`${t.method} in ('nfc','qr','fingerprint','face','manual')`),
    check('attendance_punches_intent_check', sql`${t.assertedIntent} in ('in','out','break_start','break_end')`),
    check('attendance_punches_source_check', sql`${t.source} in ('online','offline_replay','manual_entry','import')`),

    /**
     * ⛔ A punch from the FUTURE is refused at the database. Five minutes is ordinary clock skew;
     * an hour is a broken device, and accepting it would let a terminal book tomorrow's shift.
     * ⚠️ Note what is deliberately NOT here: an upper bound on how OLD a punch may be. v1 rejects
     * anything past 72h and dead-letters it (landmine #14, and the event was in a private IndexedDB
     * so it was then unreachable). In v2 the event lives in Firestore, so 72h is an adjudication
     * FLAG, not a data-loss cliff.
     */
    check(
      'attendance_punches_not_future_check',
      sql`${t.occurredAt} <= ${t.receivedAt} + interval '5 minutes'`,
    ),

    /** Both or neither — a void reason with nothing voided explains a correction that never happened. */
    check(
      'attendance_punches_correction_pair_check',
      sql`(${t.supersedesPunchId} is null) = (${t.voidReason} is null)`,
    ),
    check('attendance_punches_no_self_supersede_check', sql`${t.supersedesPunchId} is null or ${t.supersedesPunchId} <> ${t.id}`),

    /** One correction per punch. A chain corrects the correction, and stays readable. */
    uniqueIndex('attendance_punches_supersedes_unique')
      .on(t.supersedesPunchId)
      .where(sql`${t.supersedesPunchId} is not null`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_punches_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'attendance_punches_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'attendance_punches_store_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `employment_id` FK (RLS checks only this row's org_id); references `employments_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.employmentId],
      foreignColumns: [employments.orgId, employments.id],
      name: 'attendance_punches_employment_id_same_org_fk',
    }).onDelete('restrict'),
    // T-398 S3 / DEF-491, migration 0213 - same-org twin of the single-column `supersedes_punch_id` FK (RLS checks only this row's org_id); references `attendance_punches_org_id_id_unique`.
    foreignKey({
      columns: [t.orgId, t.supersedesPunchId],
      foreignColumns: [t.orgId, t.id],
      name: 'attendance_punches_supersedes_punch_id_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: attendance_punches_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0213 (T-398 S3 / DEF-491), no Drizzle mirror here.
    // Trivially true (id alone is already unique); it exists so the composite `(org_id, "<col>") REFERENCES attendance_punches (org_id, id)`
    // same-org FKs declared beside their own tables have a real unique target.
  ],
);
