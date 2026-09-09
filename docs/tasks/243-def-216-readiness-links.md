# T-243 — DEF-216: a readiness check carries its own remedy link

> **Status**: 📝 **SPEC WRITTEN — awaiting `APPROVED`.** Written by lane B (`ianla-3a`) in plan mode
> on **Opus 5**, 2026-09-09, against HEAD `2a5edf4`. Number allocated by the orchestrator
> (`ianla-44`) for lane B. Three decisions below diverge from the wording of DEF-216
> (`docs/DEFECTS-REGISTER.md:286`) and this task's own title, and are flagged as **§10 Rulings
> requested** — none of them is taken silently (RULES §2, bible §3.4a).

---

## 0. Assessment (bible §13 row 163 style)

| | |
|---|---|
| **Utilisation** | Every store ever opened. The panel is the first screen an admin sees after `createStore`, and 3 of its 4 checks are red on a brand-new store by construction (T-222: rooms are seeded, nothing else is) |
| **Effort** | Half a day. One optional field, three literals, ~12 lines of JSX deleted and ~6 added, 5 integration assertions |
| **Adopt or build** | Build — it is the deletion of two hand-wired branches, not a new capability |
| **Recommendation** | Build. It is Ian's ruled step one of the tutorials work (roadmap, 8 Sep evening) and a strict subset of `docs/discovery/30-tutorials-assessment.md` Option B, so nothing here is thrown away when Option B lands |

---

## 1. Goal

Every store-readiness check that a screen can clear renders a link to that screen, driven by a field
on the check itself — so the two hand-wired `c.key === …` branches on `/admin/stores/[id]` are
deleted rather than joined by a third.

---

## 2. Census — counted at HEAD, not estimated

**Known hit printed first, so a sweep matching nothing cannot pass as zero**
(`reference_sweep_needs_nonzero_control`):

```
apps/erp/src/app/admin/stores/[id]/page.tsx:121:  href={`/settings/sales-channels?store=${store.id}`}
```

| Counted | Method | Result |
|---|---|---|
| Hand-wired remedy branches | `grep -rn "c\.key ===" apps/erp/src` | **2**, both in `[id]/page.tsx` (`:115` salesChannel — T-230; `:127` signIn — T-229 slice 3). No third exists anywhere |
| Checks returned by `storeReadiness` | read `service.ts:348-399` | **4** — `room`, `adminScope`, `salesChannel`, `signIn` |
| Renderers of `ReadinessCheck` | `grep -rn "ReadinessCheck\|storeReadiness"` | **1** page (`[id]/page.tsx`, via `admin/stores/lib.ts`), **3** integration test files |
| Peer test files that would break on a new field | read both | **0** — `org-store-identity.test.ts:249` and `sales-channels-admin.test.ts:137-147` assert `.ok` / `.blocking` / key-and-label regexes, never a whole-object `toEqual`. Adding an optional field is additive |
| Executable app-route strings inside `packages/**` today | `grep -rnE "['\"\`]/(settings\|admin\|staff\|inventory\|expenses\|attendance)[a-z/-]*" packages --include=*.ts` | **0.** ~20 hits, **every one inside a comment**. §5 decision 1 is therefore the first, and says so rather than letting a reviewer find it |

---

## 3. Scope — the exact files

**Modify**
- `packages/domain/src/stores/service.ts` — the field on `ReadinessCheck`, and 3 of the 4 checks populate it.
- `packages/domain/tests/integration/stores.test.ts` — the 5 assertions in §7.
- `apps/erp/src/app/admin/stores/[id]/page.tsx` — delete both `c.key === …` branches; render generically.

**Granted but NOT needed — reported rather than used:** `apps/erp/src/app/admin/stores/lib.ts`
re-exports `ReadinessCheck` as a *type* (`:14`) and destructures nothing from it. Adding an optional
field needs no edit there. If the orchestrator expected a change in that file, the expectation and
this spec disagree and I would rather hear it now.

**Requested, outside the granted list — §10 ruling 3:** `apps/erp/tests/readiness-remedy-routes.test.ts` (new unit guard).

