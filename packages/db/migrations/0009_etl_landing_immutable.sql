-- 0009 — DEF-041: make the ETL landing table immutable in the DATABASE, not just in the
-- framework.
--
-- This closes a hole in the T-112 SPEC, not in its implementation. The spec's invariant 5
-- read "the framework never UPDATEs or DELETEs a landed row" — a statement about our own
-- code's behaviour, which the implementation satisfied exactly and proved with a test. But
-- bible §15 and docs/RULES.md §6.3 are explicit that the DATABASE enforces the rules, and
-- a rule phrased as "our code does not do X" is a convention, not a constraint. Verified
-- empirically before writing this: a plain UPDATE rewrote a landed payload from 100 to
-- 999999, and a plain DELETE removed the row. Neither raised anything.
--
-- Why it matters more here than the phrasing suggested. The whole "land before you
-- convert" argument (docs/tasks/112-etl-framework.md, the section that decides the
-- pipeline shape) rests on ONE claim: the bytes we analysed in September are the same
-- bytes we load in December, so any difference in output is necessarily a difference in
-- our code rather than in the source. A landed payload that can be silently rewritten
-- destroys exactly that claim, and destroys it WITHOUT A SIGNAL — the reconciliation still
-- balances, every count still ties, and the audit report is quietly answering a question
-- about data that no longer exists.
--
-- This is the same class of defect as DEF-031 (the posted-entry INSERT hole) and gets the
-- same treatment for the same reason. INSERT stays open — landing is append-only, so a
-- changed source document is expected to arrive as a NEW row alongside the old one, which
-- is the design, not a violation of it.
--
-- Deliberately NOT exempted for anyone. There is no admin path, no GUC escape hatch of the
-- kind 0005 gave reversals, because unlike a reversal there is no legitimate operation
-- that needs to rewrite history here: a source document that changed is re-landed, never
-- edited. If a landed row ever genuinely must go, that is a schema migration written and
-- reviewed on purpose, not a stray UPDATE.
--
-- 0000-0008 are already applied and are therefore never edited (bible §2 rule 8).
CREATE FUNCTION "etl_source_documents_check_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION
		'etl_source_documents is append-only: % on a landed document is not permitted (doc_path=%). A source document that changed is RE-LANDED as a new row, never edited — rewriting a landed payload silently destroys the reproducibility the whole capture-then-convert pipeline depends on. See DEF-041.',
		TG_OP, COALESCE(OLD.doc_path, '?')
		USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "etl_source_documents_immutable"
BEFORE UPDATE OR DELETE ON "etl_source_documents"
FOR EACH ROW EXECUTE FUNCTION "etl_source_documents_check_immutable"();
