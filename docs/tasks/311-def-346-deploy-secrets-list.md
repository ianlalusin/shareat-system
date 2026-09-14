# T-311 — `deploy.yml`'s required-secrets list says eleven; the workflow reads seven

> **STATUS: SPEC WRITTEN 2026-09-14 by webapps-65 (Sonnet 5) — awaiting APPROVED from
> system32-85.** Allocated 2026-09-14 by the orchestrator so the number cannot be taken twice —
> that happened on 2026-08-31, when two sessions took task 196 and DEF-117 within 2m40s.
> **Do not implement from this file until APPROVED is received.**
>
> ⛔→✅ **File-ownership block RULING, not a re-check every session: CLEARED.** This task
> originally could not start until the lane building T-308 slice A released `deploy.yml`. Read
> 2026-09-14: `deploy.yml`'s "Unpack, migrate, restart" step already contains the step named
> **"Write the deployed revision (T-308 Slice A — publish which commit this build is)"**
> (`npm run write-revision -- --require`) — T-308 slice A is merged into this file. The block is
> resolved; nothing here depends on that lane's future state.

## Where the substance lives

⛔ **Do not re-derive this.** `docs/DEFECTS-REGISTER.md` **DEF-346** carries the measurement, the
cause, and a costed design. In one line: `deploy.yml:13-18` (as filed 2026-09-14) names eleven
GitHub Secrets the workflow *"needs"*; it reads **seven**, and the comment's opening premise
(*"Secrets that do not exist yet … until they exist this workflow fails"*) is stale as well, since
deploys succeed.

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

---

## SPEC — webapps-65 (Sonnet 5), 2026-09-14

> **STOP — awaiting APPROVED from system32-85 before any file outside this doc is touched.**

### Goal

Make `deploy.yml`'s required-Secrets comment name exactly the seven Secrets the workflow reads —
no more, no less — say plainly which four values it previously conflated with Secrets are actually
runtime `.env.local` values, delete the stale "do not exist yet" bootstrap framing, and add a unit
test that makes the two lists (claimed vs. read) unable to drift apart silently again, in **either**
direction, the way DEF-311/315/329/338 record a corrected comment alone always eventually does.

### Scope

- `.github/workflows/deploy.yml` — only the leading comment block starting `# Needs GitHub Secrets
  that do not exist yet…`, ending `…not a bug to work around.`. No step, no `env:` block, no job
  logic changes.
- `tests/unit/deploy-secrets-list.test.ts` — new. **Not created yet** — BUILD adds it after
  APPROVED, confirmed RED against the current (pre-fix) file first, per RULES §3.2.
- `docs/tasks/311-def-346-deploy-secrets-list.md` — this file (status banner already updated above,
  this SPEC).

No other file changes. `packages/core/src/env.ts`, `ci.yml`, and every other workflow step are
untouched — verified via `packages/core/src/env.ts:79,90,120,201-204` that `FIREBASE_PROJECT_ID`,
`FIREBASE_SERVICE_ACCOUNT_KEY_FILE`, `SESSION_SECRET` and (via `docs/ops/README.md:22-23`)
`DATABASE_URL` are all read from `process.env`/`.env.local` at runtime, never touched by this task.

### Contract — the exact comment replacement

Replace, in `deploy.yml`, only the paragraph currently reading (starting `# Needs GitHub Secrets
that do not exist yet…`, ending `…not a bug to work around.`), with:

```
# GitHub Secrets this workflow reads (checklist §4b — Ian sets these, never through an agent):
# DEPLOY_SSH_KEY, DEPLOY_HOST (the new droplet's IP — REQUIRED, no default, checked by the
# "Require DEPLOY_HOST" step below), NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
# NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, NEXT_PUBLIC_FIREBASE_APP_ID.
# tests/unit/deploy-secrets-list.test.ts asserts this list against the file's own secrets.* reads,
# both ways, so it cannot drift the way it did before DEF-346 (measured 2026-09-14: this comment
# named eleven, the workflow read seven).
#
# NOT GitHub Secrets — runtime values read from /srv/shareat-shared/.env.local on the droplet,
# never set here: DATABASE_URL, SESSION_SECRET, FIREBASE_PROJECT_ID, and
# FIREBASE_SERVICE_ACCOUNT_KEY_FILE (a path — the key itself is never in Secrets). Confusing these
# with Secrets was DEF-346's failure mode.
```

