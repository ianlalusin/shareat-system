/**
 * person_credentials + sessions — how someone proves who they are, and how the server knows.
 * docs/tasks/138-identity-and-sessions.md, bible §7.1 (binding).
 *
 * ## The rule this exists to satisfy
 *
 * §7.1: *"A local-user PIN check issues a real, signed, server-side session token with a short
 * TTL, bound to the device and store. Acting identity is read from that token, server-side. **No
 * server action ever accepts an actor identity as a parameter.**"*
 *
 * v1 fixed the browser half of this (a verified `__session` cookie, mismatch → hard Unauthorized)
 * and never fixed the terminal half, where the PIN "session" lives in `localStorage` with nothing
 * signed. This is that half.
 *
 * ## ⭐ Credential KIND is a column, not the shape of the table
 *
 * Ian: *"retain the current 6-digit passcode and link to biometric next time so it's more
 * reliable."* **That is a constraint on this table today.** If PIN specifics were baked into
 * columns, adding biometrics later would be a migration plus a rewrite of every read; as a value,
 * it is a row.
 *
 * ⚠️ **This table makes ROOM for a biometric credential; it does not store biometric data.**
 * Templates remain Phase 4 under bible §5.3 — fingerprints readable only by a provisioned device
 * identity, and **face templates never mirrored or cached, ever.**
 *
 * ## ⛔ No fallback secret. Anywhere. Ever
 *
 * DEF-062: v1's passcode HMAC falls back to a key hardcoded in the source, does not fail closed,
 * and rotating it invalidates every stored hash — which is exactly why an unset secret stays
 * unset. **v2 fails closed at STARTUP** (bible §7 rule 9, `packages/core/src/env.ts`), because a
 * control whose degraded mode is a publicly-known key is not degraded, it is off.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { persons } from './persons';
import { stores } from './stores';

/**
 * One row per way a person can prove who they are. A person with no login is simply a person with
 * no row here (§7.1: *"a person with no login is a person row with no credential row"*).
 */
