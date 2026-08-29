# T-185 — Credential enrolment, and the mirror a terminal resolves a badge against

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> ⚠️ **RENUMBERED 2026-08-30: was T-164.** Both this lane and the inventory lane had taken T-164; attendance moved because it is finished while inventory is still being written. ⛔ **Commit messages predating the rename still say T-164** — git history is not rewritten.
> **Depends on:** T-159 (device identity + the `biometricMirror` rules), T-181 (outbox), T-182 (ingestor).
> **Unblocked by:** bible §13 row 164 — *"add cardid, update bible"* — which put the card id in
> hot-set item 2. Until that amendment this task could not be built.

## ⚠️ This task moved AHEAD of T-184, and the reason is a hard dependency

The plan lists Wave 4 as T-184 (the terminal) then T-185 (enrolment). **That order cannot work.**

Phase 4's exit gate is *"a terminal clocks in with the network pulled and reconciles cleanly on
reconnect."* Bible §13 row 164 establishes why the card is the credential that meets it: face is
online-only permanently, and fingerprint needs the APK that D2 parked. So the offline punch is
**scan a badge → resolve it to a person → write an inbox event**, entirely on the device.

⛔ **Nothing produces the thing being resolved against.** Checked at HEAD:

| What the terminal needs | State today |
|---|---|
| A card id stored against a person | ⛔ No `card` credential exists anywhere. `person_credentials.kind` is `('pin','firebase','biometric')` |
| Something publishing it to `biometricMirror` | ⛔ `MIRROR_ENTITIES` is `('roster','attendance_config','day_feed')` — no credential entity |
| A rule guarding that path | ✅ **Exists and is empty.** T-159 wrote `biometricMirror/{storeId}/credentials/{docId}`, terminal-only |

Building T-184 first would produce a terminal whose only offline identification method is *"pick
your name from the roster"* — which is a bearer credential with no bearer, clockable by anyone
standing at the tablet. That is worse than v1 and would have to be torn out. **So enrolment lands
first, and T-184 follows against a mirror that has something in it.**

## ⚠️ Migration numbers: this lane needs a second block

0080–0089 is fully consumed (0080–0089 = T-154 … T-182). This task takes **0100**, and the phase's
remainder is claimed as **0100–0119**. Chosen rather than 0090–0099 to leave clear air above
`main`, which is at 0070 and advancing. ⚠️ Per DEF-091 the `when` must stay on the grid — derived
from `idx`, never from `previous.when + 86400000`. **Ian should confirm the block**; it is recorded
here so it is a decision rather than a squatter's claim.

## Goal

A manager enrols a staffer's card (and, for the APK's sake, their fingerprint). It reaches the
terminal's mirror. **And the server — not the device — decides which person a credential belongs
to.**

## Scope

**Create:** `packages/db/schema/attendance-credentials.ts` · migration `0100` ·
`packages/db/src/repo/attendance-credentials.ts` ·
`packages/domain/src/attendance/credentials.ts` · integration tests.
**Modify:** `mirror-outbox.ts` (a fourth entity) · `publisher.ts` (build the credential document) ·
`ingestor.ts` (resolve the credential server-side) · `firebase/firestore.rules` + its test suite ·
the RLS registry and cutover classification · the domain barrel.
**Out of bounds:** the terminal itself (T-184) · face enrolment (below) · the ZK9500 plugin (D2).

---

## Contract

### 1. ⛔ A NEW table, deliberately declining T-138's invitation

`person_credentials` says of its `kind` column:

> *"⭐ The extension point. `pin` and `firebase` are live; `biometric` is declared now so that adding
> it in Phase 4 is a row and a service, not a schema change and a rewrite."*

**This task does not take that invitation, and the reason is the mirror.** A publisher that reads
`person_credentials` to build the credential mirror is one wrong `where` clause away from mirroring
a **PIN verifier** to every terminal in the store. Keeping attendance credentials in their own table
means the publisher *cannot reach a sign-in secret*, because they are not in the same relation —
structural rather than careful, which is what bible §12 asks for.

The bible already draws this line in prose (§13 row 165): *"signing in to the app and clocking in
are different acts, and only the second is closed."* This gives the two acts different tables, and
therefore different revocation surfaces.

### 2. `attendance_credentials`

| Column | Notes |
|---|---|
| `employment_id` | ⭐ Per **employment**, not per person. Somebody who works two stores has two badges, and revoking one must not touch the other |
| `kind` | **`card` or `fingerprint` ONLY** — see §3 |
| `card_id` | The badge value the terminal scans. `card` only |
| `match_token` | 32 hex. `fingerprint` only. ⭐ **Rotated on every re-enrolment**, carried over from v1's own M5 fix |
| `templates` | `text[]`, 1–2 entries ~2.7 KB each. `fingerprint` only |
| `enrolled_by` / `enrolled_at` | Attributed. A credential that authorises pay names who created it |
| `revoked_at` / `revoked_by` / `revoke_reason` | ⛔ Revocation is a timestamp, never a delete — the same rule `person_credentials` already follows |

**Invariants in the schema, not the service:**
- A shape CHECK per kind: `card` has a `card_id` and no token or templates; `fingerprint` has both
  and no `card_id`.
- ⭐ **A partial UNIQUE on `(org_id, card_id) WHERE revoked_at IS NULL`.** Two live cards with the
  same id makes "who punched?" ambiguous, and an ambiguous credential check that picks the first
  match is how the wrong person gets paid. A *revoked* card id may be reissued.
- The same on `match_token`.

### 3. ⛔ Face is UNREPRESENTABLE here, and that is the point

