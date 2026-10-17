-- 0207 - T-438 (bible row 360): a person's name is last / first / middle; display_name is derived "Last, First M.".
-- docs/tasks/438-hire-name-parts-and-staff-pin-only.md, Rulings N1-N3 and "Migration 0207".
-- Existing rows keep display_name and get NULL parts (N3): no backfill, no data step, safe on production.
-- display_name stays a plain column written by the domain; this CHECK refuses any row whose parts and display_name disagree.
ALTER TABLE "persons" ADD COLUMN "last_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "first_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "middle_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_name_parts_check" CHECK (
  (last_name IS NULL AND first_name IS NULL AND middle_name IS NULL)
  OR (
    last_name IS NOT NULL AND first_name IS NOT NULL
    AND last_name <> '' AND first_name <> ''
    AND last_name = btrim(last_name) AND first_name = btrim(first_name)
    AND (middle_name IS NULL OR (middle_name <> '' AND middle_name = btrim(middle_name)))
    AND kind = 'person'
    AND display_name = last_name || ', ' || first_name
        || coalesce(' ' || upper(left(middle_name, 1)) || '.', '')
  )
);