export const personCredentials = pgTable(
  'person_credentials',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    /**
     * ⭐ The extension point. `pin` and `firebase` are live; `biometric` is declared now so that
     * adding it in Phase 4 is a row and a service, not a schema change and a rewrite.
     */
    kind: text('kind', { enum: ['pin', 'firebase', 'biometric'] }).notNull(),

    /**
     * The store a TERMINAL credential belongs to. A 6-digit PIN is only meaningful inside one
     * store — v1 scopes its lookup hash the same way, *"so the same passcode in different stores
     * never correlates"*, which is good thinking and survives.
     * NULL for `firebase`, which is a person-level account rather than a per-store one.
     */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),

    /**
     * The verifier. bcrypt for `pin`. ⚠️ Never the secret itself, and never reversible.
     * NULL for `firebase`, where the provider holds the credential and we hold only `externalId`.
     */
    secretHash: text('secret_hash'),

    /**
     * ⭐ A deterministic, store-scoped lookup key, so a PIN check is **O(1) in candidates**.
     * v1 falls back to iterating bcrypt over every candidate (`matchLegacyPasscode`), which is
     * O(n) hashing per attempt and a timing surface. Here the lookup finds at most one row and
     * the bcrypt compare then runs exactly once.
     * ⛔ Keyed by a secret that MUST be set — see this file's header, and DEF-062.
     */
    lookupHash: text('lookup_hash'),

    /** The provider's own id for a `firebase` credential. Never used for `pin`. */
    externalId: text('external_id'),

    /** Revocation is a timestamp, not a delete: a credential that once existed is part of the
     *  audit trail for everything it authorised. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => persons.id, { onDelete: 'restrict' }),

    /**
     * ⭐ **Why, added by T-239 / DEF-229.** The table recorded *who* and *when* and never *why* —
     * an audit gap on the table that authorises everything. `attendance_credentials` has required a
     * reason since T-185; this one never had the column at all.
     *
     * ⚠️ **Human-typed on the unlink path, a fixed sentence on the supersede path.** `setPin` has no
     * `Actor`, so it names the act instead of a person: *"Superseded by a newly issued PIN."* —
     * exactly what `enrolFingerprint` does one table over. ⭐ **The words "for this store" came off
     * that sentence in T-302**, when a PIN stopped belonging to one; migration `0148` writes a
     * third fixed sentence for the same reason. Neither column is ever NULL once `revoked_at` is
     * set — except `revoked_by`, which is legitimately NULL on both actor-less paths (see below).
     */
    revokeReason: text('revoke_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * A store's lookup hashes must be unique, or a PIN check is ambiguous — and an ambiguous
     * credential check that picks the first match is how the wrong person gets attributed.
     *
     * ⭐ **PARTIAL, on `revoked_at is null` — T-237, DEF-224 and DEF-228.** Both of these were plain
     * indexes over the whole table until then, which made revocation a **one-way door**: the row
     * kept its uid or its lookup hash forever, so the same Firebase account could never be linked
     * again after an unlink, and the same six digits could never be re-issued after a PIN was
     * retired. `attendance_credentials` had already learned this and says why
     * (`attendance-credentials.ts:110`): *"a revoked card id may be reissued, which is what makes
     * revocation reversible in practice."*
     *
     * ⚠️ **Uniqueness among LIVE rows is unchanged, and that is the point.** Two live rows still
     * collide — one uid signs in as exactly one person, one PIN is exactly one credential in a
     * store. Only the history stops competing with the present.
     *
     * ⚠️ **The names deliberately did NOT change to `_live_unique`.**
     * `apps/erp/src/app/staff/actions.ts:58` matches `person_credentials_lookup_hash_unique` as a
     * literal in a regex over the raw driver error (DEF-177), and a rename would have silently
     * dropped that sentence back to a raw `23505` on a screen an owner uses. Renaming a thing other
     * code matches by name is not a tidy-up.
     *
     * ⛔ The `is not null` half of each predicate is not redundant: `external_id` is NULL on every
     * `pin` row and `lookup_hash` is NULL on every `firebase` row, so without it each index would
     * carry the whole table's revoked rows for no reason.
     */
    uniqueIndex('person_credentials_lookup_hash_unique')
      .on(t.lookupHash)
      .where(sql`${t.revokedAt} is null and ${t.lookupHash} is not null`),
    uniqueIndex('person_credentials_external_id_unique')
      .on(t.externalId)
      .where(sql`${t.revokedAt} is null and ${t.externalId} is not null`),
    index('person_credentials_person_id_idx').on(t.personId),
    index('person_credentials_store_id_kind_idx').on(t.storeId, t.kind),

    check('person_credentials_kind_check', sql`${t.kind} in ('pin', 'firebase', 'biometric')`),
    /**
     * ⛔ Each kind's shape, enforced here rather than hoped for in a service:
     *   - pin       → store-scoped, has both a verifier and a lookup key, no external id
     *   - firebase  → person-level, external id only, no local secret to leak
     *   - biometric → store-scoped and declared; its verifier lands with Phase 4
     */
    check(
      'person_credentials_shape_check',
      sql`
        (${t.kind} = 'pin' and ${t.storeId} is not null and ${t.secretHash} is not null
           and ${t.lookupHash} is not null and ${t.externalId} is null)
        or (${t.kind} = 'firebase' and ${t.externalId} is not null
           and ${t.secretHash} is null and ${t.lookupHash} is null)
        or (${t.kind} = 'biometric' and ${t.storeId} is not null)
      `,
    ),

    /**
     * ⛔ **A revocation with no reason is not an audit trail — T-239 / DEF-229.**
     *
     * ⚠️ **NOT the shape `attendance_credentials_revoke_check` uses, and the difference is
     * deliberate.** That one binds all three columns, so a revoked row must name a person. Here
     * `revokedBy` is legitimately NULL: `setPin` retires the PIN it replaces and has no principal to
     * name (see `repo/sessions.ts`' `revokeCredential`). Binding the reason to `revokedBy` would
     * refuse every PIN re-issue. **The reason pairs with the TIMESTAMP.** *When* and *why* are
     * always answerable; *who* only when there was a human.
     *
     * ⛔ The `is not null` in the second branch is NOT redundant with `btrim(…) <> ''`. A CHECK
     * passes when its expression is TRUE **or NULL**, and `btrim(null) <> ''` is NULL — so without
     * it a revoked row with a NULL reason is accepted and this constraint is decorative. It refuses
     * a *blank* reason while waving through a *missing* one, which is precisely backwards.
     * `credentials-admin.test.ts`' raw-SQL control exists to keep that from being re-introduced.
     *
     * ⚠️ Stricter than the sibling on purpose: `attendance_credentials` accepts `''` and trims only
     * in its domain layer — the service as the sole defence for the rule, which is the shape bible
     * §15.11 warns about. Logged in the register rather than left as a silent divergence.
     */
    check(
      'person_credentials_revoke_check',
      sql`(${t.revokedAt} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokeReason} is not null
              and btrim(${t.revokeReason}) <> '')`,
    ),
  ],
);

