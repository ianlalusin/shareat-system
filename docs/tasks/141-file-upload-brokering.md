# T-141 — Upload brokering: making the receipt-photo gate mean something

> **Status:** SPEC, 2026-08-27. Written before implementation (bible §1.2a).
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

## 3. ⭐ The shape: the bucket becomes unreachable from a browser

| | Now | After |
|---|---|---|
| Client → Storage | Direct, `uploadBytes` | ⛔ **Nothing** |
| Path chosen by | The client | **The server, from the actor's own scope** |
| Read via | `getDownloadURL` — a long-lived token URL | A route that `authorize()`s, then a short-lived signed URL |
| `storage.rules` | 85 lines that isolate nothing | **Deny all** |

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

- [ ] `stored_files` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [ ] Broker: upload + read, both gated, path derived server-side, EXIF stripped.
- [ ] `expenses.receipt_file_id`, with T-122's gate checking the row and its org/store.
- [ ] `storage.rules` reduced to deny-all, deployed **after** the last client writer is gone.
- [ ] Integration tests: a denial per capability; a cross-org read refused; a client-supplied path
      rejected; an oversized and a wrong-type upload refused; **and a test that the photo gate
      fails on a `receipt_file_id` belonging to another store**.
- [ ] Driven end to end in a browser: attach a photo, post the expense, view it back.
- [ ] Gates: typecheck · unit · integration.

## 8. ⚠️ Sequencing — this is a cutover-order problem, not just code

`storage.rules` cannot go deny-all until **POS, CUSTOMER and v1 have stopped writing directly**.
Those are live and out of scope here. So:

1. Build the broker; ERP uses it exclusively.
2. Tighten `stores/{storeId}` writes to the ERP's service account only.
3. Deny-all **last**, once the other three are migrated or retired.

⛔ **Do not deploy step 3 early.** These repos share one bucket, and this project has already
recorded a case of one repo's deploy overwriting another's rules.