Everything else in the file — the two "⚠️ 2026-09-04" / T-205 paragraphs above it, every step below
it — is byte-for-byte unchanged. Exact wrapping/spacing may be adjusted for line length during
BUILD; the two anchor phrases (`GitHub Secrets this workflow reads` / `NOT GitHub Secrets`) and the
seven names between them must not be.

⭐ **Verified against the real file before writing this spec, not asserted on faith** — I patched a
scratch copy of the live `deploy.yml` with exactly this text and ran the extraction the test below
performs: claimed = read = the same 7 names, both directions empty. Output kept in this session's
scratch, not committed (throwaway verification script, no dependency on it).

### Contract — the new test's mechanism

Dependency-free, matching `tests/unit/deploy-migrate-uses-system-db-url.test.ts`'s precedent: read
the real YAML as text, extract two sets, diff both ways.

```ts
const CLAIMS_START = 'GitHub Secrets this workflow reads';
const CLAIMS_END = 'NOT GitHub Secrets';

function extractClaimed(text: string): string[] {
  const slice = text.slice(text.indexOf(CLAIMS_START), text.indexOf(CLAIMS_END));
  return [...new Set(slice.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

function extractRead(text: string): string[] {
  return [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
}

function diffBothWays(claimed: string[], read: string[]) {
  const claimedSet = new Set(claimed);
  const readSet = new Set(read);
  return {
    claimedButUnread: claimed.filter((n) => !readSet.has(n)),
    readButUnclaimed: read.filter((n) => !claimedSet.has(n)),
  };
}
```

