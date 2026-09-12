# T-283 — granting capabilities is one-at-a-time, and there are 96 of them

**Reported by Ian, 2026-09-12**, with the URL that shows it:
`/admin/users/01a085d4-…?ok=Granted+charge_staff_for_discrepancy` — *"capability grant must be
multi select."*

## The defect

`apps/erp/src/app/admin/users/[personId]/page.tsx:195` offers a single
`<select name="capability" required>`. `setCapabilityGrantAction`
(`apps/erp/src/app/admin/users/actions.ts:181`) reads `str(formData, 'capability')` — one value.

`CAPABILITIES` holds **96** entries and `grantableCapabilitiesFor` returns every one the role does
not already have, so kitting out a person who needs six extra capabilities is six form
submissions, six redirects and six audit rows — each with the screen scrolled back to the top.

## The fix, and the two things it must NOT do

Checkboxes, submitted as a repeated `capability` field, read with `formData.getAll`.

⛔ **1. The per-capability gate is not bypassed.** Each selected capability still goes through its
own `grantCapabilityAsActor(tx, actor, { personId, capability })` call, which owns the
`authorize()`, the self-grant check and the capability-name check that DEF-223 moved into
`packages/auth` precisely because *"a rule in one route file is a rule the next route file
misses."* A loop is the change; a batched grant helper that checks once and writes many is
explicitly NOT.

⛔ **2. Partial success is refused.** All of the selected capabilities are granted inside the ONE
`withOrgPrincipal` transaction already wrapping this action, so a refusal on the fourth rolls back
the first three. The alternative — grant what we can, report what failed — leaves an administrator
reading a success banner while holding a half-applied authority change, and "who could do this in
March" stops being answerable from the row set alone. **All or nothing, and the error names the
capability that caused it.**

## ⚠️ A flat list of 96 checkboxes is not a fix

For a cashier, `grantableCapabilitiesFor` returns most of the catalogue. The checkboxes are
grouped by **`CAPABILITY_SCOPE`** — `store`, `org`, `platform` — which already exists in
`packages/auth/src/capabilities.ts:377` and is not decoration here: this screen already tells the
reader *"Holding a capability is never enough on its own — a store-scoped action also needs the
store in scope."* Grouping by scope puts that warning next to exactly the capabilities it applies
to, at the moment of the decision.

⚠️ Not reinvented (RULES §3, UI/UX is a third authority): this reuses the existing full-width
touch-target row idiom from `settings/sales-channels/page.tsx`'s `Radio` — *"touch targets are
full-width rows, not bare dots — phone portrait is the canvas."*

## Files this task may touch

- `apps/erp/src/app/admin/users/[personId]/page.tsx`
- `apps/erp/src/app/admin/users/actions.ts`
- `docs/tasks/283-multi-capability-grant.md` (this file)

## Definition of done

typecheck clean · unit suite green · one capability still grants exactly as before (no regression
in the single case) · ⚠️ smoketest on 9008 owed — port coordination with system32-85.
