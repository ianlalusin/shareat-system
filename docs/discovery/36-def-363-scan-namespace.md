# 36 — DEF-363: the card/fingerprint scan namespace

**Date:** 2026-09-17
**Unblocks:** DEF-363 · touches DEF-362 (the fix must not ship one without the other — see §5)
**Method:** read `resolveScan`, its seam test, the server-side resolver, the schema, both enrolment
functions and their tests at source · queried `shareat_dev` directly (local, read-only) for existing
collisions · traced the punch from the clock terminal's `<input>` through to the ingestor to settle
whether the hazard is display-only or attribution-real.

---

## 1. Verifying the defect at source

**Confirmed, exactly as filed.** `resolveScan` (`apps/erp/src/lib/terminal/lane.ts:165-172`):

```ts
return credentials.find((c) => c.cardId === value || c.matchToken === value) ?? null;
```

One flat `Array.prototype.find` across both fields, no kind scoping, first match wins by array
order. `lane.fingerprint-seam.test.ts:34-54` exists and says exactly what the register claims: it
gives two employments the same string — one as `cardId`, the other as `matchToken` — and shows the
resolved `employmentId` flips when the array order flips (`:51` vs `:53`). **The test is green and
characterises real behaviour; it asserts nothing safe.** The register is not wrong about its own
defect.

⭐ **And it is worse than a display bug — traced end to end, not assumed:**

- `apps/erp/src/app/clock/page.tsx:186` calls `resolveScan` to get `credential`.
- `:220` derives `method` from `credential.kind`, not from anything the hardware told the page.
- `:245` sends `credentialKind: credential.kind` — `resolveScan`'s guess — straight into the punch
  written to `/inbox`.
- The ingestor's resolver, `resolveCredentialAt` (`packages/db/src/repo/attendance-credentials.ts:90-108`),
  **is correctly kind-scoped**: `where kind = ${input.kind} and ${column} = ${input.ref}`, column
  chosen by kind. This is a well-built query.
- **But it trusts the kind the client sent.** In a collision, `(kind='card', ref=X)` and
  `(kind='fingerprint', ref=X)` are BOTH live, valid rows for different employments — so whichever
  kind `resolveScan` guessed is the kind the server faithfully, correctly-by-its-own-logic resolves
  against, and it lands on the wrong employment. **The server's kind-scoping is real protection
  against a corrupted `ref`; it is no protection at all against a corrupted `kind`, and `kind` is
  exactly what `resolveScan`'s ambiguity corrupts.** The misattribution reaches the punch, not just
  the screen.

---

## 2. Who else reads these two columns

