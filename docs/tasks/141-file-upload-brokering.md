# T-141 — Upload brokering: making the receipt-photo gate mean something

> **Status:** ⚠️ **BUILT (service layer), 2026-08-27.** UI upload control and the live Firebase
> adapter are the remaining slices — see §9. Written before implementation (bible §1.2a).
> **Closes:** ADR-002 §3's *"uploads brokered server-side after `authorize()`"*, and the half of
> T-122 §5 that is currently unenforceable.
> **Depends on:** `authorize()` (T-121), sessions (T-138), `firebase-admin` ^13 (already a
> dependency of `apps/erp`).

## 1. What is actually broken

**T-122 §5 says *"no photo, no posting"*, enforced server-side at post.** That control exists and
fires. But `receipt_photo_url` is a **plain text field on the form** — nothing uploads anything,
and nothing checks that the string is a file, or that the file exists, or that it belongs to this
store.

⛔ **So the gate is satisfied by typing `x`.** The rule is real, the evidence behind it is not.

## 2. ⚠️ And the bigger one, found in v1's own rules file

v1 uploads client-side (`uploadBytes` + `getDownloadURL`) under `storage.rules`, which says of
itself:

> *"Still missing: a store-membership check, so **any signed-in user can write into any store's
> folder**. That needs a `firestore.get()` lookup, which is the exact construct that fails silently
> when written wrong… It wants emulator-backed rules tests first rather than a blind production
> deploy."*

That is the gap ADR-002 names. **The one directly above it is worse and is not named anywhere:**

```
match /{allPaths=**} {
  allow read: if request.auth != null;
}
```

⛔ **Any signed-in user can read every file in the bucket** — every store, **every org**. v2 spent
T-120 putting franchise isolation into Postgres (RLS, `FORCE`, default-deny, because *"a franchise
with a separate owner is already live"*), and the **bytes have none of it**. Padre Garcia's owner
can read Malvar's receipts today.

⭐ **Brokering must therefore cover READS, not only writes.** Scoping this task to uploads would
close the smaller hole and leave the larger one open.

⚠️ **v2 does not inherit this bucket** — see §8. It writes to a new private one, so DEF-070 stays
confined to v1's, and the lesson is what carries over, not the exposure.

## 3. ⭐ The shape: the bucket becomes unreachable from a browser

| | Now | After |
|---|---|---|
| Client → Storage | Direct, `uploadBytes` | ⛔ **Nothing** |
| Path chosen by | The client | **The server, from the actor's own scope** |
| Read via | `getDownloadURL` — a long-lived token URL | A route that `authorize()`s, then a short-lived signed URL |
| Bucket rules | 85 lines that isolate nothing | **Deny all** on a new private bucket (§8) |

⭐ **The rules file becoming `deny all` is the point, not a side effect.** The Admin SDK bypasses
rules, so once no client touches the bucket, isolation lives in the same `authorize()` every other
control uses — and this project's recorded landmines about Storage rules (OR-semantics, where a
nested "stricter" block is a no-op; `firestore.get()` failing silently) stop being reachable.
**A rule you cannot get wrong beats a rule you have to get right.**

## 4. The path is derived, never accepted

```
orgs/{orgId}/stores/{storeId}/{purpose}/{fileId}.{ext}
```

⛔ **Every segment comes from the server.** `orgId` from the session, `storeId` checked against the
actor's store scope, `fileId` newly generated. A client-supplied path is how *"any signed-in user
can write into any store's folder"* happens, and accepting one while calling this "brokered" would
be theatre.

## 5. `stored_files` — because Postgres stores the path, never the bytes

One table, not a URL column per feature. Receipt photos are first, but AR collection proof, memo
documents, wastage disputes and onboarding documents are all coming, and v1 grew a separate
uploader for each — six of them, none sharing a check.

Columns: `id`, `org_id`, `store_id`, `purpose`, `storage_path`, `content_type`, `byte_size`,
`checksum`, `uploaded_by`, `uploaded_at`, `linked_to` (nullable).

⛔ **No public URL column.** A stored URL is a permanent unauthenticated grant, which is exactly
what `getDownloadURL` hands out and exactly what we are removing.

### The expense seam

`expenses.receipt_file_id` → `stored_files.id`, expand/contract per bible §15.5. The gate then
checks a **row**, and that the row's `org_id`/`store_id` match the expense's. That is the
difference between evidence and a string.

## 6. Rules

1. `authorize()` on **every** broker call — upload and read. The capability is the one that governs
   the *thing*: `create_expense` to attach a receipt, `view_financial_reports` to read one back.
