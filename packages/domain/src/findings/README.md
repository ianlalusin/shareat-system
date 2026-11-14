# Findings
## Overview
Integrity findings, the standing books watchdog (T-135), plus the manager scorecard and observation log built on it. A finding is derived on every read; only an acknowledgement is stored, so a finding disappears only when its condition does.

## Interface
- `index.ts`: `ACKNOWLEDGEMENT_DAYS` (30), `SPEED_HORIZON_DAYS` (14), `WEIGHT_CLEAR_RATE` (0.4), `WEIGHT_SPEED` (0.3), `listFindings`, `listCashCustodyFindings`, `acknowledgeFinding`, `closeReadiness`, `keyPeriod`, `recordFindingObservations`, `compositeScore`, `managerScorecard`, `logFindingView`, types `FindingStatus`, `Finding`, `FindingsFeed`, `ObservationResult`, `StoreScore`, `Scorecard`.

## Invariants
- This module never writes to the ledger; every detector is a question, not a correction.
- Findings are derived, never stored; acknowledgements expire after 30 days so an accepted risk is re-accepted, not forgotten.
- A finding nags whoever can act and never blocks whoever cannot.
- `acknowledgeFinding` authorizes `close_period` (at the finding's store when it has one).
- The scorecard observes the same completed month the screen shows (reuses the month-end period helper) and shares the missed-months question so the close check and screen cannot disagree.
- The payout-interval check needs period/payout math that a repo file may not import (ADR-004), so it lives here.

## Side Effects
- Reads detectors via `findingsRepo`; writes acknowledgements, observations and view logs.
- Reads the clock (`Date.now()`, `now = new Date()` in `recordFindingObservations`) for ageing and expiry.
- Opens a transaction via `transaction(...)` for acknowledgement.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
