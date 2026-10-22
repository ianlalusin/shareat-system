# T-456 — DEF-722: append an offline dish without an existence read
Status: implemented and Android demo restart/reconnect verified; release/postcommit gates pending 22 October.
Specified 21 October after T-455 Android reproduction; within authorized POS hardening.
Goal: a cashier can add the first dish offline without overwriting an unseen existing bill line.
Pattern: append a fresh line per offline add intent. Online transaction grouping remains as it is.
Each offline add receives a generated document id, writes its own quantity/modifiers/note/defaults, and uses
the same id in kitchen tickets and optimistic display. Two offline adds are two lines, not a destructive merge.
Never catch unavailable/permission errors and interpret them as absence. No read-before-create is needed.
Keep the line, kitchen writes and billingRevision increment in the existing one batch; commit local-first.
No changes to billing arithmetic, authorization, payment ledger, receipt numbering or shared-auth design.
Scope: apps/pos/src/lib/offline/addon-line.ts and addon-line.test.ts;
apps/pos/src/components/shared/AddonsPOSModal.tsx; apps/pos/V1-COPY.md;
docs/discovery/pos-offline-addon-absence.md; this task; docs/reviews/t456-offline-first-addon.md;
docs/DEFECTS-REGISTER.md (DEF-722) and T-455 report/status evidence only.
Tests first: uncached reads throw; staging still writes a fresh line; unseen grouped line and its discounts
stay unchanged; consecutive adds differ; modifiers/notes/quantities survive; wiring retains returned id in tickets.
Then Android demo APK: cached Test dish, disconnect, add twice, force-stop/reopen, reconnect; inspect local
emulator docs for exactly two new lines with correct quantities/price and no reset of an existing line.
Run affected/full POS tests, typecheck, emulator build, source restoration and postcommit guards/census.
Paid-sale/terminal/server approval/real printer/24h soak gates stay open until actually exercised.
