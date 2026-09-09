# T-246 — DEF-233: the ERP shell must not render on the clock kiosk

> **Status**: 📝 **SPEC WRITTEN — awaiting `APPROVED`.** Written by lane B (`ianla-3a`) in plan mode
> on Opus, 2026-09-09. Recommends **`proxy.ts` now** (DEF-233's option 1, renamed from
> `middleware.ts` — see §2), with route groups (option 2) counted and deferred, not chosen by
> default. Flagged in §10 for a ruling because the register frames option 2 as "the correct end
> state" and this spec does not build it.

---

## 0. Assessment

| | |
|---|---|
| **Utilisation** | Every load of `/clock`, continuously, on a wall-mounted tablet staff punch in on all day. Also every ERP page load, since the fix sits in `AppShell`, mounted at the root layout |
| **Effort** | Small. 2 new files (~15 + ~15 lines), 1 modified file (+3 lines), 1 unit test file |
| **Adopt or build** | Build — this is Next's own supported extension point for exactly this problem (a Server Component cannot read the current pathname; the framework's answer is a proxy header) |
| **Recommendation** | Build option 1 now. Option 2 is real future work, counted in §3 so nobody re-measures it, and left as its own task per the register's own framing |

---

## 1. Goal

`/clock` never renders the ERP's sidebar/topbar chrome, regardless of whether a manager holds an
ERP session in the same browser — without flashing it first and hiding it after paint.

---

