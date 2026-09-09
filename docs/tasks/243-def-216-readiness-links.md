# T-243 — DEF-216: put v1's `href` and `doc` back on `ReadinessCheck`

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane B** (`ianla-3a`). Lane B writes the spec into this file
> **in plan mode**, sends `[B] SPEC`, and stops until it receives `APPROVED`. Nothing is
> approved yet.

## Why this number exists

**DEF-216** (`docs/DEFECTS-REGISTER.md:286`) — the store-readiness checklist lost v1's `href` and
`doc` fields in the port, so every check names a remedy in prose and links to nothing.

- v1 carried `href` on 9 of 12 steps and `doc` anchors on all 12 (`ERP-rebuild` →
  `store-readiness.ts:41-53`) — **read-only, requirements not design** (RULES §3).
- v2's `ReadinessCheck` (`packages/domain/src/stores/service.ts:314`) has neither; the remedy
  survives only as the `detail` sentence.
- **The symptom to delete:** T-230 and T-229 slice 3 each hand-wired one link on the
  `/admin/stores/[id]` row for their own check. A generic renderer replaces both.

Ian's ruling (roadmap, 8 Sep evening): **DEF-216 is step one of the tutorials work either way** —
it goes first whichever way he decides the rest. It is also the cheapest item in
`docs/discovery/30-tutorials-assessment.md` §8 (there, "Option C / T-2xx a", half a day, no
migration).

## Required reading before writing the spec

- `docs/RULES.md` (all of it), then `PROJECT_BIBLE.md` §3.3 (spec format) and §9 (done)
- `docs/DEFECTS-REGISTER.md:286` — the defect row itself
- `docs/discovery/30-tutorials-assessment.md` §1.2, §5 Option C, §8, §9 item 1
- `PROJECT_BIBLE.md` §13 row 176 and §4.2 rule 7 — readiness is **derived on read**; a stored
  readiness flag is the defect this project forbids. `href` must not become stored state.
