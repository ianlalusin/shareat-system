# T-582 — POS tablets: cards, "cash register", Register in a modal, the lock on each card

Status: SPEC (Opus), 2026-11-15. Ian (direct, with the live page erp2.shareat.net/admin/pos-tablets): "improve that screen
i to see cards of connected tablets, tills (rename till to cash register for familiarity), and for register a tablet make
that a modal called by an add button not always on screen then the approval lock on the bottom can transferred to status
of each connected tablet/terminal". Impeccable refinement of an Operate surface: kit, tokens and behaviour stay; the
drawing changes. Number T-582 (BOSS).

## Today (origin/main c7c5275)
`apps/erp/src/app/admin/pos-tablets/page.tsx` stacks four bordered sections: Linked tablets (a sentence + Revoke), Tills
(`TillsSection.tsx`, a table + an always-open "New till number" form), Register a tablet (an always-open form) and
Approval lock (one line per tablet login, with Clear the lock). `TillsSection` is shared with `/settings/pos-tablet`.

## Design
### Header
- `POS tablets`, description unchanged. Header action (right, like /ap): `+ Register tablet` → `FormModal` titled
  "Register a tablet", size md. Inside: today's form exactly (same `CheckedForm`, rules, fields, the "This replaces the
  tablet ending …" warning) with its submit in `DialogActions`. If the store has no tablet login, the modal holds today's
  `data-no-terminal` instruction text instead of the form. The Register section disappears from the page.
- Store filter row unchanged.

### Tablets (section heading "Tablets")
- A muted line under the heading: "Five wrong manager PINs in a day lock a tablet's refund approvals. The lock lifts by
  itself after 24 hours." The Approval lock section disappears from the page.
- A card grid (1 col on phones, 2 from `sm`, 3 from `xl`), kit tokens (`rounded-[20px] border-surface-border bg-surface`,
  as the T-568 cards).
- **The linked tablet's card** (`data-active-link`): title `Terminal {n}`; top-right a status pill:
  - not locked → `Approvals ready` (success-soft);
  - locked (the lock of `active.terminalPersonId`) → `Approvals locked` (danger/warning-soft, with an icon — never colour
    alone), plus the line `Locked since {when}. It lifts by itself after 24 hours.` (`data-locked`) and the `Clear the lock`
    form (same `clearLockAction`, same hidden fields) inside the card.
  - Body `dl`: Tablet `…ab12` (mono, full id in `title`), Signs in as, Linked `{when}` by `{name}`.
  - Footer: the existing Revoke `ConfirmDestructive` (unchanged props).
- **Every other tablet login** (a `terminals` entry whose `personId` ≠ `active?.terminalPersonId`): its own card, title =
  display name, body "No tablet is linked to this login.", the same status pill and the same lock line / Clear the lock.
  No login may lose its Clear the lock.
- Empty: no linked tablet and no login → one empty card with today's `data-no-terminal` text; linked none but logins
  exist → their cards, plus "No tablet is linked to {store} yet." above the grid.
- `Earlier tablets (n)` `<details>` stays under the grid, unchanged.

### Cash registers (shared `TillsSection`, both pages)
- Heading `Cash registers`; header action `+ Add cash register` → `FormModal` titled "Add a cash register", size md,
  holding today's `CheckedForm` (`createTillAction`, `POS_TILL_ADD_RULES`, same hidden fields) with the label
  "Cash register number (1 to 99)" and the submit "Add cash register" in `DialogActions`. The always-open form goes.
- The two explaining paragraphs stay, reworded till → cash register.
- The table becomes a card grid (same breakpoints). Each card: title `Cash register {n}`; status pill `Tablet set` /
  `No tablet` (word + tone); then two blocks, each keeping its own form exactly as today:
  - **Tablet**: the select + `Set tablet` (`linkTillAction`).
  - **Receipt printer**: paper radios, copies select, `Save printer` (`setTillPrinterAction`, the `form=` link kept).
- Empty: "No cash register at {store} yet. Add cash register 1, then choose its tablet."

### Wording: till → cash register
Every word a person reads on these two screens and in the flash sentences `actions.ts` writes for the till actions
(`Added cash register {n}. Choose its tablet and printer below.`, `The cash register has no tablet now.`, `Tablet chosen for
the cash register.`), aria-labels included. Code names (`TillsSection`, `createTillAction`, `data-tills`, files, routes)
stay. Domain sentences shown on the POS tablet itself (`day-close.ts` "not set up as a till") are NOT in scope: list them in
the hand-back.

## Contract
No behaviour change: same actions, fields, rules, capabilities, confirm tiers, flash routing. No migration, no domain
change, no new SQL. Censuses (action-link-sweep, t348, t411, t412, touch-target) re-measured, never hand-edited.

## Verification
- `npx tsc --noEmit` (erp). Unit: t505-pos-tablets-page, t546-tills-page, t546-tills-settings-page, the census tests;
  update only assertions that read the old drawing or the word "till".
- New unit test: a locked login renders its Clear the lock inside its own card (linked and unlinked login), an unlocked one
  reads `Approvals ready`; Register and Add cash register are behind `FormModal` triggers (no always-open form).
- `t546-pos-tills-actions` (integration) asserts flash text: update it; CI runs it.
- Rendered check at 1440 and 390 (Opus).