## 2. Why `middleware.ts` is the wrong filename, verified against the shipped docs

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md` (Next
16.1.6, this workspace's exact version):

> *"The `middleware.js` file convention has been **deprecated** in Next.js 16 and renamed to
> `proxy.js`. All functionality remains the same — only the file and export names have changed."*

So DEF-233's own remedy text and this task's stub both name the wrong file. The replacement,
`proxy.md`, confirms it is a straight rename with identical capability: create `proxy.ts` "in the
project root, or inside `src` if applicable, so it is located at the same level as `app`" — for
this app that is `apps/erp/src/proxy.ts`, a sibling of `apps/erp/src/app/`. The exported function
is named `proxy` (not `middleware`); `NextResponse.next({ request: { headers } })` makes a header
visible **upstream to Server Components** via `headers()` — `NextResponse.next({ headers })`
(no `request` wrapper) would instead leak it to the client, which the doc calls out by name as the
mistake to avoid. Runtime defaults to Node.js; setting a `runtime` export throws.

---

## 3. Counted, not estimated — what option 2 (route groups) would actually move

**Known hit printed first** (`reference_sweep_needs_nonzero_control`):
```
apps/erp/src/app/admin/stores/[id]/page.tsx   ← would move to apps/erp/src/app/(app)/admin/stores/[id]/page.tsx
```

| Counted (`apps/erp/src/app`, HEAD) | Method | Result |
|---|---|---|
| Total files under `app/` | `find . -type f \| wc -l` | **230** |
| Top-level route directories | `ls -d */ \| wc -l` | **34** |
| Directories that would move into `(app)/` (all but `api`, `clock`, `setup`, `sign-in`) | same, minus the 4 kept out | **30** |
| Total files that would relocate (excludes the 4 kept-out dirs and root `layout.tsx`/`error.tsx`/`global-error.tsx`/`not-found.tsx`/`globals.css`, which stay at the true root) | `find . -type f` filtered | **215** |
| `page.tsx` files among them | `find . -name page.tsx` filtered | **98** of the app's 101 |
| Files needing a relative-import depth fix — a relative import from inside a moved file reaching `src/lib/**` or `src/components/**` (path-alias `@/…` imports are unaffected; sibling imports within a moved subtree are unaffected) | `grep -rlE "from '(\.\./)+(lib\|components)/"` across `app/**`, excluding the 4 kept-out dirs | **167** |
| Cross-route relative imports (`expenses`, `inventory`, `ap`, `items`, `customers` imported from a sibling route folder) | same grep family, checked for any crossing the kept-out boundary | **0 cross the api/clock/setup/sign-in boundary** — the ones that exist move together with both ends, so they need no fix |
| Existing guards that derive a URL from a file path and do NOT strip a route-group segment today | read `tests/unit/nav-route-reachability.test.ts`'s `routeOf()`; read this task's own new guard (§6) | **2** — `routeOf()` would compute `/(app)/admin/stores` instead of `/admin/stores` for every moved route, breaking every nav-href comparison it makes; my own T-243 guard would fail identically on the two remedy routes it checks |

**Read, not guessed:** `node_modules/next/dist/docs/.../route-groups.md`. Because this design keeps
one shared root `app/layout.tsx` and only nests an *additional* `(app)/layout.tsx` inside it — never
declares a second **root** layout — the "full page reload between different root layouts" caveat the
doc names does not apply; this is "opting specific segments into sharing a layout, while keeping
others out," the doc's own second listed use case.

**What this buys, honestly:** the framework doing the path exclusion structurally, so no future
route can silently regain the shell by forgetting a header/session check. **What it costs today:**
215 files physically relocated, 167 of them also edited, at least 2 existing guards reworked in the
same commit, on a route tree that three other lanes have all landed work in this week (T-234, T-241,
T-243, lane D's `admin/users/[personId]`) — a single-commit, whole-tree change is real coordination
cost on a shared repo, separate from and additional to the mechanical count above.

---

## 4. Scope — the exact files

**Create**
- `apps/erp/src/proxy.ts` — the proxy file. Matcher-scoped to `/clock` only (§5); does not run on
  the other 100 routes at all.
- `apps/erp/tests/proxy-kiosk-header.test.ts` — unit, text-reads `proxy.ts` (§6 explains why, same
  reasoning as T-243's `readiness-remedy-routes.test.ts`).

**Modify**
- `apps/erp/src/components/shell/AppShell.tsx` — reads the header via `headers()`; renders bare
  children when it is present, exactly like the existing no-session branch. Replaces the DEF-233
  comment (`:7-14`) with one recording the fix.

**Not touched:** `apps/erp/src/app/clock/page.tsx` (its own Firebase auth is untouched — this is a
chrome decision, not an authorization change) · every other route · `docs/DEFECTS-REGISTER.md`
(orchestrator's — §9 states the row I want written) · route-group restructuring (§3, deferred).

---

## 5. Contract

```ts
// apps/erp/src/components/shell/kiosk.ts — new, pure, zero imports
/** Set by `proxy.ts` (matcher-scoped to `/clock`) on the way in; read by `AppShell` via
 *  `headers()`. Presentation only — `/clock`'s own Firebase auth is unrelated and unaffected;
 *  this header decides chrome, never access. */
