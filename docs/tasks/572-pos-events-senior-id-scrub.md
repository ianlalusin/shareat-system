# T-572 / DEF-823 — Senior and PWD IDs never stored in the POS device log

> Written in plan mode by the POS design lane (Opus planner), 12 Nov 2026. Lands as `docs/tasks/572-pos-events-senior-id-scrub.md`.
> **Authority:**
> - BOSS 12 Nov rulings 1–4;
> - bible row 353 (senior and PWD ID numbers are never logged);
> - DEF-823, found by the T-569 audit.
> **Migration:** `0252` (reserved on BOARD.md). It is hand-authored per ADR-012 §5, and its journal `when` = the previous entry + 86400000.
> **Order:** build AFTER T-563 merges, because T-563 rewrites `inbox.ts`. Same files, so no parallel build.
> **Builder:** Sonnet. **Auditor:** Sonnet (personal data plus migration). Full suite on a fresh gate DB, because it is a migration.

## Context

`sale.completed` carries `seniors[{dinerNo, kind, idNumber, holderName}]` (`packages/domain/src/pos/inbox.ts:154`). The inbox stores the payload after `scrub()` (inbox.ts:174), which strips only `/pin/i` keys. So every senior or PWD ID number and name sits in plain text in `pos_events.payload`.

The legitimate home of those values is `statutory_discount_records` (`packages/db/schema/statutory-discounts.ts:83`), which `completeSale` writes for the BIR record. The device log needs neither value.

## Design

**R1 — Scrub at insert, with an allowlist (BOSS 1).** In `scrub()`, for a `sale.completed` payload, each `seniors[]` element is rebuilt from an **allowlist**:
- `{ dinerNo, kind }` are kept as given;
- the ID and name are replaced by the fixed markers `idNumber: "[redacted]"` and `holderName: "[redacted]"`;
- **any other key in the element is dropped.**

The marker is a constant, not a hash: an ID is short enough that a hash could be brute-forced back to it. The shape stays valid JSON, so nothing that reads the log as data breaks.
- Put the rule in one exported function, `scrubStatutoryHolders(payload)`, next to `scrub` and called from it.
- Update the doc comment on `scrub()` to say both rules.

**R2 — The handler still gets the real values.** Only the STORED copy is scrubbed. `applyOne` already runs the handler on the unscrubbed `e.payload` and stores `scrubbed.value`, so `completeSale` still writes `statutory_discount_records` with the real ID. The builder confirms this, and a test pins it.

**R3 — Resend dedupe (BOSS 3).** `classifyExisting` already compares `canonicalJson(row.payload)` with the scrubbed `stored` value, so a resend dedupes as long as the scrub is deterministic. Two required tests:
- a resent identical sale is a `duplicate`;
- a resend that differs only in `idNumber` is also a `duplicate`, because both scrub to the same marker. That is accepted: the ID is not a field the log may compare.

**R4 — Replay of a quarantined senior sale.** `replayQuarantinedEvent` (inbox.ts:439) re-runs the STORED payload, which now holds the markers. That would write `[redacted]` as a BIR ID.
- Rule: replaying a quarantined `sale.completed` whose stored `seniors[]` is non-empty is **refused** with the sentence: "This sale had a senior or PWD discount. Its ID numbers are not kept in the device log, so it cannot be replayed. Discard it and ring the sale again."
- A sale with no seniors replays as today.
- `assertFieldRules` must never accept the marker as an ID. Add a test that the marker fails `POS_STATUTORY_HOLDER_RULES`.

**R5 — Redact existing rows (BOSS 2), migration 0252.** Rows are frozen by the trigger `pos_events_frozen` (0238:926, `pos_v2_frozen_except_once`, ENABLE ALWAYS). So, in one transaction:
1. `ALTER TABLE pos_events DISABLE TRIGGER pos_events_frozen;`
2. Run an `UPDATE pos_events SET payload = jsonb_set(payload, '{seniors}', (SELECT jsonb_agg(jsonb_build_object('dinerNo', s->'dinerNo', 'kind', s->'kind', 'idNumber', '"[redacted]"'::jsonb, 'holderName', '"[redacted]"'::jsonb) ORDER BY ord) FROM jsonb_array_elements(payload->'seniors') WITH ORDINALITY AS t(s, ord))) WHERE kind = 'sale.completed' AND jsonb_typeof(payload->'seniors') = 'array' AND jsonb_array_length(payload->'seniors') > 0;`
   - the builder checks this produces **byte-for-byte what `scrub()` produces**, including key order after `canonicalJson`;
   - so a device resending an old event after the migration still dedupes.
3. `ALTER TABLE pos_events ENABLE ALWAYS TRIGGER pos_events_frozen;`

Other rules for the migration:
- No grants change. The header explains why the trigger is lifted, and that it is lifted only inside this migration.
- Also check `error` (the quarantine text) for any ID that a refusal message echoed. If a message ever includes the holder fields, redact it the same way, and say so in the hand-back.

**R6 — Belt and braces.** T-569's export redaction stays (defence in depth). Bible row 353 gains a note: "enforced at insert in the POS device log (T-572, DEF-823)".

## Out of scope

| Out | Why |
|---|---|
| Lobby `idNumber` (`lobby.ts:206`) | That is a separate surface with its own rules; not in DEF-823 |
| Hashing IDs to keep a dedupe key | A hash of a short ID can be reversed by trying every ID. The marker is enough (R3) |
| Changing what `statutory_discount_records` stores | The BIR record legitimately keeps the ID |

## Tests (red first)

1. **BOSS 4:** insert a sale.completed with 2 seniors through the real inbox. No stored payload anywhere contains the plain `idNumber` or `holderName` text. Check every `pos_events.payload` and `error` as text.
2. The allowlist: an extra key in a seniors element (e.g. `birthday`) is dropped.
3. R2: `statutory_discount_records` still has the real ID after the scrubbed insert.
4. R3: an identical resend is a duplicate; a resend with a different ID is also a duplicate.
5. R4: replaying a quarantined senior sale is refused with the sentence; replaying a sale with no seniors works; the marker fails the holder rules.
6. Migration: seed a raw pre-0252 row (insert with the trigger lifted in the test), run 0252, and the payload equals `scrub()`'s output. The trigger is still enabled afterwards (an UPDATE is refused 23001).
7. Mutant: drop the allowlist (keep every key) → test 2 goes red.

## Verification

- Typecheck.
- Unit tests.
- Integration t525-inbox, t524, t563, the new t572 file, and the migration-journal tests.
- The **full suite on a fresh gate DB**, run by BOSS via CI, because this is a migration that lifts a trigger.
- Census: there is no audit action, so no ceiling change.
