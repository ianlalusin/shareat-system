# T-549 — Save is the floppy-disk icon, Verify is the check icon

Status: BUILT (Sonnet), 2026-11-08. Ian, 8 Nov: "change the save button icon to real save, the diskette icon, and the
verify must be check icon." Branch `t549-save-verify-icons`, worktree `wt-t549`.

## Change
1. `components/ui/action-icons.tsx`: new icon `save` (floppy disk, 24x24, stroke 1.75, round caps).
   Rules: `^(save|update)\b` -> save; `^keep\b` -> check (unchanged look); new `^verify\b` -> check, before the
   approve/post/submit/confirm/send rule (which drops `verify`).
2. `components/forms/EditableRecord.tsx`: its icon-only Save submit draws `save` instead of `check`.
3. No other place hard-codes the check icon for a Save (every other Save goes through `actionIconFor`).

## Added scope (Ian, 8 Nov, via BOSS, after the icon grid; bible row 451)
- New icons `lock` (padlock), `thumbsUp`, `book` (ledger).
- `^close\s+\S` -> lock (a period close: Close month / this branch / shift / the float / {period}), before the cancel rule,
  which now matches only Cancel, Dismiss, Discard and the bare "Close" (X).
- `^approve` -> thumbsUp; `^post` -> book; `^confirm` -> check; Submit and Send stay `send`.
- Nothing else changes.

## Contract
Icons only. No behaviour, label, colour, size or accessible-name change. Approve/Post/Submit/Confirm/Send stay `send`.

## Verification
- `apps/erp/tests/t549-save-verify-icons.test.ts`: Save, Save draft, Update -> save; Keep "x", Verify, Verify & post -> check;
  Approve -> send; EditableRecord markup carries the save path.
- `npx tsc --noEmit` in apps/erp; unit project from the repo root; censuses/baselines unchanged.
