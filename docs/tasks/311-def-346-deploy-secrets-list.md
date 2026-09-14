# T-311 — `deploy.yml`'s required-secrets list says eleven; the workflow reads seven

> **STATUS: NUMBER RESERVED, SPEC NOT YET WRITTEN.** Allocated 2026-09-14 by the orchestrator
> (`system32-85`) so the number cannot be taken twice — that happened on 2026-08-31, when two
> sessions took task 196 and DEF-117 within 2m40s. **Do not implement from this file.**
>
> ⛔ **BLOCKED ON FILE OWNERSHIP, NOT ON ANALYSIS.** `.github/workflows/deploy.yml` is held by the
> lane building **T-308 slice A**, which adds a revision step to it. Two lanes must never edit one
> file. This task starts when that lane reports READY and the orchestrator releases `deploy.yml`.

## Where the substance lives

⛔ **Do not re-derive this.** `docs/DEFECTS-REGISTER.md` **DEF-346** carries the measurement, the
cause, and a costed design. In one line: `deploy.yml:13-18` names eleven GitHub Secrets the
workflow *"needs"*; it reads **seven**, and the comment's opening premise (*"Secrets that do not
exist yet … until they exist this workflow fails"*) is stale as well, since deploys succeed.

## The two halves, and the second is the one that lasts

1. **Correct the comment.** List the seven actually read. Say, in a separate sentence, that
   `DATABASE_URL`, `SESSION_SECRET` and the Firebase service-account path are **runtime** values in
   `/srv/shareat-shared/.env.local`, not Secrets. Delete the *"do not exist yet"* framing.
2. ⭐ **Assert it.** Lane B's design, costed at well under an hour: a unit test that greps
   `deploy.yml` for `secrets\.([A-Z0-9_]+)`, greps the comment block for the names it claims, and
   asserts the two sets agree **both ways** — a name claimed but unread, and a name read but
   unclaimed, are both failures.

⛔ **Do not do (1) without (2).** This register holds DEF-311, DEF-315, DEF-329 and DEF-338 as four
separate proofs that a documented expectation with no executable check is a comment — and a
*corrected* comment is still only a comment.

## Why it is NOT bundled into T-307

Checked, not assumed. T-307 feeds real **values** through `serverSchema`; a Secret's value is by
definition never in the repository, so there is nothing to feed. **Two guards because they are two
mechanisms**, not because two felt tidier.

## Why this class matters more than this row

⭐ DEF-346 is the proof that DEF-338's class is **not** about conditional grammar. A sweep for
*"whoever fixes X"*, *"once X is fixed"*, `TODO: remove` cannot match this comment at all — it has
no conditional phrasing and no TODO. It is a flat present-tense checklist claim that is false
against the file it sits in. The sharper class, in the finding lane's words: **a comment naming a
specific identifier, secret or file and asserting a present-tense fact about it** — checkable by
grepping the comment's own named tokens against the code, not by grammar pattern.
