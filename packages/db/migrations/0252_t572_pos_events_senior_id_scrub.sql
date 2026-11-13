-- 0252 - T-572 / DEF-823 (senior and PWD card numbers and names never stored in the POS device log): redact the rows written before the inbox started scrubbing. docs/tasks/572-pos-events-senior-id-scrub.md R5; bible row 353; hand-authored per ADR-012 s5.
-- Journal idx 252 (0249-0251 are reserved by other lanes and not on main yet; a gap is legitimate, ADR-012 s5 step 1), `when` = 0248's + 4 x 86400000 (the one-day-per-index grid).
--
-- WHY. `sale.completed` carries seniors[{dinerNo, kind, idNumber, holderName}]. The inbox stored that payload as sent, so every card number and name sat in plain text in pos_events.payload (found by the
-- T-569 audit). From T-572 the inbox stores the marker "[redacted]" instead (scrubStatutoryHolders, inbox.ts); the BIR register statutory_discount_records is the only home of the real values.
-- This file does the same to the rows already there, so a tablet that resends an old event after this migration still dedupes against the same stored copy.
--
-- THE TRIGGER IS LIFTED HERE AND NOWHERE ELSE. pos_events is frozen by pos_events_frozen (0238, ENABLE ALWAYS: every column but the three resolution columns, DELETE refused). The only way to change a
-- stored payload is to switch that trigger off, and this migration is that one act: DISABLE, one UPDATE, ENABLE ALWAYS again, all in the migration's own transaction (drizzle runs a file in one), so a failure
-- anywhere leaves the trigger on and the rows untouched. No grant changes: shareat_app still has no UPDATE on payload; the app never lifts the trigger.
--
-- SHAPE. Per element: dinerNo and kind kept when they are what the event allows (a whole number; 'senior' or 'pwd'), else the marker; idNumber and holderName the marker; every other key dropped. A `seniors` that
-- is neither a list nor null becomes the marker. An empty list, a null and a payload with no `seniors` are not touched. The update is idempotent (a second run writes the same value). The test
-- t572-senior-id-scrub (case 6) compares the result with scrubStatutoryHolders() through canonicalJson; jsonb keeps keys in its own order, so byte-for-byte is the canonical form.
--
-- ERROR TEXT. pos_events.error holds a refusal's code and one fixed sentence (eventFault), or a database error code; none of them is built from a payload value (checked: sale.ts refusals say "Enter the name on the senior or PWD card."
-- and "Diner N's card does not match their discount."; the schema check names a KEY, never a value). So there is nothing to redact in `error`.
--
-- LOCK BUDGET. SET LOCAL lock_timeout = '5s' first. DISABLE/ENABLE TRIGGER take SHARE ROW EXCLUSIVE, held to the end of the transaction. One UPDATE over the sale.completed rows of a store-sized log (a few
-- thousand rows, filtered by kind and seniors; the table is written only by the POS inbox, which is idle while a deploy applies migrations). RLS is FORCEd on pos_events (0238) and a migration reads every
-- organisation, so row_security is off for the statement and back on after, as 0241, 0245 and 0248 did. No backfill beyond this.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "pos_events" DISABLE TRIGGER "pos_events_frozen";
--> statement-breakpoint
SET LOCAL row_security = off;
--> statement-breakpoint
UPDATE "pos_events" SET "payload" = jsonb_set(
  "payload",
  '{seniors}',
  CASE
    WHEN jsonb_typeof("payload"->'seniors') = 'array' THEN COALESCE(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'dinerNo', CASE WHEN jsonb_typeof(t.s->'dinerNo') = 'number' AND (t.s->>'dinerNo') ~ '^-?[0-9]+$' THEN t.s->'dinerNo' ELSE '"[redacted]"'::jsonb END,
           'kind', CASE WHEN t.s->'kind' IN ('"senior"'::jsonb, '"pwd"'::jsonb) THEN t.s->'kind' ELSE '"[redacted]"'::jsonb END,
           'idNumber', '"[redacted]"'::jsonb,
           'holderName', '"[redacted]"'::jsonb)
         ORDER BY t.ord)
       FROM jsonb_array_elements("payload"->'seniors') WITH ORDINALITY AS t(s, ord)),
      '[]'::jsonb)
    ELSE '"[redacted]"'::jsonb
  END)
WHERE "kind" = 'sale.completed'
  AND "payload" ? 'seniors'
  AND jsonb_typeof("payload"->'seniors') <> 'null'
  AND NOT ("payload"->'seniors' = '[]'::jsonb);
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
ALTER TABLE "pos_events" ENABLE ALWAYS TRIGGER "pos_events_frozen";
