# T-238 — DEF-232 (the demotion race) and DEF-231 (the install loop)

> **Status**: 📝 **SPEC — lane D, 2026-09-08. Written before any code. Awaiting APPROVED.**
>
> Two small, unrelated fixes, both written from T-237's round. ⛔ **§2 is a QUESTION, not a plan:**
> the same guard has three more weaknesses, and **one of them means DEF-232's remedy as written does
> not close the hole it describes.** Nothing in §2 is built until you rule on it.
>
> No migration. No `apps/erp/src/app/**`.

---

## 1. DEF-232 — the lock (the part that is simply approved work)

`assignRoleAsActor` (`packages/auth/src/roles.ts:281-291`) reads the guard and then writes:

```ts
const targetRole = await accessRepo.activeRoleForPerson(tx, input.personId, actor.orgId);
if (targetRole?.role === 'admin' && input.role !== 'admin') {
  const anotherAdmin = await accessRepo.hasOtherActiveAdmin(tx, actor.orgId, input.personId);
  if (!anotherAdmin) throw new AuthorizationError("…refusing to demote this org's only active admin…");
}
```

Two administrators demoting **each other** at the same instant both read "the other one is still an
admin", both pass, and the organisation ends with none. (Sequentially it is safe: the self-demotion
check at `:242` means nobody can be their own second half.)

**Fix:** `await accessRepo.lockOrgAccess(tx, actor.orgId)` immediately after the `authorize` call and
**before** the first read — T-237's helper, unchanged, `pg_advisory_xact_lock(hashtext(org_id))`,
transaction-scoped. Nothing new in `repo/access.ts`.

⚠️ Placed before `authorize` reads too, deliberately: the whole transaction's view of the access
tables should be inside the critical section, not just the last read of it.