**Not touched:** the four predicates and their `ok`/`kind`/`blocking`/`detail` values · `docs/DEFECTS-REGISTER.md` (orchestrator's — §9 states the row I want written) · any migration (there is none; see §6 invariant 1) · `/settings/sales-channels`, `/staff`, `/inventory/locations` themselves.

---

## 4. Contract

```ts
// packages/domain/src/stores/service.ts

/** Where a person goes to clear a check, and what the link says. ⛔ Built per request beside the
 *  predicate it belongs to — never a column, never cached (bible §4.2 rule 7, §13 row 176). */
export interface ReadinessRemedy {
  readonly href: string;
  readonly label: string;
}

export interface ReadinessCheck {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  readonly kind: 'auto' | 'manual';
  readonly blocking: boolean;
  readonly detail: string;
  /** Absent when no single screen clears it — see `adminScope`, whose remedy is the Reactivate
   *  button on this same page. Rendered only while `ok` is false. */
  readonly remedy?: ReadinessRemedy;
}

/** The one place a readiness remedy route is written. Exported so a unit guard can walk it without
 *  a database — `storeReadiness` needs a `tx`, a route guard must not. */
export const READINESS_REMEDY_ROUTE = {
  room: '/inventory/locations',
  salesChannel: '/settings/sales-channels',
  signIn: '/staff',
} as const;
```

**The four checks**, with the store id interpolated by `storeReadiness`, which already holds `store`:

| key | remedy | label | why this one |
|---|---|---|---|
| `room` | `/inventory/locations?store=<id>` | `Add a stock room →` | `locations/page.tsx:43` reads `sp.store` and falls back to `stores[0]` — verified by reading it, not assumed |
| `adminScope` | **none** | — | Cleared by the Reactivate button already on this page (its own `detail` says so). A self-link is noise; v1 likewise left 3 of 12 steps hrefless |
| `salesChannel` | `/settings/sales-channels?store=<id>` | `Add a sales channel →` | Byte-identical to the string being deleted from `page.tsx:121-125` |
| `signIn` | `/staff` | `Issue a PIN from Staff →` | Byte-identical to `page.tsx:130-132`. ⚠️ `/staff` takes no store param today; adding one is a behaviour change and is out of scope |

**3 of 4 carry a remedy.** `Add a stock room →` is the only new user-facing string in this task.

**The renderer** — `[id]/page.tsx`, replacing lines 115-133 in full:

```tsx
{!c.ok && c.remedy && (
  <Link href={c.remedy.href} className="text-xs underline underline-offset-2">
    {c.remedy.label}
  </Link>
)}
```

Same classes, same position, same `!c.ok` condition as the two branches it replaces, so nothing on
screen moves for the two checks that already had a link.

---

## 5. The three decisions, and the reasoning

**1 — the remedy is built in the domain, and this is the first executable app route in `packages/**`.**
The briefing rules that `href` belongs to the check definition; discovery 30's Option B end state
carries predicate, link and prose in one co-located declaration; and the alternative — a remedy-key
enum the app maps to routes — is an indirection layer for a four-row list. ⚠️ **The real cost, named
rather than buried:** a renamed ERP route becomes a silent 404 that no typecheck and no test catches
(this project's standing green-but-broken shape). §10 ruling 3's unit guard is what closes it; if
that guard is declined, this cost stands and only a browser sweep finds it.

**2 — ⛔ `doc` is NOT restored, against the wording of DEF-216 and this task's own title.**
v1's `doc` is an anchor into `docs/NEW_STORE_SETUP.md`. **That file does not exist in v2** — `grep -rn
NEW_STORE_SETUP` returns 3 files, all `docs/` prose *about v1*, zero code. Discovery 30 §5 rejects
Option A (prose in a `docs/` tree) using v1's own drift post-mortem as the evidence, and §8's
not-doing table lists reviving a manual. Option B's replacement for `doc` is prose **beside the
code** behind the `?` panel — not an anchor. So `doc` has no destination in v2's architecture now or
later, and a `doc: string` nobody reads is dead data of exactly the kind this project keeps finding
(`reference_shareat_done_but_uncalled`). **Restoring it would be building the rejected option's data
shape.** Ruling requested — the register row is the orchestrator's to amend.

**3 — `remedy: { href, label }`, not a flat `href?: string`.**
The two links on screen today say *"Add a sales channel"* and *"Issue a PIN from Staff"* — copy that
tells a manager what they are about to do. A generic renderer needs the label with the href, and two
independent optional fields admit a state that cannot render (a label with no href). One object makes
that unrepresentable. A grep for `href` still finds it.

---

## 6. Invariants

1. ⛔ **Readiness stays derived on read** (bible §13 row 176, §4.2 rule 7). No column, no cache, no
   migration. Asserted executably in §7 test 5, not promised in prose.
2. The four predicates, and every `ok` / `kind` / `blocking` / `detail` value, are **unchanged**.
   This task changes what the panel *offers*, never what it *decides*.
3. `salesChannel` and `signIn` render the same link text, to the same URL, in the same place as
   today — the two hand-wired branches are deleted without losing a pixel.
4. A remedy renders **only while the check is red** (`!c.ok`), matching both branches today.
5. No new authorization surface: the three routes already exist and gate themselves. This adds a
   link, never a capability (bible §7 — no client-side-only authorization, and none is added here).

---

## 7. Tests — written first, watched to fail for the right reason

`packages/domain/tests/integration/stores.test.ts`, lane DB **`shareat_test_t229`**:
`node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_t229 packages/domain/tests/integration/stores.test.ts`

1. A new store's `salesChannel` remedy is `/settings/sales-channels?store=<the real storeId>` — the
   id interpolated from the fixture, so a wrong param name fails rather than passing on shape.
2. `signIn` → `/staff`, label `Issue a PIN from Staff →`.
3. `room` → `/inventory/locations?store=<the real storeId>`.
4. ⭐ **`adminScope` has NO remedy** — the negative case, proving the field is deliberate per check
   rather than blanket. Without it, three positives could pass with a remedy on all four.
5. ⭐ **The derived-on-read guard**: after `createSalesChannel` flips `salesChannel.ok` to true, a
   query over `information_schema.columns` for `stores` finds **0** columns matching
   `%readiness%`/`%href%`/`%remedy%` — with the **non-zero control asserted first** (the same query
   for `code` returns 1), so a guard that scans nothing cannot pass as a guard that found nothing
   (`reference_sweep_needs_nonzero_control`, bible §13 row 181).

⚠️ Existing test 169 (`goes red again when the condition stops holding`) must still pass untouched —
it is invariant 1's original proof and this task must not disturb it.

**Unit — only if §10 ruling 3 is granted.** `apps/erp/tests/readiness-remedy-routes.test.ts`: every
value of `READINESS_REMEDY_ROUTE` resolves to a real `page.tsx` under `apps/erp/src/app`, plus a
deliberate `/no-such-route` control asserting the guard can fail. Placed in `apps/erp/tests/` because
the unit project's include is `apps/**/*.test.ts` (read from `vitest.config.mts`) — ⛔ **not** under
`apps/erp/tests/integration/`, which matches no include glob at all (DEF-221).

---

## 8. Out of scope

`doc` and any documentation tree (§5 decision 2) · the `?` control, the tutorial registry and
cross-feature prerequisites (discovery 30 T-2xx b/c, Phase 7) · the predicates themselves · adding a
`?store=` param to `/staff` · trimming *"Add one under Settings › Sales channels."* from
`salesChannel`'s `detail` now that a real link sits beside it — a copy change in a link task; logged
as a one-line follow-up for Option B's prose pass · `docs/DEFECTS-REGISTER.md` (orchestrator's).

---

## 9. Done when

**Mine:** typecheck clean (`--incremental false`, per the shared-tree stale-`tsbuildinfo` trap) ·
unit project green · the 5 integration assertions green on `shareat_test_t229` · the two `c.key ===`
branches gone, verified by a repo-wide grep returning 0 with a control · diff self-reviewed line by
line · READY report with real numbers.

⚠️ **Two definition-of-done steps this lane cannot run** (bible §9 items 4 and 5, declared now rather
than discovered at READY): **the browser smoketest on 9008** and **`npm run build`** are both on my
NEVER list in the briefing. The panel is a rendered link — bible §13 row 177's lesson is that this
class of defect is found *by looking at the page*. **I will hand the orchestrator the exact steps:**
open `/admin/stores/<a store with no channel>`, confirm three links render only while red, click each
and land on the right screen with the store preselected.

**Orchestrator's:** DEF-216's register row → `fixed`, recording that `href` was restored as
`remedy: {href,label}` and that **`doc` was deliberately not carried, with §5 decision 2's reason** ·
`docs/ROADMAP.html` · the browser smoketest above.

---

## 10. Rulings requested — I stop here until these come back

1. **`doc` not restored** (§5 decision 2). Diverges from DEF-216's remedy sentence and this task's
   title. If you want `doc` anyway, say what it should point at — I could not find a destination.
2. **`remedy: { href, label }`** rather than a flat `href?: string` (§5 decision 3). One word vetoes it.
3. **Scope +1 file** for the route guard: `apps/erp/tests/readiness-remedy-routes.test.ts` (§7). If
   declined, `READINESS_REMEDY_ROUTE` is dropped and the three routes are inlined — and the silent-404
   risk in §5 decision 1 stands, with the browser sweep as its only detector.
4. **`admin/stores/lib.ts` needs no change** (§3). Flagged in case you expected one.
