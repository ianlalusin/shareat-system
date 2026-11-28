-- 0292 - T-653: one flavour list; each package and each refill ticks the flavours it allows. Spec: T-653 (C:\shareat\specs\653-package-refill-flavours.md); hand-authored per ADR-012 s5.
-- Journal idx 292, `when` = 0289's (T-649, 1811043107084) + 3 x 86400000 = 1811302307084. 0290 and 0291 are T-650's (S2, S3); gaps are legitimate (T-154), and this file sorts above both.
--
-- WHY. Ian, 28 Nov 2026: "add select all button for refills and flavor for this package ... again package must be able to be attached with allowed refills and allowed flavor.
-- refill must also have the allowed flavors too". Today a flavour is a value in an option group, and min/max live on the GROUP, so Ian had to build a separate "Flavours" group for every
-- package and every refill and retype the names; a package (pick 1 to 3) and a refill (pick exactly 1) could not share one list; and no subset per item was possible.
--
-- WHAT IT ADDS.
--   menu_option_groups.role text NOT NULL DEFAULT 'choice'  CHECK in ('choice','flavours'); at most ONE active 'flavours' group per organisation (partial unique index).
--       Every existing group is a 'choice' group, so nothing changes on deploy. No backfill: the org creates its flavour list from the new Menu > Flavours screen.
--   menu_option_group_links.min_selections / max_selections  NULL = use the group's own (today's behaviour); a number overrides it for THIS link (a package picks 1 to 3, a refill exactly 1).
--       CHECKs: min >= 0, max >= 1, max >= min when both are set. (A single override is judged against the group's other bound by the domain.)
--   menu_option_link_values (org_id, link_id, option_group_id, option_value_id)  PK (link_id, option_value_id). A link with NO rows allows every active value of its group
--       (today's behaviour); a link WITH rows allows only those. A value that is not in the link's group is refused BY THE DATABASE: two composite FKs share option_group_id,
--       (link_id, option_group_id) -> menu_option_group_links(id, option_group_id) and (option_value_id, option_group_id) -> menu_option_values(id, option_group_id), so the link's group and the
--       value's group must be the same one. Same-org twins as every menu table: (org_id, link_id) and (org_id, option_value_id). Cascade on link delete; the value is RESTRICT (a value is retired, never deleted).
--       Needs UNIQUE (org_id, id) and UNIQUE (id, option_group_id) on menu_option_group_links, and UNIQUE (id, option_group_id) on menu_option_values: added here (hand-added; see schema/menu.ts).
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT, DELETE on menu_option_link_values (setting the allowed set replaces it); no UPDATE (a row is a pair). menu_option_groups keeps its table-level
-- UPDATE (role is written only at insert, never updated). menu_option_group_links was SELECT, INSERT, DELETE: it gains a COLUMN-level UPDATE (min_selections, max_selections), the only two columns a link may change.
-- RLS ENABLE + FORCE + one org_isolation policy.
-- LOCK BUDGET. lock_timeout 5s first; one ADD COLUMN with a constant default (metadata only), two nullable ADD COLUMNs, one new empty table, the CHECKs and UNIQUEs on three small menu tables.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "menu_option_groups" ADD COLUMN "role" text DEFAULT 'choice' NOT NULL;
--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_role_check" CHECK ("role" IN ('choice', 'flavours'));
--> statement-breakpoint
CREATE UNIQUE INDEX "menu_option_groups_one_flavours_per_org_key" ON "menu_option_groups" ("org_id") WHERE "role" = 'flavours' AND "status" = 'active';
--> statement-breakpoint

ALTER TABLE "menu_option_group_links" ADD COLUMN "min_selections" integer;
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD COLUMN "max_selections" integer;
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_min_check" CHECK ("min_selections" IS NULL OR "min_selections" >= 0);
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_max_check" CHECK ("max_selections" IS NULL OR "max_selections" >= 1);
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_max_min_check" CHECK ("min_selections" IS NULL OR "max_selections" IS NULL OR "max_selections" >= "min_selections");
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_id_group_unique" UNIQUE ("id", "option_group_id");
--> statement-breakpoint
ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_id_group_unique" UNIQUE ("id", "option_group_id");
--> statement-breakpoint

CREATE TABLE "menu_option_link_values" (
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"option_group_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_option_link_values_pkey" PRIMARY KEY ("link_id", "option_value_id")
);
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ADD CONSTRAINT "menu_option_link_values_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ADD CONSTRAINT "menu_option_link_values_link_same_org_fk"
	FOREIGN KEY ("org_id", "link_id") REFERENCES "menu_option_group_links"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ADD CONSTRAINT "menu_option_link_values_value_same_org_fk"
	FOREIGN KEY ("org_id", "option_value_id") REFERENCES "menu_option_values"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ADD CONSTRAINT "menu_option_link_values_link_group_fk"
	FOREIGN KEY ("link_id", "option_group_id") REFERENCES "menu_option_group_links"("id", "option_group_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ADD CONSTRAINT "menu_option_link_values_value_group_fk"
	FOREIGN KEY ("option_value_id", "option_group_id") REFERENCES "menu_option_values"("id", "option_group_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "menu_option_link_values_value_idx" ON "menu_option_link_values" ("option_value_id");
--> statement-breakpoint
CREATE INDEX "menu_option_link_values_org_idx" ON "menu_option_link_values" ("org_id");
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "menu_option_link_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "menu_option_link_values_org_isolation" ON "menu_option_link_values" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_option_link_values" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("min_selections", "max_selections") ON "menu_option_group_links" TO "shareat_app";
