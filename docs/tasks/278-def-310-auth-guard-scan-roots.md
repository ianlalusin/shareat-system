# T-278 — DEF-310: `auth-transaction-callers.test.ts`'s `SCAN_ROOTS` is stale against its own sibling

> **Status: BUILT, PROVEN, READY SENT — 2026-09-12, lane A (`webapps-4e`).** Approved by
> `system32-85`. `SCAN_ROOTS` widened to the sibling's ten, `DEFINER_FILES` added on the same
> pattern. Four-state plant proof executed in `scripts/`. typecheck and full unit suite green.
> Floor (`> 50`) checked against the real widened count (536, up from 420 pre-widen) — unchanged,
> matches the sibling's own identical, equally-loose convention; not raised unilaterally to avoid
> creating a new cross-guard divergence. Awaiting commit.

## The pre-check, done first, per instruction — no live stray caller exists

Before proposing any widening: `git grep -n "authTransaction" -- '*.ts' | grep -v '\.test\.ts'`
(unscoped — a strict superset of anything `SCAN_ROOTS`, widened or not, could ever see) returns
exactly:

- `apps/erp/src/lib/session.ts:68` — a **comment** (`// ⛔ ... resolveActor opens its own
  authTransaction ...`), not code; confirmed by reading the line, not by trusting the grep.
- `packages/auth/src/sessions.ts` — four real calls, the one permitted caller (`REQUIRED_CALLERS`).
- `packages/db/src/client.ts:208` — the definition.
- `packages/db/src/index.ts:31,42` — line 31 is prose inside a doc comment (confirmed by reading
  it); line 42 is the one re-export (`export { authTransaction } from './client';`), the definer's
  own barrel line.

**No file outside the required caller and the two definer lines imports, calls, or re-exports
`authTransaction` today.** DEF-310 is the guard's blindness, proven distinct from "something is
actually exploiting it" — the two are different claims and only one of them is true. Not BLOCKED;
proceeding.

## Implementation spec, lane A

### The fix — extend to the sibling's set, exempt by name inside the scanned root, not by omitting it

`tests/unit/auth-transaction-callers.test.ts:31-32` currently reads:

> `/** Where a stray caller would do damage. `packages/db` is excluded: it DEFINES the helper. */`
> `const SCAN_ROOTS = ['apps', 'packages/auth/src', 'packages/domain/src'] as const;`

Its sibling, `tests/unit/system-transaction-callers.test.ts:62-76`, has ten roots and a
`DEFINER_FILES` exemption INSIDE the scanned `packages/db/src`, not a whole-root omission:

```ts
const SCAN_ROOTS = [
  'apps', 'scripts', 'packages/auth/src', 'packages/core/src', 'packages/db/src',
  'packages/domain/src', 'packages/etl/src', 'packages/etl-firestore/src',
  'packages/storage-firebase/src', 'packages/sync-firestore/src',
] as const;
const DEFINER_FILES: readonly string[] = ['packages/db/src/client.ts', 'packages/db/src/index.ts'];
```

⛔ **Omitting `packages/db` to dodge two files is how this class of defect is born** (per
`system32-85`'s own framing) — the two definer files are excluded BY NAME, and every OTHER file
under `packages/db/src` (repositories, other client code) becomes visible for the first time. This
task copies that exact shape into `auth-transaction-callers.test.ts`: the same `SCAN_ROOTS` (ten
roots, identical list — `authTransaction` and `systemTransaction` are exported from the same
`@shareat/db` barrel, so nothing distinguishes which roots could reach one but not the other), the
same `DEFINER_FILES` constant, and `scannable()` gains a `!DEFINER_FILES.includes(f)` clause
alongside its existing `extraExclude` check.

⛔ **Not touching `system-transaction-callers.test.ts`** — if the two guards disagree about
anything after this change (a file one flags and the other doesn't, for instance), that is a
QUESTION back to the orchestrator, not an edit to the sibling.

### The plant proof — four states, `scripts/` as the plant location

`scripts/` is the deliberately honest choice: `system-transaction-callers.test.ts` REQUIRES a caller
from `scripts/bootstrap-org.ts`, so that root is proven load-bearing for the sibling already, while
`auth-transaction-callers.test.ts` cannot see `scripts/` AT ALL today — a plant there is a real,
previously-unscanned location, not a token gesture.

1. Plant `scripts/_plant-def310.ts`: `import { authTransaction } from '@shareat/db'; export async
   function plantDef310() { return authTransaction(async () => null); }` — no legitimate reason to
   exist, calls `authTransaction` directly, outside `packages/auth/src/sessions.ts`.
2. Run the CURRENT (unwidened) guard with the plant present — expect GREEN, proving the blindness is
   real, not merely that today's tree happens to hold no violator.
3. Apply the `SCAN_ROOTS`/`DEFINER_FILES` widening.
4. Re-run — expect RED, naming `scripts/_plant-def310.ts` specifically.
5. Delete the plant. Re-run — expect GREEN, `git status` clean of residue.
6. Report all four states with literal output in READY, state (1) first and not skipped, per the
   standing rule this week: a green guard before the fix is what proves the fix's target was real.

### Out of scope

- `packages/db/src/**`, `packages/auth/src/**` — read for verification only, not edited.
- `tests/unit/system-transaction-callers.test.ts` — untouched; any disagreement is reported, not fixed.
- `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md` — DEF-310's row is already filed and committed
  (`01f048d`) by the orchestrator; not re-edited here.

### Tests / Done-when

Unit-only. typecheck clean · `npm run test` green, including both transaction-caller guards · the
four-state plant proof executed and reported with literal output · self-reviewed line by line · this
file's status line updated at the end.