Bible §5.3, after the 2026-07-04 exfiltration finding: face templates are *"never mirrored, never
cached, never bundled."*

The CHECK constraint permits `card` and `fingerprint` and nothing else. ⭐ **So the publisher cannot
leak a face template even if a future change tries to** — there is no row it could read. Face
enrolment stays with the online-only server-side matcher and is explicitly **out of scope**; when it
is built it gets its own home, and this table's constraint is what keeps the two apart.

This is the difference between "we remembered not to" and "it cannot be expressed."

### 4. ⭐ The credential mirror — and what it deliberately does NOT carry

A fourth `MIRROR_ENTITIES` value, `credential`, published to
`biometricMirror/{storeId}/credentials/{credentialId}` — the terminal-only path T-159 already
guards.

```
{ credentialId, employmentId, kind, cardId?, matchToken?, templates?, srcVersion }
```

⛔ **No display name, no staff code, no position.** Those live on the roster (hot-set item 1), which
the terminal already has and which every store member may read. Duplicating them here would put
identity behind the terminal-only wall for no gain and make two documents disagree.

Tombstoned, never hard-deleted: a revoked credential publishes `{ deletedAt, srcVersion }`, because
a device that was offline when the revocation happened must be able to *learn* the badge died.

### 5. ⭐⭐ The server resolves the credential. This is the task's real deliverable.

Landmine #22, from discovery 05's "Known gaps":

> *"Punches are authorized by **possession of `matchToken` alone** — neither `clockByFingerprintAction`
> nor `clockByFaceAction` re-runs a biometric match server-side; a leaked token (or, offline, a
> leaked cached bundle) can punch indefinitely until the token is rotated."*

T-182 shipped the *shape* of the fix and said so plainly in its own comment — it verifies that the
employment the terminal named is real, open, and at this store, but it takes `employmentId` from the
device. **That is v1's hole in new clothes:** the device still decides who punched.

**So the inbox event changes.** It carries the credential, not the conclusion:

| Field | Was | Becomes |
|---|---|---|
| `employmentId` | ⛔ Sent by the device | **Gone.** Resolved by the ingestor |
| `credentialKind` | — | `card` or `fingerprint` |
| `credentialRef` | — | The `cardId` or `matchToken` the device matched |

The ingestor looks the credential up and resolves the employment itself. ⚠️ **Two new quarantine
paths, both reusing `unknown_credential`:** no live credential matches, or the credential resolves
to an employment at another store.

#### ⚠️ Resolved as of the punch's OWN timestamp, not now

A punch made at 14:00 on a card revoked at 15:00 and ingested at 16:00 **is valid**. It was a real
person clocking in with a live badge; the revocation had not happened yet.

This is the same rule the method kill switch already follows — T-182 reads the config *in force on
the punch's own shift day*, precisely so a backdated replay cannot use a setting that was not in
effect. Applying it to credentials keeps one principle instead of two.

⛔ The converse also holds and matters more: a card revoked at 15:00 **cannot punch at 15:01**, even
from a terminal that has been offline for a week and still has the badge in its mirror. The mirror
is a convenience for resolving a scan; **the server is the authority on whether that credential was
alive at that moment.** That is exactly what v1 could not say.

### 6. Authorization

| Action | Capability |
|---|---|
| Enrol a card | `manage_attendance` |
| Enrol a fingerprint | `manage_attendance` |
| Revoke | `manage_attendance` |
| Read a template back through the app | ⛔ **There is no such operation** |

⭐ **The last row closes v1's widest credential hole by not building the endpoint.**
`listFingerprintTemplatesAction` is gated to *any* authenticated store member and returns every
enrolled staffer's raw template and matchToken — discovery 05 flags it as an interim gap that was
audited rather than blocked. In v2 the mirror is the only consumer, it is terminal-only, and no app
surface reads a template at all. **A hole you cannot reach through an API you did not write.**

⚠️ Enrolment necessarily *accepts* a template; it never returns one. The write is attributed, the
read does not exist.

## Invariants

1. A card id can belong to at most one live credential in an org; a revoked one may be reissued.
2. A `face` credential cannot be inserted — the constraint refuses it.
3. Enrolling publishes to `biometricMirror`; revoking publishes a tombstone.
4. The credential mirror document carries no display name, staff code or position.
5. An inbox event naming a credential resolves to that credential's employment, server-side.
6. An event whose credential matches nothing is quarantined `unknown_credential`.
7. ⭐ A punch made **before** a revocation still ingests; one made **after** it does not.
8. A credential belonging to another store's employment is refused.
9. Re-enrolling a fingerprint **rotates** the match token, and the old one stops resolving.
10. No app surface returns a template or a match token.

## Tests

Integration for every invariant. The rules suite gains a case proving a **person** — not a terminal —
cannot read `biometricMirror`, and the emulator run must watch it fail against a permissive ruleset,
as T-180 established.

## Out of scope

**Face enrolment** — §3, and it needs the online matcher · **The ZK9500 plugin** — D2 is parked ·
**The terminal UI** — T-184 · **Card issuance/printing** — operational · **A photo captured at the
punch**, the named-but-unbuilt anti-buddy-punch mitigation (bible §13 row 164) — still named, still
unbuilt, and this task does not change that.

## Done when

- [ ] All ten invariants pass.
- [ ] Migration hand-written in **0100–0119**, journalled with `when` **derived from `idx`** (DEF-091).
- [ ] `attendance_credentials` classified **and** RLS-registered — its own first commit.
- [ ] The rules suite green against the emulator, including the new denial, watched failing first.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