`extractClaimed` is scoped to the text **between** the two anchor phrases only — never the whole
file — precisely so the "NOT GitHub Secrets" disclaimer sentence's own tokens (`DATABASE_URL`,
`SESSION_SECRET`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`) are never
double-counted as claims. Both anchors are NAMEs, not positions (bible §13 row 204) — they survive
any edit above or below the block. `extractRead` scans the whole file for the literal
`secrets.NAME` interpolation syntax, which by construction cannot appear in an English sentence by
accident (this is DEF-346's own design, unchanged).

### Invariants, with citations

1. **The claimed set and the read set are identical, checked both ways** — a name claimed but
   unread, and a name read but unclaimed, are both failures (DEF-346's own remedy design;
   `docs/DEFECTS-REGISTER.md` DEF-346).
2. **The disclaimer sentence's tokens are never counted as claims.** Enforced by scoping
   `extractClaimed` to text before the `NOT GitHub Secrets` anchor; verified directly by a
   real-file assertion (Tests §3 below) that `DATABASE_URL`/`SESSION_SECRET` never appear in
   `extractClaimed(workflow)`.
3. **Immune to DEF-179 (CRLF) by construction, not by luck.** No regex here uses `.` to bridge a
   token or a line boundary; both anchor lookups are literal `indexOf` substring searches, immune
   to `\r\n` vs `\n`; the token regex's character class (`[A-Z0-9_]`) never includes `\r`. Verified
   mechanically (Tests §6) by re-running both extractors against the same text with every `\n`
   replaced by `\r\n` and asserting identical output — this repo checks out CRLF
   (`core.autocrlf=true`, confirmed via `git config`, no `.gitattributes`), so a future checkout of
   this exact file may not be the LF-on-disk copy this spec was verified against today.
4. **A guard that has only ever been green proves nothing** (RULES §3.2 / bible §9) — satisfied two
   ways: (a) the real-file assertion (Tests §2) is run BUILD-side against the current, unfixed file
   first and must be RED (11 claimed vs. 7 read) before the Contract edit lands; (b) the two
   CONTROL tests (Tests §4, §5) prove the mechanism itself, independent of today's file content, by
   constructing synthetic text with a known injected mismatch of each shape and asserting it is
   caught.
5. **Prefer a guard to `!` on a regex match** (bible §13 row 206) — not applicable here; no
   non-null assertion appears anywhere in this design (`.match()`/`.matchAll()` results are handled
   with `?? []`, never `!`).
6. **The stale "do not exist yet" / "until they exist this workflow fails" premise is deleted, not
   refreshed** (`docs/DEFECTS-REGISTER.md` DEF-346's remedy row, explicit). Mechanically enforced by
   Tests §7.

### Tests — `tests/unit/deploy-secrets-list.test.ts`

1. **Sanity / population floor** (DEF-179 precedent — assert the scanner found rows, not nothing):
   `extractClaimed(workflow).length` and `extractRead(workflow).length` are each `≥ 5`.
2. **The real-file regression guard**: `diffBothWays(extractClaimed(workflow), extractRead(workflow))`
   — both `claimedButUnread` and `readButUnclaimed` are `[]`. **This is the test that must be
   confirmed RED against today's unfixed file** (11 claimed, 4 of them unread) before the Contract
   edit lands, and green after.
3. **Disclaimer tokens are not claims**: `extractClaimed(workflow)` contains neither `DATABASE_URL`
   nor `SESSION_SECRET`.
4. **CONTROL — claimed-but-unread is caught**, using synthetic text (not the real file):
   ```
   # GitHub Secrets this workflow reads: DEPLOY_HOST, PHANTOM_UNREAD_SECRET.
   #
   # NOT GitHub Secrets — runtime values: DATABASE_URL.
   ${{ secrets.DEPLOY_HOST }}
   ```
   `diffBothWays(...).claimedButUnread` is `['PHANTOM_UNREAD_SECRET']`.
5. **CONTROL — read-but-unclaimed is caught**, using synthetic text:
   ```
   # GitHub Secrets this workflow reads: DEPLOY_HOST.
   #
   # NOT GitHub Secrets — runtime values: DATABASE_URL.
   ${{ secrets.DEPLOY_HOST }}
   ${{ secrets.SURPRISE_UNCLAIMED_TOKEN }}
   ```
   `diffBothWays(...).readButUnclaimed` is `['SURPRISE_UNCLAIMED_TOKEN']`.
6. **CRLF robustness (DEF-179)**: `extractClaimed`/`extractRead` against `workflow` produce the same
   output as against `workflow.replace(/\n/g, '\r\n')`.
7. **Stale premise removed**: `workflow` does not match `/do not exist yet/i` or
   `/until they exist this workflow fails/i`.

Both controls (4, 5) and the CRLF check (6) were run against exactly this text before writing this
spec, using a throwaway script in this session's scratchpad — not written on faith that the regexes
would match. Output: control A → `{ claimedButUnread: ['PHANTOM_UNREAD_SECRET'], readButUnclaimed:
[] }`; control B → `{ claimedButUnread: [], readButUnclaimed: ['SURPRISE_UNCLAIMED_TOKEN'] }`; CRLF
→ identical arrays both ways. The real-file patch (Contract) verified 7-claimed/7-read/both-empty.

This cannot exercise an actual GitHub Actions run (no runner, no Secrets from this lane) — it only
proves the comment's claims and the file's reads agree as text, matching every other guard in this
family (`deploy-migrate-uses-system-db-url.test.ts`, `ci-env-contract.test.ts`).

### Migration slot

None. No schema change.

### Out of scope

- `docs/ops/README.md`, `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`,
  `docs/HANDOFF-TODAY.md`, any other `docs/tasks/*.md`, `packages/db/migrations/**`, `ci.yml`,
  anything under `apps/` or `packages/` — per briefing; any needed change described in the READY
  message instead.
- Any step logic, `env:` block, or job structure in `deploy.yml` — comment only.
- Marking DEF-346 `verified`/closed in the register — system32-85's edit, not this lane's.

### Done-when

- [ ] SPEC approved by system32-85.
- [ ] `tests/unit/deploy-secrets-list.test.ts` added, confirmed RED against the pre-fix comment
      (11 claimed / 7 read, 4 in `claimedButUnread`), then green after the Contract edit.
- [ ] `deploy.yml`'s comment replaced exactly as in Contract; nothing else in the file touched.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` (unit project, includes the new test) green.
- [ ] READY sent with real command output, the two controls' output, and the answer to the
      orchestrator's "documented as shipped but never armed on production" question.
- ⚠️ **Cannot be in done-when**: proof this comment stays accurate after a future Secrets change —
  that's exactly what the test guards going forward, not something this task can pre-verify.

### FOR IAN (bible row 200 — plain language)

**What's wrong:** the deploy workflow's comment told you to create four GitHub Secrets
(`DATABASE_URL`, `SESSION_SECRET`, and two Firebase ones) that the workflow never actually reads —
those four are already set as plain values on the server itself, not as GitHub Secrets. It also
still said "these don't exist yet," which stopped being true once deploys started succeeding.

**What I'm fixing:** correcting the comment to list only the seven Secrets the workflow actually
uses, saying plainly where the other four live instead, and adding a small automatic check so this
can't quietly go wrong again — if anyone ever adds a Secret to the workflow without updating the
comment (or vice versa), the test suite fails immediately instead of the comment just going stale
again.

**Nothing for you to decide here** — no new Secret to create, no behavior change, comment and a
test only.