/**
 * A server-issued session. **The only thing `authorize()` ever trusts.**
 *
 * ⭐ Both credential kinds mint the SAME shape, so a capability check never learns how someone
 * signed in — *a check that has to know the credential kind is a check that will one day get it
 * wrong.* The kind is recorded anyway, because *"who is this?"* and *"how sure are we?"* are
 * different questions, and a future rule like "a void needs biometric confirmation" needs the
 * second one.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The opaque token's HASH. ⚠️ The token itself is returned once, at issue, and never stored —
     *  a sessions table readable by an operator must not be a table of live credentials. */
    tokenHash: text('token_hash').notNull(),

    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => personCredentials.id, { onDelete: 'restrict' }),
    /** Denormalised from the credential ON PURPOSE: it is what the session WAS issued under, and
     *  it must not change if the credential is later altered. */
    credentialKind: text('credential_kind', { enum: ['pin', 'firebase', 'biometric'] }).notNull(),

    /** The store a terminal session is bound to (§7.1: *"bound to the device and store"*). */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** The terminal it was issued to. Opaque, server-issued, and NOT the browser's own storage
     *  key — bible §5.3's rule against plaintext device secrets in `localStorage`. */
    deviceId: text('device_id'),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /** ⭐ Ian: a terminal session ends BOTH ways. This is the timer half. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** ⭐ And this is the explicit half — sign-out, or shift end. **Two mechanisms because they
     *  fail differently**: a timer catches a terminal nobody signed out of, and an explicit end
     *  closes the session the moment responsibility actually transfers rather than a TTL later. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedReason: text('ended_reason', { enum: ['signed_out', 'shift_end', 'revoked', 'superseded'] }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_person_id_idx').on(t.personId),
    index('sessions_store_id_idx').on(t.storeId),
    /** The sweep query: sessions still live at a given moment. */
    index('sessions_expires_at_idx').on(t.expiresAt),

    check('sessions_credential_kind_check', sql`${t.credentialKind} in ('pin', 'firebase', 'biometric')`),
    check(
      'sessions_ended_reason_check',
      sql`${t.endedReason} is null or ${t.endedReason} in ('signed_out', 'shift_end', 'revoked', 'superseded')`,
    ),
    /** Ended is a pair or neither — a session with a reason and no timestamp is not ended, and one
     *  with a timestamp and no reason cannot be explained to whoever asks why. */
    check(
      'sessions_ended_pair_check',
      sql`(${t.endedAt} is null and ${t.endedReason} is null) or (${t.endedAt} is not null and ${t.endedReason} is not null)`,
    ),
    check('sessions_expiry_after_issue_check', sql`${t.expiresAt} > ${t.issuedAt}`),
  ],
);

/** A live session at `now`. Exported so no caller re-derives "live" and gets it subtly different —
 *  the same reason `UNVERIFIED_STATUSES` is one constant in the sales-day repo. */
export const SESSION_IS_LIVE_SQL = sql`ended_at is null and expires_at > now()`;
