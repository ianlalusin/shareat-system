# T-309 — ERP v2 gets its own Firebase project

> **STATUS: NUMBER RESERVED, SPEC NOT YET WRITTEN.** Allocated 2026-09-13 by the orchestrator
> (`system32-85`) to hold **Ian's decision**, taken the same day: *finish the T-304 cutover on the
> borrowed project, then move.* **Do not implement from this file.** Write the spec first, in the
> format of `docs/tasks/2xx-*.md`, and have it approved.

## The problem in one table

ERP v2 owns **neither** of the Firebase projects it depends on:

| Concern | Project it uses today | Whose project that is |
|---|---|---|
| **Identity / sign-in** | `studio-7300228488-a394e` | **v1's ERP** (`ERP-rebuild`) |
| **File storage** | `shareat-hub-v2` | **v1's POS + CUSTOMER** |

⛔ **v1 is the system being retired.** When its project goes, v2's logins go with it — so this is a
dependency on the thing this project exists to replace.

⭐ **Verified 2026-09-13 independently of the repository**, not read off a document: the deployed
bundle declares `NEXT_PUBLIC_FIREBASE_PROJECT_ID:"studio-7300228488-a394e"` with
`STORAGE_BUCKET:"shareat-hub-v2.firebasestorage.app"`, and Google's Identity Toolkit resolves the
bundle's own API key to project number `765051489373`.

## Ian's decision, and the reasoning that produced it

**Asked directly** whether to keep borrowing, switch projects before the cutover, or move
afterwards, Ian chose: ⭐ **finish the cutover first, then move.**

The trade-off was put to him in these terms and is recorded because the timing is the whole
substance of the decision:

- **Moving is cheap right now** — there was exactly **one** Firebase account in the entire system
  (Ian's admin login). One account to recreate, one `person_credentials.external_id` to update,
  five GitHub secrets, one env file on the box.
- ⛔ **But today email sign-in was the only way into production**, because PIN sign-in was dead
  (DEF-333) until the cutover completed. Changing the identity project means a window in which a
  wrong setting **locks everyone out**, with no second door — the exact failure T-304's whole
  cutover was designed around, and the way production sign-in broke on 2026-09-08 (DEF-235).
- ⭐ **Once PIN sign-in works there are two independent ways in**, which is what makes the move
  ordinary instead of nerve-racking.
- ⚠️ **The cost of waiting is rework**: every terminal provisioned into the old project must be
  recreated. At one or two terminals that is minutes. **It grows with every store**, so this
  should not sit for long.

## What the move must cover — collected, not yet sequenced

1. Create the project; enable **Email/Password** sign-in.
2. Recreate the admin account(s) and each **terminal** account; capture the new uids.
3. Update `person_credentials.external_id` for every `kind='firebase'` credential.
   ⚠️ A Firebase uid cannot be carried across projects — **every credential is re-issued, not
   migrated.**
4. Update the five `NEXT_PUBLIC_FIREBASE_*` GitHub secrets **and** `FIREBASE_PROJECT_ID`, plus
   `/srv/shareat-shared/.env.local`. ⛔ `packages/core/src/env.ts:202` refuses to start when the
   server and client project ids disagree — **that guard is an ally here and must not be softened
   to get the deploy through.**
5. ⭐ **Add `erp2.shareat.net` to the new project's authorised domains — DEF-341.** A fresh project
   starts with only `localhost` and its own `firebaseapp.com`, so this is a step that must be
   *performed*, never a state that carries over.
6. Decide the **storage** half separately: bible row 155 already rules that v2's documents move to a
   new private bucket (DEF-070). ⚠️ **Identity and storage need not move in the same change**, and
   probably should not.
7. ⛔ **A rollback that is rehearsed, not assumed:** the previous project keeps working until its
   credentials are removed, so the way back is redeploying the old secrets. **Prove that path
   before relying on it.**

## ⛔ The precondition, stated as a hard gate

**Do not start this while there is only one way to sign in.** PIN sign-in must be working, in
production, verified on a real device — otherwise this task recreates DEF-333's outage by choice.

## What this also retires

⭐ Once ERP v2 holds its own project, **DEF-340 stops needing a wording fix**: there is one project
instead of two, so *"create the account in the Firebase console"* becomes unambiguous on its own.
Until then, the wording is the only control, and DEF-340 owns it.