export const KIOSK_HEADER = 'x-shareat-kiosk';
```

```ts
// apps/erp/src/proxy.ts — new
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { KIOSK_HEADER } from './components/shell/kiosk';

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(KIOSK_HEADER, '1');
  // ⚠️ `{ request: { headers } }`, not `{ headers }` — the wrapped form is what reaches a Server
  // Component's `headers()`; the bare form would instead leak to the client (Next docs, proxy.md).
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// Statically analysed at build time — cannot be built from a shared constant or a loop.
// Matcher-scoped to exactly the one route this fixes: proxy does not run on the other 100.
export const config = {
  matcher: ['/clock', '/clock/:path*'],
};
```

```ts
// apps/erp/src/components/shell/AppShell.tsx — the one changed branch
import { headers } from 'next/headers';
import { KIOSK_HEADER } from './kiosk';
// …
const session = await currentSession();
const headerList = await headers();
if (!session || headerList.has(KIOSK_HEADER)) return <>{children}</>;
```

⛔ **No `isKioskPath()` path-matching function.** The matcher is the only place a path decides
anything; `proxy.ts`'s body and `AppShell`'s check both react to the header alone. A second,
independently-written notion of "is this the kiosk" (a function nothing calls once the matcher does
the real work) is exactly the callerless-code shape this project keeps finding
(`reference_shareat_done_but_uncalled`) — so it is not built.

---

## 6. Why the guard reads `proxy.ts` as text, not by importing it

Same reasoning as T-243's `READINESS_REMEDY_ROUTE` guard, and worth restating because it is a
recurring shape: `proxy.ts` imports `next/server`, a runtime module this project's plain Vitest unit
project has no established contract for (no existing test imports it — checked: `grep -rl
"next/server"` under `apps/erp/tests` returns nothing). Importing it to test one string literal risks
either an edge-runtime shim mismatch or import cost for zero benefit, when the thing actually worth
guarding — **the matcher didn't silently drift to cover fewer or more routes** — is fully checkable
from the source text.

---

## 7. Invariants

1. `/clock` renders with no sidebar, no topbar, in every session state (no session, ERP session,
   ERP admin session) — the one behaviour DEF-233 exists to fix.
2. Every other route's shell is byte-for-byte unaffected: the new check is `||`-appended to the
   existing `!session` return, never replacing it.
3. ⛔ **No flash-then-hide.** The exclusion is decided server-side, before first paint, from a
   header set before the page renders — never a client effect that removes the shell after mount.
4. `/clock`'s own authentication (Firebase, separate from `__session`) is untouched. This task
   changes what renders around the page, never what the page itself authenticates.
5. The header carries no authorization meaning — it is presentation-only, stated in `kiosk.ts`'s own
   comment so a future reader does not promote it into a security check (bible §7: no
   client-*or-proxy*-side-only authorization was ever the claim here).

---

## 8. Tests

**Unit** `apps/erp/tests/proxy-kiosk-header.test.ts`:
1. Known hit printed first: `proxy.ts`'s source contains the literal `/clock`.
2. The `config.matcher` array, extracted by the same regex-block technique as T-243's guard, equals
   exactly `['/clock', '/clock/:path*']` — a config-drift guard. If someone widens or narrows it,
   this fails rather than silently changing which routes pay the proxy's per-request cost.
3. Negative control: the extracted matcher does **not** contain a bare `/` or `/:path*` — proving a
   change that accidentally matched every route would be caught, not just a change to `/clock`
   itself.

**Not unit-testable, and not attempted as one**: `AppShell`'s actual conditional (no existing test
renders `AppShell` — it needs `next/headers`/`next/navigation`/a session — and building that harness
for one boolean branch is disproportionate to this task). Verified instead by the browser pass in §9,
matching T-243's own split of "mine" vs. "the orchestrator's."

---

## 9. Done when

**Mine:** typecheck clean (`--incremental false`) · `npm test` (unit project) green including the
new file · `apps/erp/tests/clock-route-is-client-only.test.ts` still green, unmodified (this task
touches nothing `/clock/page.tsx` imports) · diff self-reviewed line by line · READY report with real
numbers.

⚠️ **Two definition-of-done steps this lane cannot run** (bible §9 items 4 and 5, both on my NEVER
list): the browser smoketest on 9008 and `npm run build`. **Exact steps for the orchestrator:**
(a) with an ERP admin session live in the browser, open `/clock` — confirm no sidebar/topbar, and
confirm the page's own Firebase sign-in still works unchanged; (b) view source / disable JS and
reload `/clock` — the shell must be absent in the raw HTML, not removed after hydration, proving
invariant 3; (c) open any ordinary route (e.g. `/admin/stores`) in the same session — confirm the
shell still renders exactly as before.

**Orchestrator's:** DEF-233's register row → `fixed`, recording that the fix is `proxy.ts` (not
`middleware.ts` — §2) and that route groups (§3) is deferred with its cost pre-counted · the browser
pass above · `docs/ROADMAP.html`.

---

## 10. Ruling requested

**Building option 1, not option 2, as this task's whole deliverable.** The register calls route
groups "the correct end state," and this spec does not build it — it counts it (§3) and stops. If you
want option 2 done now instead, or done as this task's immediate follow-up rather than left
open-ended, say so; the count in §3 is handed off either way so it is never re-measured from scratch.