**Test** — `packages/auth/tests/integration/roles.test.ts`, driven through `assignRoleAsActor` and
not through the helper (T-237's nit, learned): in one transaction, assert `pg_locks` shows **zero**
advisory locks for `pg_backend_pid()`, call `assignRoleAsActor`, assert it shows more than zero. The
before-check is the control. The race itself is not simulated — two concurrent transactions in one
test is a flake — and the lock will be commented out once to prove the assertion fails without it.

---

## 2. ⛔ QUESTION — three more things in the same eleven lines, and one of them is load-bearing

You asked for the "can it demote the last admin who can actually sign in" question. The answer is
yes, **and it is the least serious of the three.**

### 2a. The guard ignores `super_admin` entirely — in both directions

`manage_users` is matrix-true for **`super_admin` and `admin`** (`capabilities.ts:688`). The guard
mentions only the literal `'admin'`, twice:

| Direction | Line | Consequence |
|---|---|---|
| As the **remaining** administrator | `hasOtherActiveAdmin` counts `role = 'admin'` only | Demoting the last `admin` in an org that still holds a `super_admin` is **refused** — a false refusal; that org still has somebody who can `manage_users` |
| As the demotion **target** | `targetRole?.role === 'admin'` | Demoting a `super_admin` runs **no guard at all** |

### 2b. ⛔ So the lock alone does NOT close DEF-232's stated hole

DEF-232's remedy is the lock, and for two `admin`s it is sufficient. For two **`super_admin`s** it is
not: the guard never runs for a super_admin target, so serialising the two transactions changes
nothing — T1 demotes S2, T2 demotes S1, both commit, **zero administrators**, with the lock in place
and working exactly as designed. A lock can order two checks; it cannot make an absent check fire.

**Recommended, and it is three lines**: make both halves ask the question the guard's own sentence
already claims to ask — *"is the org left with nobody able to manage users?"*

```ts
const ADMINISTRATIVE = ['admin', 'super_admin'] as const;
if (targetRole && ADMINISTRATIVE.includes(targetRole.role) && !ADMINISTRATIVE.includes(input.role)) {
  … hasOtherActive…(tx, actor.orgId, input.personId)
}
```

### 2c. The credential half — your question, answered

`hasOtherActiveAdmin` counts **role rows**. An admin who holds no live credential cannot sign in, so
they cannot `manage_users` either; demoting the last administrator who *can* sign in, while a
credential-less admin row exists, passes the guard and leaves the organisation locked out just as
surely. That is T-237's blocker, one file over.

⚠️ **But T-219's rule and T-237's are allowed to differ, and here is the honest case for each.**
T-237's guard protects *the last way IN* — a credential question by construction. T-219's protects
*the authority to manage users*. The two coincide only because signing in is a precondition for
exercising authority. **My recommendation is to use `hasOtherActiveAdminWhoCanSignIn` here as well** —
the guard's own words are *"the org is left with nobody able to manage users"*, and an administrator
who cannot sign in is not able to manage users in any sense a person would recognise. It is a
one-word change with the helper T-237 already built and tested. ⛔ But it does change what T-219's
rule counts, so it is yours to say, not mine to slip in.

### 2d. In passing (row 164), NOT proposed for this slice

**An `admin` can demote a `super_admin`.** The super-admin-authority check at `:269` fires only when
the **new** role is `admin`/`super_admin`, so `assignRoleAsActor(actor=an admin, { personId: theSuperAdmin, role: 'staff' })`
passes every check in the function. Bible row 116 — *"only a super-admin appoints an admin"* — has no
matching rule for **unmaking** one, and since T-232 §2.2 an `admin` holding the four grants can then
appoint admins. Not a lockout, so not urgent; it is an authority-chain asymmetry and wants its own
defect number and its own thinking.

---

## 3. DEF-231 — the install loop

`docs/ops/provision.sh:88-92` lists eleven filenames. Thirteen units ship (`ls docs/ops/*.service
*.timer`), and the two missing ones are T-216's `shareat-recurring-expense-draft.{service,timer}` —
so `README.md:97`'s *"nothing installs them until `provision.sh` is re-run"* is **false** for that
job: re-running it installs nothing for it either.

**Fix — the durable one the register names**, so a shipped unit can never be left behind again:

```sh
for f in "$UNIT_DIR"/shareat-*.service "$UNIT_DIR"/shareat-*.timer; do
  [ -e "$f" ] || continue   # an unmatched glob stays literal; never install a path with a '*'
  install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"
done
```

`shareat-erp.service` matches `shareat-*.service`, so the web unit keeps working. ⚠️ The loop now
installs whatever is in the directory — which is the point, and also means a unit file added to
`docs/ops/` is armed on the next provision run without anyone remembering to edit this list.

**Verified afterwards, not assumed**: the README sentence is re-read and the two names it calls
un-armed are the two the glob now picks up. ⚠️ Arming on the droplet is still Ian's (DEF-194); this
only makes the script tell the truth.

⛔ **Not executed by me.** `provision.sh` runs as root on a fresh droplet; there is nothing to run it
against here. The change is reviewed by reading, and the glob is checked locally with `ls` against
the real directory — which is exactly the check that found the defect.

---

## 4. Files, and done-when

| Path | Change |
|---|---|
| `packages/auth/src/roles.ts` | the lock (§1); §2's widening **only if approved** |
| `packages/auth/tests/integration/roles.test.ts` | the lock case; §2's cases if approved |
| `docs/ops/provision.sh` | the glob |
| `docs/ops/README.md` | only if §3's sentence needs it after the change |
| `docs/tasks/238-*.md` | this file |

`packages/db/src/repo/access.ts` is **not** expected to change: `lockOrgAccess` and
`hasOtherActiveAdminWhoCanSignIn` both already exist.

**Done when:** typecheck clean · full unit project green · `roles.test.ts` green on
`shareat_test_t216b` via `it.mjs`, with the lock case proven red-first · the glob read back against
the real `docs/ops` listing · self-reviewed · **FOR IAN block in the READY**.

## 5. Model

**The build is Sonnet-able and small** — a one-line lock, one test, a shell loop. This spec is on
Opus because §2 is a judgement about an authority rule, not because the edit is hard. If you approve
§2b and §2c, that stays Sonnet work too: both are the conditions above, already written out.
