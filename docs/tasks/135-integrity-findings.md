# T-135 — Integrity findings (OIL): port what v1 got right, close the one gap

> **Status:** design 2026-08-25. **Research-first this time** — read `ERP-rebuild/src/types/integrity.ts`
> before designing, and it changed the design.
> **Unifies with:** ADR-006 §8's close-readiness checker — they are the same machine.

## What v1 actually has, and it is good

I assumed "AI insights" meant AI-generated findings. **Wrong** — `src/types/integrity.ts:1-3`
says it plainly:

> *"Daily Insights — Open Items & Lapses (OIL). **Deterministic** integrity findings surfaced over
> existing operational/financial records. **Pure observation layer — never touches the GL.**"*

**Deterministic and read-only.** Both of those are correct decisions and both carry forward
unchanged. The AI in v1's insights sits elsewhere (the narrative briefing); the findings themselves
are rules.

### The parts worth porting as-is

| | Why it is right |
|---|---|
| **17 typed `FindingKind`s**, delivered in waves | A closed union, not free text. Each kind is a rule someone can read |
| `severity: 'watch' \| 'alert'` | Two levels. Not five — nobody calibrates five |
| `state: 'open' \| 'snoozed' \| 'resolved'` | A finding is a workflow item, not a log line |
| ⭐ **`hardAlert`** — *"past the high-water mark, alerts even when snoozed"* | **Snooze has a CEILING.** This closes the classic escape hatch where everything is snoozed forever. Genuinely good design |
| `amount` — the money at stake | Lets a list sort by what matters instead of by date |
| `drillTo` — a route to the source record | A finding you cannot act on from is a complaint |
| **Per-store thresholds, but *"defaults live in code so a misconfig can't disable detection"*** | Configuration that cannot switch the control off. Exactly right |
| **Materiality** (`orphanExpenseMaterialityPesos`) | A ₱50 receipt and a ₱50,000 one are not the same finding |

**This is the second time research has found v1 already at the correct shape** (discovery 20 was
the first). **Port it. Do not redesign it.**

---

## ⚠️ The one gap: a RESOLVED finding whose condition still holds stays hidden

v1 recomputes the daily slice, but `state` is stored per finding key. So:

1. A manager resolves *"expense missing category"*.
2. Tomorrow's recompute produces the same key, reads the stored `resolved`, and suppresses it.
3. **The expense still has no category.**

**Resolution suppresses the SYMPTOM without requiring the CAUSE to be fixed** — and the longer it
stays resolved, the more confident the suppression looks. `hardAlert` rescues *snoozed* findings
this way, but not resolved ones.

### The fix: the finding is DERIVED; only the ACKNOWLEDGEMENT is stored

| Condition holds? | Acknowledged? | Shows as |
|---|---|---|
| Yes | No | **Open** |
| Yes | Yes | **Acknowledged** — suppressed from the attention list, **still counted**, and the acknowledgement ages |
| No | — | **Gone.** The acknowledgement becomes history |

> **A finding cannot be "resolved" while it is still true.** The only way to clear it is to fix the
> thing. Acknowledgement says *"I have seen this and accept it for now"* — which is a real and
> useful statement, and a different one from *"this is fixed."*

**This is the same principle as everything else in this project:** derived, not maintained. v1
stores a flag that can disagree with reality; v2 recomputes and cannot.

---

## What v2 can detect that v1 cannot

The ledger has real invariants now, so these become **findings rather than hopes**:

| | |
|---|---|
| `trialBalanceDoesNotTie` | Impossible per-entry, but assert it in aggregate |
| `subledgerDoesNotMatchControl` | Invariant 6, per control account, per party |
| `openingBalanceEquityNonZero` | 3900 must net to zero (ADR-005) — **a residual halts** |
| `depreciationNotBooked` | **DEF-044 is the proof this is needed.** It stopped silently for two months and only a capture found it |
| `deliveryUnexpensed` | ADR-009 — the cost basis for the stock being valued |
| `periodCloseBlocked` | The close-readiness items, as findings |

### ⭐ The close checker and the findings feed are ONE machine

ADR-006 §8's checker produces *"what is outstanding for the closing month."* That is a filtered
view of this feed, not a second system. **Building them separately would give two rule engines
that disagree** — and the disagreement would surface on the 15th.

## Accountability — port it, with one caution

v1 scores manager responsiveness (`insightScorecards`, `getManagerScorecardAction`) and logs
whether the report was even opened (`logInsightViewAction`). **That closes the loop, and a finding
nobody is accountable for is a finding nobody clears.**

> ⚠️ **But a score people are measured on is a score people manage.** The failure mode is
> resolving findings without fixing causes — which the derived model above already makes
> impossible, and that is the second reason to adopt it. **Keep the scorecard; it is safe only
> because resolution now requires the condition to actually go away.**

## Invariants

1. **Every `FindingKind` has a test that makes the condition true and proves the finding fires.**
   *A detector with no firing test is a detector nobody knows works.*
2. Every kind has a test proving it does **not** fire when the condition is absent.
3. A finding **disappears** when its condition is fixed — without anyone touching it.
4. **An acknowledged finding whose condition persists is still counted**, and its acknowledgement
   ages visibly.
5. Thresholds are per-store, but a missing or invalid config **falls back to the code default and
   never disables detection**.
6. The feed **never writes to the ledger** — assert no journal write from this module.
7. The close-readiness list is a **filter over this feed**, not a separate computation.

## Out of scope

The AI narrative briefing (a different feature) · attendance findings (Phase 4) · the PDF wrap-up ·
notification delivery.

## Open

1. **Which of the 17 kinds are Wave 1?** Suggested: the ones whose data exists — expense and
   delivery kinds now, attendance in Phase 4.
2. **Who may acknowledge?** Suggested manager for their store, admin for the org — mirroring the
   close.
3. **Does an acknowledgement expire?** Suggested yes, 30 days, then it reopens. *An accepted risk
   should be re-accepted, not forgotten.*
