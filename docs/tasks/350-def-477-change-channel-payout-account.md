# T-350: an admin can change a channel's payout account after it is set (DEF-477)

**Status:** DONE 2026-09-28 (gates PASS; §9.4 forged-session smoketest 19/19; post-commit audit pending, option (a)). APPROVED 2026-09-28 (orchestrator). **Model:** Sonnet, tester then builder. **Migration:** none.
**Runs after** the T-343 S5.5v/u/w commit (`channel-settlements/actions.ts` is an S5.5v path).

## Why
Ian, 2026-09-28: *"admin must be able to change that when set cause in real world payment accounts can be updated."*
On `/channel-settlements` the payout-account picker (`apps/erp/src/app/channel-settlements/page.tsx:81-130`) renders
only for channels with NO account (`unwired`, `:53`). Once set, the channel card shows the account name
(`:158`) and nothing on screen can change it. The domain already allows a re-set: `setChannelPayoutDestination`
(`packages/domain/src/channel-settlements/index.ts:574`) has no "already set" refusal and is gated by
`manage_store_settings` for the channel's store. So the gap is the screen, plus refusals that are still developer
`throw new Error` text.

Changing the account is safe for history: a posted settlement's journal lines carry the account they used; the channel
setting is read only when a new settlement posts.

## Ian's ruling (2026-09-28): ADMIN ONLY
Both the first set and every later change need a new store-scoped capability **`set_channel_payout`** (super ✅, admin ✅,
manager ✗, staff ✗). ⚠️ The CAPABILITY-MATRIX.md row is added BY THE ORCHESTRATOR IN THE SAME COMMIT as `capabilities.ts` — `tests/unit/capability-matrix.test.ts` fails if the document and the union disagree (a pre-wired row made the gates red, 2026-09-28). Row text: "| `set_channel_payout` | store | ✅ | ✅ | **✗** | ✗ | T-350 / DEF-477. Ian, 2026-09-28: admin only. |" beside `set_cash_policy`. It replaces
`manage_store_settings` in `setChannelPayoutDestination`. Declare it exactly as `set_cash_policy` is declared in
`packages/auth/src/capabilities.ts` (the union `:232`, the list `:360`, scope `:530`, tier `:714`, the role table
`:921`, the human title `:1131` — "change where a sales channel's payouts bank"). Wherever this spec says
`manage_store_settings` below, read `set_channel_payout`. A manager now sees the account but neither the unwired panel's
form nor Change (the unwired warning still shows, with "an admin must set it").

## Contract
1. **Screen — `apps/erp/src/app/channel-settlements/page.tsx`.** Every channel card (`:142-160`) for a WIRED channel
   shows its payout account and, when the viewer holds `manage_store_settings` at that channel's store, a **Change**
   control that reveals the same form as the unwired panel (`setPayoutDestinationAction`, hidden `channelId`, a
   `moneyAccountId` select of that store's active accounts) with the current account pre-selected, plus a Cancel.
   Use a `<details>`/`<summary>` disclosure (server component, no client state). Viewers without the right see the
   account name only, no control. The unwired panel is unchanged.
2. **Capability check for rendering.** Decide visibility with the repo's existing server-side "can the actor do X at
   store Y" helper used by other pages (grep `can(` / `hasCapability` in `apps/erp/src/app`); the domain `authorize`
   stays the real gate.
3. **Domain — `setChannelPayoutDestination`.** (a) Choosing the account that is already set is a no-op success
   (no write). (b) The three `throw new Error(` refusals (`:582`, `:588`, `:595-601`) become `refuse(<same raw>,
   <human sentence>)`: "That channel no longer exists.", "That money account no longer exists.",
   "<account> belongs to another store. A channel banks into its own store's account — moving money between stores is
   a transfer, not a setting.", "<account> is retired, so nothing can be banked into it." Ratchet ceiling for
   `channel-settlements` lowers accordingly (tester).
4. **Banner.** On success after a change: `?ok=destination` reads "Payout account changed. New settlements bank into
   <account>." when the channel already had one; keep today's text for a first set. (Pass `changed=1` in the redirect.)

- **BUILDER paths:** `packages/auth/src/capabilities.ts`, `apps/erp/src/app/channel-settlements/page.tsx`, `apps/erp/src/app/channel-settlements/actions.ts`,
  `packages/domain/src/channel-settlements/index.ts`.
- **TESTER paths:** `apps/erp/tests/t350-channel-payout-change-render.test.ts` (new),
  `apps/erp/tests/integration/t350-channel-payout-change.test.ts` (new); ruled edit: `tests/unit/t343-throw-ratchet.test.ts`
  (channel-settlements ceiling only).
- **Red legs:**
  - C1: an actor with `manage_store_settings` changes a wired channel from account A to B → the channel reads B; a
    settlement posted before the change still shows A in its journal lines (red: none today — screen legs below are
    the red; C1 may be green at domain level, say so).
  - C2: choosing the same account again writes nothing (row `updated_at` unchanged, or no audit row).
  - C3: an actor WITHOUT the right at that store is refused by `authorize` (domain) and sees no Change control (render).
  - C4: another store's account → the human "belongs to another store" sentence (red: developer text).
  - C5: a retired account → the human "retired" sentence.
  - R1 (render): a wired channel card for a manager shows "Change" and a select pre-selected to the current account
    (red: no control today); R2: a viewer without the right sees no control.
- **§9.4:** tester changes a channel's payout account in Chrome on 9008 and records a settlement afterwards.
- **Extra legs (admin only):** C6 a MANAGER is refused both a first set and a change (red: allowed today); R3 a manager
  sees no form in the unwired panel and no Change. Capability-matrix tests (grep `CAPABILITY-MATRIX` in tests) must
  stay green with the new row — the tester adds the ✗-fires proof there if the suite requires one per capability.
- **Out of scope:** a change history screen.
- **Done when:** reds red→green, typecheck clean, ratchet not raised, smoketest done.