**`resolveScan` is the only flat-namespace reader.** Grepped for every production site touching
`cardId`/`matchToken` together (`packages/db`, `packages/domain`, `apps/erp`): the ingestor's
resolver (kind-scoped, §1), the mirror publisher (`packages/domain/src/sync/publisher.ts:185-186`,
which only copies whichever field is non-null into the mirror doc — a writer, not a matcher, and it
inherits the shape check's guarantee that only one field is ever populated per row), and the two
enrolment functions (§5, which check their own column's uniqueness and nothing else). No other query
anywhere does `card_id = X or match_token = X`.

⚠️ **But "only one reader" does not make option (1) alone stronger — it makes option (1) alone
insufficient in a way worth stating precisely, because of *which* reader it is.** §1 traced why: the
one flat reader's mistake is not contained to a screen, it is the sole input to an otherwise-correct
server-side kind-scoped query. A hazard with one reader that IS the attribution authority is not
safer than a hazard with many readers downstream of a correct one — it is the same hazard with fewer
places to have caught it first.

---

## 3. What the cross-column constraint would actually be, and what it costs

**Cheaper than the register's own speculation ("a trigger or an exclusion constraint") — and this is
the finding most worth carrying into the spec.** `attendance_credentials_shape_check`
(`packages/db/schema/attendance-credentials.ts:130-139`) already guarantees, per row, **exactly one**
of `card_id` / `match_token` is non-null — a card row never has a token, a fingerprint row never has
a card id. That invariant means the two columns can be treated as one for uniqueness purposes without
inventing a new mechanism:

```sql
-- a generated, stored column — computed once at write time, indexed like any other
scan_value text generated always as (coalesce(card_id, match_token)) stored,
```

```sql
create unique index attendance_credentials_scan_value_live_unique
  on attendance_credentials (org_id, scan_value)
  where revoked_at is null and scan_value is not null;
```

**This one index can REPLACE both existing partial unique indexes, not join them.** Any violation of
either original constraint (two live cards sharing an id, or two live tokens sharing one) is *also* a
violation of this one, because both rows would share `scan_value`. Since `shape_check` guarantees
each live row only ever contributes to one of today's two indexes anyway, collapsing two into one
does not add index-maintenance work per insert — it removes an index. **Cost on write: one generated
column (computed, not stored-then-recomputed — Postgres computes it once, at write time) plus
maintenance of one partial unique index where there were two.** Not measured by running it (this lane
is research-only, no writes to any database) — the spec-writing lane should confirm the migration
plan against a real `EXPLAIN`, but there is no structural reason for this to be expensive on a
clock-in path table that Q4 shows currently holds two rows in dev.

⚠️ **One naming consequence worth flagging now rather than at review:** `enrolCard`'s catch matches
the literal string `attendance_credentials_card_live_unique` (§5). Renaming/replacing that index
means that match string changes, and — more importantly — the collision that fires it might now be a
**fingerprint** token, not another card. The message text has to stop assuming the other party is a
card.

---

## 4. What is already in the table

**`shareat_dev` (queried directly, read-only): 1 live `card` credential, 1 live `fingerprint`
credential. Zero collisions** — checked with a join on `coalesce(card_id, match_token)` within the
same org among live rows, same-column and cross-column both: `0` rows. **Adding the constraint today
would be a complete no-op in this database** — nothing for a migration to resolve.

**Production is not queryable from here** (`DATABASE_URL` points at `shareat_dev`, SSH blocked for
agents) — stated plainly rather than estimated. The adjacent fact already measured, cited correctly
rather than substituted for a number this lane doesn't have: DEF-363's own text says T-314 counted
**703 real sessions over 35 days with card, QR and passcode usage at exactly zero** — so a live
collision requires at least one enrolled card AND one enrolled fingerprint to exist in production at
all, and by that measurement neither has yet been used in anger. This corroborates §4's dev-database
reading; it does not substitute for checking production, which only Ian can do.

---

## 5. What breaks if we add the constraint

**No existing test or fixture.** Grepped `packages/domain/tests/integration/attendance-credentials.test.ts`
for every `enrolCard`/`enrolFingerprint` call: card ids are unique generated strings (`uid('c')`),
match tokens are 128-bit random (`newMatchToken()`) — nothing in the suite deliberately creates a
live cross-column collision **through the actual enrolment functions**. The one test that
demonstrates the collision, `lane.fingerprint-seam.test.ts:34-54`, builds its two `MirroredCredential`
objects **by hand, in memory** — it never calls `enrolCard`/`enrolFingerprint` and never touches the
database, so it is unaffected by a schema constraint either way.

⛔⛔ **The fix cannot ship without touching `enrolFingerprint`, and DEF-362 is why.** Today,
`enrolCard` (`packages/domain/src/attendance/credentials.ts:148-176`) catches its own column's
violation and turns it into a `CredentialError`; `enrolFingerprint` (`:187-228`) has **no try/catch
at all** — DEF-362, independently found and already on the register. **Add the cross-column
constraint alone and this gets WORSE before it gets better for one write path**: a fingerprint
enrolment that collides with a live card id (or, after the flip, with a live token) currently fails
*silently permitted*; after the constraint, it raises a raw Postgres unique-violation with **no**
catch, straight out of the domain layer — the exact failure mode `enrolCard`'s catch exists to
prevent, and Q5's own instruction (*"must produce a `CredentialError`, never a bare constraint
violation"*) is failed by `enrolFingerprint` specifically. **DEF-363's fix and DEF-362's fix are one
piece of work, not two** — shipping the constraint requires giving `enrolFingerprint` a catch block
regardless of whether that catch is the one DEF-362's own disposition already plans (`mintUniqueToken`
via T-314 slice E) or a narrower one written now. Whichever lane takes DEF-363 should take DEF-362 in
the same pass, or the constraint makes a known, already-filed gap actively worse rather than closing
it.

**And `enrolCard`'s existing catch needs its message reworded, not just its match string** (§3) —
*"That card is already enrolled to somebody at this organisation"* becomes false the day the
colliding party is a fingerprint.

---

## 6. What this doc is NOT recommending, and why

- ⛔ **Not recommending format-based disambiguation** (e.g. "a fingerprint token is 32 lowercase hex
  characters, so treat anything matching that shape as a token first"). `cardId` has no format
  constraint anywhere — `enrolCard` only checks non-empty after `trim()`
  (`packages/domain/src/attendance/credentials.ts:145-146`) — and DEF-363's own severity assessment
  is that this is **reachable deliberately**: *"a card id is whatever is written on the card... anyone
  able to program a card and learn another person's token can mint a credential that resolves to
  them."* An attacker choosing the colliding value can trivially choose one that also matches a
  token's shape. A heuristic reduces accidental collision; it does nothing against the deliberate
  case the register files this for.
- ⚠️ **Pressure-testing "(1) kind-aware `resolveScan`, as well as (2)" — the recommendation asked for
  this, not agreement by default.** As commonly meant — "resolve only against the column the device
  independently knows it's reading" — **this is not buildable with today's hardware architecture,
  and that is worth saying plainly rather than assumed away.** `apps/erp/src/app/clock/page.tsx:372-374`'s
  own comment states the design reason: *"a USB badge reader and a QR scanner both TYPE. That is how
  the hardware actually behaves"* — one generic text `<input>` (`:375-383`), no separate channel per
  reader, and the fingerprint reader (per the T-314 seam test's own docstring) feeds the same box
  the same way. **The device has no independent signal of which physical method produced a given
  string; it only ever has the string.** So "kind-aware" cannot mean "ask the hardware" — the
  honest, buildable version is narrower: **refuse instead of guessing when a scan matches more than
  one live credential of different kinds**, rather than silently taking `Array.find`'s first result.
  ⭐ **That version is genuinely still worth building, but it is not independent of (2) the way bible
  §15.11 usually means "two layers for one risk"** — it can only ever *detect* the state (2) is
  supposed to make unreachable; it adds a second chance to catch a collision that slips through a
  migration gap or a moment before the constraint is live, not a second, independently-sufficient
  guarantee. **Recommendation for the spec to weigh, not decide here: (2) is necessary; the narrower,
  honest form of (1) — refuse on multi-kind ambiguity rather than guess — is cheap and worth adding,
  but should be named for what it actually is (a second detector, not a second lock) rather than as
  the kind-aware resolution the register's phrasing suggests.**
- ⛔ **Not proposing to touch `authorize()` or any capability.** DEF-363 is a data-integrity /
  identity-resolution defect, not an access-control one — nobody's *permission* is wrong, an
  *attribution* is. Out of this doc's lane regardless (RULES §1 rule 14 territory if it were).