2. Content-type **allow-list** (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`), and a
   size cap per purpose. ⚠️ v1's blanket 25 MB with *"no content-type restriction"* was a
   deliberate compromise for onboarding documents; per-purpose caps make it unnecessary.
3. ⚠️ **Strip EXIF from images.** A phone photo of a receipt carries GPS coordinates and a device
   id — staff location data nobody asked to collect and ADR-007 would have to account for.
4. Signed read URLs expire in **minutes**, and are minted per request. Never stored, never logged.
5. ⛔ **A file referenced by a posted expense is never deleted.** It is the evidence behind a
   journal entry; retention is ADR-007's question, not a delete button's.
6. **Orphan sweep.** A file uploaded for a draft that was never saved is bytes nobody can reach.
   `linked_to is null and uploaded_at < now() - 24h` is collectable — and, like T-140, the sweep
   must **record that it ran**.

## 7. Done when

- [x] `stored_files` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [x] Broker: upload + read, both gated, path derived server-side, EXIF stripped, plus the
      orphan sweep.
- [x] `expenses.receipt_file_id`, with T-122's gate checking the row and its org/store.
      ⚠️ Expand phase: a legacy URL still satisfies the gate while old drafts exist.
- [ ] The **private bucket** created in `shareat-hub-v2` with deny-all set **by hand, once** (§8).
      ⛔ v2 gains no `firebase.json` — it must never be able to deploy rules into that project.
- [x] Integration tests — 10, incl. the cross-org read refused, the derived path, the GPS
      stripped **as stored**, wrong type, oversize, empty, the capability denial, and the sweep.
      Plus 8 unit tests on the JPEG stripper itself.
- [ ] Driven end to end in a browser: attach a photo, post the expense, view it back.
- [x] Gates: typecheck · unit 561 · integration 875.

## 8. ⭐ Which bucket — settled, and it is not the one you would guess

> **Ian, 2026-08-27:** *"yes same firebase identity as POS — that's the whole point… so 1 auth yes"*
> and *"storage can be separated yes, since POS and CUSTOMER app are public facing the menu photo
> must not be strictly accessed."*

**Bible row 155.** Auth is one tenant, `shareat-hub-v2`. Storage splits **by what the file is, not
by which app wrote it**:

| Bucket | Holds | Read rule | Who reaches it |
|---|---|---|---|
| `shareat-hub-v2` default | Menu photos, logos, loyalty images | **`allow read;`** — world-readable | Anyone. **Correct** — it is CDN content |
| **New private bucket, same project** | Receipts, proofs, exports | **Deny all** | ⭐ Only this app's Admin SDK |

⛔ **Accounting documents must never go in the public bucket.** POS's own rules record why it could
not be narrowed for customer payment proofs — *"Storage rules OR across matching blocks, so a
stricter `allow read` accomplishes nothing"* — leaving an unguessable UUID plus a 15-day lifecycle
delete as the only mitigation. **Receipt photos are not payment proofs:** they carry suppliers,
prices and volumes, and they are kept for years. Security-by-unguessable-URL is not an accounting
control.

⭐ **Same project as Auth, different bucket.** One service account, no cross-project credential —
ADR-003 lists the Website's cross-project `HUB_SA_KEY` as evidence of the sprawl this rebuild
exists to end.

### ⭐ Costed 2026-08-27: Firebase Storage is CHEAPER than DO Spaces here, and that surprised me

Ian asked whether to move file storage to DigitalOcean Spaces alongside the droplet, *"since all
other parts are there"*. The answer went the other way:

| | |
|---|---|
| **DO Spaces** | **$5/month floor**, whatever the usage — 250 GB and 1 TB transfer included |
| **Firebase Storage** | Pay-per-use: ~$0.026/GB-month plus egress |

⭐ **At this volume the floor is the whole story.** Receipt photos are small and few; the crossover
where Spaces becomes cheaper is roughly **630,000 photos**. Until then the flat $5 costs more than
metered usage does.

⚠️ **And one correction worth keeping:** I described Firebase as *"free"* in passing. It is not —
these projects are on **Blaze**, which is pay-as-you-go with a free tier, not a free plan.

⛔ So storage stays on Firebase. This is not the same question as the DATABASE, which ADR-002
already settled on DO Managed Postgres — and Supabase remains *"considered and rejected for now"*
(bible §4.1) for the reason it always was: it duplicates Auth and Storage that already run on
Firebase. ⚠️ Recorded here so the comparison is not run a third time.

### ⛔ v2 never deploys Storage or Firestore rules

POS's `firebase.json` declares `"storage": { "rules": "storage.rules" }` with **no bucket target**,
so any repo deploying storage in that project overwrites POS's production ruleset — **CUSTOMER has
already done exactly this.** v2 has **no `firebase.json` at all** today. Keep it that way: the
private bucket's deny-all is set **once, by hand**, and the Admin SDK bypasses rules, so v2 needs
none.

### Sequencing — much simpler than first written

⚠️ **My earlier draft said deny-all had to wait for POS and CUSTOMER to stop writing. That was
wrong** — it assumed a shared bucket. A **new** private bucket has exactly one writer from the
moment it exists, so there is nothing to wait for.

1. Create the private bucket in `shareat-hub-v2`; set deny-all by hand.
2. Build the broker; v2 writes only there.
3. v1's existing receipts stay in `studio-7300228488-a394e`, readable from v1. Nothing is migrated
   — v2 assumes a zero starting point, and DEF-070 stays confined to a bucket v2 never writes to.

### Testing before go-live

> **Ian, 2026-08-27:** *“if we needed to test something that will require us to connect to a storage, just temporarily create a new one on Google Firebase, then we just repoint it soon when we're going live.”*

⭐ **The bucket name is configuration, not architecture** — `FIREBASE_STORAGE_BUCKET` is a server-only variable, added to the schema and `.env.example` when the adapter landed. ⚠️ *(An earlier draft of this line said it already existed. It did not — only the client-visible `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` did, which names the world-readable default bucket and must never hold this value.)* A throwaway bucket for development costs nothing and keeps test uploads out of anything real. ⚠️ The one thing that must NOT differ between the scratch bucket and the live one is **deny-all plus Admin-SDK-only access**: testing against a permissive bucket would prove the broker works while proving nothing about whether it is
the only way in.

## 9. ✅ The Firebase adapter — BUILT 2026-08-27

> **Ian, 2026-08-27:** *"new bucket gs://shareat-hub-v2"*

`packages/storage-firebase` — **its own package, because `packages/domain` must not own a cloud
SDK.** Domain owns the `StorageDriver` interface; exactly one package depends on `firebase-admin`,
the same isolation `@shareat/etl-firestore` exists for. Installed at server startup by
`apps/erp/src/instrumentation.ts`, so a misconfigured bucket fails at BOOT rather than at the first
upload — the difference between a deploy that never goes live and one that silently cannot store
evidence.

⭐ **What the adapter deliberately cannot do.** There is **no public-URL method and no permanent
URL at all**, and a test pins that `makePublic` / `publicUrl` / `getDownloadURL` are absent. v1 calls
`getDownloadURL()` and stores the result — a link that never expires, readable by anyone it is
forwarded to. Here reads are brokered: a v4 signature good for minutes, minted per request, after
`authorize()`. Writes are `resumable: false` (a resumable session URL is a week-long write
credential) and `private, no-store` (a shared cache holding an invoice is a copy outside the
deny-all).

⚠️ **`FIREBASE_STORAGE_BUCKET` is SERVER-ONLY and must never equal
`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`.** That one is client-visible by construction and names the
project's default bucket — `allow read;`, world-readable. Both the env schema and `.env.example` now
say so in place.

### ⭐ `npm run storage-smoke` — the check the unit tests cannot make

The adapter's unit tests mock `firebase-admin` and prove the SHAPE of every call. They cannot prove
§8's one non-negotiable: *deny-all plus Admin-SDK-only access*. The smoke script writes a scratch
object, reads it back through the Admin SDK, **fetches it unauthenticated and requires that to
FAIL**, checks a signed URL works and expires, then deletes it.

⛔ **If the unauthenticated GET succeeds, the bucket is the world-readable default one** and no
accounting document may go in it. The fix is a different bucket, never a narrowed rule — POS already
proved Storage rules OR across matching blocks (bible row 155).

### ✅ RUN AND GREEN against `gs://shareat-hub-v2`, 2026-08-27

```
bucket: shareat-hub-v2
  ✓ wrote orgs/_smoke/…txt
  ✓ read it back through the Admin SDK
  ✓ unauthenticated read refused (HTTP 403) — the bucket is private
  ✓ a signed URL reads it, and expires in 120s
  ✓ deleted
```

⭐ **The 403 is the finding.** The bucket Ian created is a genuinely private one, NOT the project's
world-readable default — which was the open question this script existed to answer, and which no
amount of reading the code could have settled. Accounting documents can go here.

⚠️ Credentials: `firebase-adminsdk-fbsvc@shareat-hub-v2`, loaded from
`secrets/storage.sa.json` via the **FILE form** — the key never enters an env var or a shell history.
⛔ The pre-existing `secrets/hub.sa.json` is `read-only-sa@` and deliberately NOT reused: it cannot
write, and granting it write access would leave a service account whose NAME lies about what it can
do.

## 10. What is still NOT done

- **The UI upload control.** `receipt_photo_url` is still what the expense form writes; the gate
  accepts either during the expand phase.
- **The private bucket's deny-all** — Ian's action (§8). `storage-smoke` is how it gets verified.
