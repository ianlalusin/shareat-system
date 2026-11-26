# T-642: AI hub screen redesign (Settings > AI hub)

**Owner:** builder (Sonnet). **Spec:** BOSS, 26 Nov 2026. No migration. Builds on T-640 (`docs/tasks/640-ai-hub.md`).

**Ian, 26 Nov 2026 (with a screenshot):** "once a key is saved show its preview with ****last4 then hide the input box and show edit button instead. then like v1 they must be able to organized based on priority and fallback so if claude is at top no 1 its first use, number 2 is first fallback and so on. make them dragable cards and if you could design a widescreen 2 columns or split screen vertical better so we dont have to scroll through the bottom always".

## Brief

1. **Saved key.** Show `•••• kgAA` (masked, plus the last 4 the server already returns, never more) and a quiet Edit button. The password box, Cancel and Save appear only after Edit (a client-side toggle; no key value is kept beyond the form submit). A provider with no key shows the box directly. The "To save, fix the field marked above." line must not show under an untouched empty required field: fixed in the page's usage (`quietSummary` on the form), never by weakening a rule.
2. **Fallback order.** One list of the org's ACTIVE models as numbered cards (1 = first used, 2 = first fallback ...). Each card: provider, model label, tested status, Move earlier / Move later (44px, real forms, so keyboard and phone work), Test, Switch off. Cards drag by a grip (in-house pointer handler, mouse + touch + pen, no new dependency). A drop calls one server action that saves the whole order in one transaction: new domain function `setAiModelOrder(tx, actor, { order })` (`authorizeHub` first, refuses anything but exactly the active set, one audit row `ai_model.order_set` with the whole before and after, nothing written for an unchanged order). Models with a key that are tested-but-off or untested list below in "Not in use" with Test / Switch on.
3. **Layout.** From `lg`: two columns. Left: Providers and keys (compact cards), Stores. Right (sticky, `max-height` with its own scroll): Fallback order, This month (spend vs cap, with a bar), caps and limits. Below `lg`: one column, in the order spend, fallback order, providers, caps, stores. No sideways scroll at 390px. House parts only: Page, Card, Button, SubmitButton, EditableRecord, CheckedForm, Field.
4. **Guards kept.** Authorize before field rules (in the domain); `redirectWithFlash` only inside exported actions; submit labels are Save or COMMANDS verbs (no new verb: Edit and Cancel are `type="button"` outside the judged position); touch targets 44px; the key never reaches the page (no repo, no envelope).

## Files

- `apps/erp/src/app/settings/ai-hub/page.tsx` (layout, Providers, Usage, Order + Not in use), `KeyEditor.tsx` (client: masked preview, Edit toggle), `FallbackOrder.tsx` (client: numbered draggable cards), `model-bits.tsx` (test badge), `actions.ts` (+ `setModelOrderAction`).
- `packages/domain/src/ai/hub.ts` (+ `setAiModelOrder`), `index.ts` (export).
- Tests: `apps/erp/tests/t640-ai-hub-screen.test.ts`, `packages/domain/tests/integration/t640-ai-hub.test.ts`, `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts` (pin moved), `tests/unit/domain-actions-have-callers.test.ts` (comment).

## As built

- Written on a machine with no spare RAM: **nothing was run** (no npm, tsc, vitest, browser). Another PC must run the typecheck, the tests below, `npm run census:write` and look at the screen at desktop and 390px.
- `KeyEditor`: `useState(!hasKey)`; a saved key renders the preview branch (dots + `last4`, Edit) and returns before the form. The provider card is re-keyed by `updatedAt`, so a saved or replaced key remounts it locked. Key box unchanged (password, `autoComplete="off"`, no value).
- `FallbackOrder`: pointer capture sits on the `<ol>` (a card that moves in the list would lose its own capture). On release it writes `JSON.stringify(order)` of `provider/model` into one hidden input and `requestSubmit()`s a form to `setModelOrderAction`. The component is re-keyed by the saved order plus the flash, so a refused drag snaps back. Shortcut: no auto-scroll near the list edge.
- Layout trick: two wrappers are `display: contents` below `lg` so `order-*` classes can reorder the five sections in one column; at `lg` they become the two real columns.
- `MoveForm` (one dynamic-label button) moved to `FallbackOrder.tsx`, so the G8b `DYNAMIC_BUTTONS` pin moved from `settings/ai-hub/page.tsx` to `settings/ai-hub/FallbackOrder.tsx`.
- Not done / doubtful: without JavaScript a saved key cannot be edited (the Edit toggle is client-side; the rest of the app also needs scripts). A drag is mouse/touch/pen only; keyboard users use Move earlier / Move later. Sticky right column and the `contents` reorder are unseen in a browser.
