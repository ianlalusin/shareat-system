# The private bucket's Storage rules — paste this, and read the two warnings first

> **Bucket:** `gs://shareat-hub-v2` · **Project:** `shareat-hub-v2` · T-141 §8, bible row 155.
> **Paste in the Firebase console** (Storage → Rules), never from this repo. See §3.

## 1. The rule

```
rules_version = '2';

// The private accounting bucket: receipts, payment proofs, exports.
// Reached ONLY by the Shareat System Admin SDK, which bypasses rules entirely.
// Nothing else has business here, so nothing else is allowed.
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

That is the whole file. ⭐ **`if false` is not a placeholder** — the Admin SDK authenticates as a
service account and is not subject to rules at all, so denying every rules-based path costs this app
nothing and closes the bucket to every browser, signed in or not.

## 2. ⚠️ Why this is still needed even though the smoke test already showed 403

`npm run storage-smoke` fetches the object with **no credentials** and requires a refusal. It got
`HTTP 403`, which proves the bucket is not world-readable.

⛔ **It does not prove the bucket is closed to a SIGNED-IN user**, and that is precisely the hole
this project found in v1:

```
match /{allPaths=**} {
  allow read: if request.auth != null;
}
```

Every Shareat diner with a POS or CUSTOMER login is `request.auth != null`. A rule like that returns
403 to an anonymous `curl` and hands the file to any customer who asks with a token — so the check
that passed would still have passed. **Deny-all is what closes that**, and it is the only reason
this step exists.

## 3. ⛔ Paste it in the CONSOLE. Do not add a `firebase.json` to this repo.

POS's `firebase.json` declares:

```json
"storage": { "rules": "storage.rules" }
```

with **no bucket target**. Any repo that runs `firebase deploy --only storage` in this project
overwrites POS's production ruleset for the *default* bucket — **CUSTOMER has already done exactly
this once.** v2 has no `firebase.json` at all, and that is deliberate: the Admin SDK needs no rules,
so v2 never has a reason to deploy any.

⚠️ **Check the bucket selector before saving.** The console's Rules editor targets whichever bucket
is selected. Saving this deny-all against the **default** bucket would take menu photos, logos and
loyalty images offline for every diner in every store — the default bucket's `allow read;` is
*correct* and must stay. Confirm the selector says `shareat-hub-v2`, not
`shareat-hub-v2.firebasestorage.app` or `shareat-hub-v2.appspot.com`.

## 4. How to know it worked

```
npm run storage-smoke
```

Still all five green. ⭐ **If any check goes red after pasting, the rules were saved against the
wrong bucket** — the Admin SDK is unaffected by rules, so a correctly-targeted deny-all cannot break
this script.
