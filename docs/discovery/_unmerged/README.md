# Unmerged drafts — not authoritative

A background fork of the financial capability inventory overwrote
`13-capabilities-financial.md` **after** the parent agent had audited, extended and
delivered it. Its draft is preserved here rather than discarded, because neither version
strictly dominates:

| | Canonical (`13-capabilities-financial.md`) | This draft |
|---|---|---|
| Capability rows | 136 | **171** |
| Statements / reconciliation / migration section | **yes (§G)** | folded into admin tooling |
| Channel settlement | **own section** | folded into AR |
| Audited | **yes** — parent cross-checked it against three independent forks | no |
| Author self-reported confusion mid-run | — | **yes** |

**The canonical file wins** because it was audited and integrated. But this draft carries
~35 capability rows the canonical one may not, and those are worth harvesting before this
directory is deleted.

**To reconcile:** diff the two "Capabilities with no home in the plan" sections. Anything
present here and absent there is a candidate gap that has not been counted yet — and the
gap list is what drives the 15 November go/no-go in ADR-005.
