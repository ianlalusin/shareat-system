# Handoff — 2026-10-08 (orchestrator; T-377..T-382 and T-338 built; push to main waits on Ian)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) is at migration 0186** (deployed 7 Oct, `d79e754`). Everything since —
T-379, T-380, T-381, T-382 (migration **0187**), T-338, DEF-600 — is committed on local `main` and pushed to branch
**`wrapup/2026-10-08`, NOT to `main`** (a push to `main` deploys; Ian was away). Two LIVE production holes close only with
that push: **DEF-601** (voided supplier bills still set branch prices) and **DEF-605** (the sign-in `next` check lets a
tab through — open redirect). **Lipa links to POS on Monday 12 Oct** (bible row 284); it passed its 90-day check.
Next free migration **0188**.

## Gates (full gate 12, fresh `shareat_test_orch_gate12`, at `2b9f0d8`)
typecheck **0** · build **0** · integration **5584/5586** — the 2 were T-382's two new CHECK keys not yet provoked, fixed
in `3682fb2` (42/42 on a fresh DB) · unit **4585/4592**: the 6 failures (glossary-trap-names, no-committed-secrets,
position-defaults-callers, t336, t375-no-typed-sales G1e, no-typed-values G3) all **pass alone** (53/53) — load flakes.
Since `2b9f0d8`: one test commit and docs only. Screen smoke on 9008 (2026-10-08): every proof ✅ (forged session —
screens, not sign-in).

## What happened (since 17bd484)
- **Deploys:** 0182–0185 (6 Oct) and 0186 (7 Oct) with Ian, prechecks recorded in `docs/ops/README.md`.
- **POS:** the v2 store-scoped key works for Lipa (`docs/ops/pos-v1-key.md`); T-375 S0 census script built; **Lipa GATE
  PASS** (90/90 days; methods Bank Transfer, Cash, Gcash, QRPH). Runbook for Monday: `docs/ops/lipa-pos-link-runbook.md`.
- **T-377** DEF-596/597 · **T-378** item unit (0186), DEF-598/599/600 · **T-379** DEF-564, 568–572, 575, 592, 601, 602 ·
  **T-380** no typed values or banner text in any URL (signed one-minute flash cookie; every screen; DEF-476, 603, 604,
  605) · **T-381** DEF-606 · **T-382** guarded unlink (0187; DEF-607) · **T-338** manager readiness warning.
- **Ian's rulings, recorded:** row 283 (v1 owns the goal, never the method; research-evaluate-propose on every design;
  redesign allowed if more user-friendly), row 284 (Lipa links Mon 12 Oct), row 285 (the unlink, answer "a" on the Open
  Questions page), row 286 (T-338's 2026-09-24 manager ruling). Open Questions: `t378-q1-unit-history` (convert an item's
  history to a new unit? recommended: keep it locked) is still open.
- **Defects logged and open:** DEF-608 (returns refusal says "delivery line [hidden]"), DEF-609 ("Check POS again"
  shows after unlink; refuses safely).

## Pick up here
1. **With Ian: the push to `main`.** First the three READ-ONLY 0187 prechecks as `doadmin` (`docs/ops/README.md` deploy
   gate, P0187a–c; **P0187b lists who receives the new `unlink_store_from_pos` grant — it should be only Ian**). Then
   push, watch CI and the deploy, confirm 167 rows in `drizzle.__drizzle_migrations`. CI has been flaky on timing tests
   (A19 fixed by T-381); if CI fails, read the log before re-running.
2. **Monday 12 Oct with Ian:** link Lipa per the runbook (map 4 methods → money accounts, verify/void any open typed
   day, then Link). First import the morning after.
3. Small: DEF-608, DEF-609; T-374/T-367 screen smoke; T-343 S5.4/S8/S9.

## Do not decide these alone — they are Ian's
- `t378-q1-unit-history` (recommended: keep a used item's unit locked; retire and recreate if wrong).
- Told, not asked (tell Ian): after unlink a manager can still withdraw an imported day and type it again; an unlinked
  store keeps its POS store id, so only the same store can relink to it; an unlink waits until every imported day is
  verified or withdrawn; on stores with >10 affected assets the store-opening confirm names 10 then "and N more".

## Traps that bit this session
- **Two agents mutating/testing the same file at once** produces phantom failures (S3a, S6) — one mutant run per file.
- **Agent tools write CRLF and even 0x08 bytes** into files: byte-check with python, never `grep $'\r'` in a loop.
- Shell pastes in Git Bash: `<>'draft'` creates a file; Ctrl+V doesn't paste (Shift+Insert).
- The laptop sleeps mid-gate unless keep-awake is requested; a slept gate shows absurd durations.
- `run-with-db.mjs` vitest runs hang without `< /dev/null` when backgrounded.
- Lane worktrees: node_modules are JUNCTIONS — delete them with `[IO.Directory]::Delete(path,$false)`, never recursively.

## Lane DBs (drop when convenient)
`shareat_test_t377*`, `t378*`, `t379*`, `t380*`, `t381`, `t382*`, `t338`, `cmk`, `smoke1008`, `t378smoke`, `t379smoke`,
`orch_gate9..12`, `fix378`, `t382s1x`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. Read the
Open Questions page (bible row 252) with ArtifactData before building anything gated on Ian. GREP the
register and bible, never Read them whole.
State: production at 0186; local main (pushed to wrapup/2026-10-08, NOT main) carries T-379..T-382 + T-338,
migration 0187. Next: with Ian, the 0187 prechecks then the push to main (closes live DEF-601, DEF-605);
Monday 12 Oct link Lipa per docs/ops/lipa-pos-link-runbook.md. Next free migration 0188.
STANDING: lanes are Sonnet subagents (tester/builder/auditor separate, own _test DB, git worktrees for
parallel lanes); Opus only for specs, reviews and money audits; RUN mutants; commit slices locally; never
push to main without Ian; byte-check every changed file for \r and \x08 before committing; republish
docs/WHATS-LEFT.html after every commit that closes a DEF; FULL suite on a fresh gate DB before any push;
no edits while a gate runs; request keep-awake for long gates. Messages are short.
```
