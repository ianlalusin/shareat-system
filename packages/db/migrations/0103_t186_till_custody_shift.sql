-- T-186 — the till custody shift, and what was physically counted.
-- docs/tasks/186-till-custody-shift.md
--
-- Makes T-143's stated premise true: "once the till is counted daily and signed, a batch shortage
-- cannot be a counting error." There was nowhere to record a count until this migration.
--
-- Hand-written, per DEF-073. Never edited after apply.

CREATE TABLE "till_custody_shifts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "store_id" uuid NOT NULL REFERENCES "stores"("id") ON DELETE restrict,
  "business_date" date NOT NULL,
  "shift_no" integer NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- NOT NULL is the point of the table. v1's equivalent is a nullable free-text name.
  "opened_by" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "closed_at" timestamp with time zone,
  "closed_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "prev_shift_id" uuid REFERENCES "till_custody_shifts"("id") ON DELETE restrict,
  -- A REFERENCE to attendance, never a restatement of it. No clock times of its own.
  "attendance_day_id" uuid REFERENCES "attendance_days"("id") ON DELETE restrict,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "till_custody_shifts_shift_no_check" CHECK ("shift_no" >= 1),
  CONSTRAINT "till_custody_shifts_status_check"
    CHECK ("status" in ('open', 'closed', 'voided')),
  CONSTRAINT "till_custody_shifts_close_shape_check"
    CHECK (("status" = 'open') = ("closed_at" is null and "closed_by" is null)),
  CONSTRAINT "till_custody_shifts_prev_not_self_check"
    CHECK ("prev_shift_id" is distinct from "id")
);

CREATE UNIQUE INDEX "till_custody_shifts_store_date_no_unique"
  ON "till_custody_shifts" ("store_id", "business_date", "shift_no");
CREATE INDEX "till_custody_shifts_org_status_idx"
  ON "till_custody_shifts" ("org_id", "status");
CREATE INDEX "till_custody_shifts_store_date_idx"
  ON "till_custody_shifts" ("store_id", "business_date");

-- At most one OPEN shift per store. Two open shifts on one till means two people each believe
-- they hold the same cash, and the second count is taken against a balance the first is moving.
CREATE UNIQUE INDEX "till_custody_shifts_one_open_per_store"
  ON "till_custody_shifts" ("store_id") WHERE "status" = 'open';

-- One shift hands over to at most one successor. A branching chain would let the same cash be
-- inherited twice, by two people, both of whom could then be charged for it.
CREATE UNIQUE INDEX "till_custody_shifts_prev_unique"
  ON "till_custody_shifts" ("prev_shift_id");

CREATE TABLE "till_count_lines" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "shift_id" uuid NOT NULL REFERENCES "till_custody_shifts"("id") ON DELETE restrict,
  "moment" text NOT NULL,
  "money_account_id" uuid NOT NULL REFERENCES "money_accounts"("id") ON DELETE restrict,
  "counted" numeric(14, 2) NOT NULL,
  -- STORED, deliberately. balanceOf has no asOf, and entries can be backdated: re-deriving this
  -- later would silently rewrite a variance somebody was already charged for.
  "expected" numeric(14, 2) NOT NULL,
  "counted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "counted_by" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "notes" text,
  CONSTRAINT "till_count_lines_moment_check" CHECK ("moment" in ('open', 'close')),
  CONSTRAINT "till_count_lines_counted_nonnegative_check" CHECK ("counted" >= 0)
);

CREATE UNIQUE INDEX "till_count_lines_shift_moment_account_unique"
  ON "till_count_lines" ("shift_id", "moment", "money_account_id");
CREATE INDEX "till_count_lines_shift_idx" ON "till_count_lines" ("shift_id");

-- ---------------------------------------------------------------------------------------------
-- RLS. `till_custody_shifts` is org_column; `till_count_lines` is DERIVED via its parent shift,
-- exactly as remittance_lines is — it has no org_id of its own, so scoping it through the parent
-- is what stops the two ever disagreeing about which org they belong to.
--
-- A franchise reading another org's shifts would learn which of its neighbours is short, and who
-- is being asked for it.
ALTER TABLE "till_custody_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "till_custody_shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "till_custody_shifts_org_isolation" ON "till_custody_shifts" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

ALTER TABLE "till_count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "till_count_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "till_count_lines_org_isolation" ON "till_count_lines" FOR ALL
	USING (exists (select 1 from till_custody_shifts s where s.id = till_count_lines.shift_id and s.org_id = app_current_org()))
	WITH CHECK (exists (select 1 from till_custody_shifts s where s.id = till_count_lines.shift_id and s.org_id = app_current_org()));
