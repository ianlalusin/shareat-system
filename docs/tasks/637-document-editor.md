# T-637: document templates in a proper editor: formatting, fill-in field tags, letterhead, exact A4 preview

**Owner:** builder (Sonnet). Auditor: Sonnet (security of stored content + migration). **Spec:** BOSS (Opus), 25 Nov 2026. **MIGRATION 0281** (reserved).

**Ian, 25 Nov 2026:**
- "allow the creator of template to set changing values like {Employee full name} to insert the value when document is generated".
- Suggested fields: employee full name, store name, employee email, contact number, store email, contact number, address, employee address.
- "allowing the template to be formatted, bold, alignment, font style and size etc and preview before saving template so when document is generated its print or pdf ready".
- "when {{ is typed list all available fields as suggestion".
- Chose option **B** (a proper document editor).

## Today (facts, origin/main)

- T-584 documents: `document_templates` / `document_template_versions.body` (text ≤ 50,000) and `issued_document_versions.body` (text) in packages/db/schema/documents.ts.
- `packages/domain/src/documents/merge-fields.ts`:
  - a fixed whitelist `MERGE_FIELDS`
  - `{{name}}` syntax; an unknown field is refused at save; a missing value renders `[missing: x]` and blocks issuing
  - a tiny PLAIN markup (blank line = paragraph, `# ` heading, `**bold**`)
  - `parseBody` returns data and the screens render React text nodes, with no `dangerouslySetInnerHTML`. **Keep that guarantee.**
- Screens: /documents/templates (editor), /documents/new (issue), /documents/[id] and /documents/[id]/print.
- Live: Lipa's Certificate of Employment uses `[EMPLOYEE FULL NAME]` brackets, so they are not filled.
- /documents/new shows a duplicate hand-written crumb ("Documents / Issue") under the T-630 breadcrumb. Remove it.

## Rule

1. **Editor:** a free, open-source rich-text editor that stores a JSON document (recommended: TipTap/ProseMirror core + mention/suggestion, MIT; or Lexical, MIT).
   - Check the licence of every package you add; no paid "Pro" extensions.
   - Pin exact versions at least 2 weeks old. Add no CDN; use npm deps.
   - **Stored content is JSON, never HTML.** A strict whitelist schema (node and mark types below) is validated on the SERVER at save, and anything else is refused.
   - Rendering for preview, print and issue goes through OUR renderer to React elements, never innerHTML, so a template can't inject script or style.
2. **Allowed formatting:**
   - paragraphs and headings (3 sizes)
   - bold, italic, underline
   - alignment: left, centre, right, justify
   - font family from a fixed list of 3 (one serif, one sans, one mono; use web fonts already in the app if possible)
   - font size from a fixed list (e.g. 10, 11, 12, 14, 16, 20, 24 pt)
   - line spacing 1.0 / 1.15 / 1.5 / 2.0
   - bullet and numbered lists
   - simple tables (rows × columns, no merged cells)
   - a horizontal rule and a page break
   - **Not allowed:** colours, images inside the body, links.
3. **Fill-in field tags:** a field is an inline, non-editable TAG node (`field`, attr `name` from the whitelist), shown as a grey chip with its plain label ("Employee full name").
   - Typing `{{` opens a suggestion list of every field, filtered as you type, showing the label plus a sample value; Enter or tap inserts the tag.
   - An "Insert field" menu next to the toolbar does the same.
   - An unknown name is refused at save; a missing value at issue keeps today's `[missing: …]` block-before-issue behaviour.
4. **Fields:** keep today's 15 and add those whose data is really stored. Check each; leave out any with no source, and list them in the report:
   - employee: `first_name`, `last_name`, `email`, `phone`, `address`, `birth_date`, `length_of_service` ("2 years, 3 months" as of today or ended_on)
   - store: `email`, `phone` (stores.ts:125 has ONE contact number), `city`, `province`
   - org: `address`, `email`, `phone`
   - issuer: `title`
   - Person email and phone live in `person_identities` (kind email/phone); pick the primary one deterministically.
   - Each field has a plain label and a sample value for the picker.
   - No salary and no government ID numbers.
5. **Letterhead:** per template, an optional header of the company logo (the org logo already stored, if any; otherwise none) plus a header block that is itself editor content (it may hold fields). Also an optional footer. Page size A4, with margins set per template (fixed choices: narrow / normal / wide).
6. **Preview:** the template editor has a "Preview" toggle showing the EXACT A4 page, using sample values (and a chosen employee if picked) through the same renderer and print CSS as /documents/[id]/print.
   - "Print" and "Save as PDF" from the browser give the same page: @page A4, margins, page breaks honoured, no app chrome.
   - Server-side PDF generation is out of scope.
7. **Storage and migration (0281):**
   - `document_template_versions` and `issued_document_versions` gain `body_doc jsonb`, plus page settings (margins, header/footer docs) on the template version.
   - Existing rows are converted in the migration or a one-off converter from the plain markup to the JSON doc (paragraphs, `# ` → heading, `**bold**` → bold mark, `{{x}}` → field node), keeping the old `body` text column for history. Issued documents are immutable and keep their stored content: render old ones from `body` and new ones from `body_doc`.
   - **Square-bracket warning:** saving a template that contains `[SOMETHING IN CAPS]` text shows a warning ("This looks like a fill-in placeholder; use Insert field") without blocking.
8. **Capabilities and audit:** unchanged (the T-584 ones); authorize first.

## Not in this task

- Server PDF files.
- Emailing documents.
- Colours, images in the body, links.
- Salary or government ID fields.
- Changing signature slots.

## Tests (each with a mutant that goes red)

1. The server refuses a stored doc with a non-whitelisted node or mark (e.g. a `script`, `iframe` or `image` node, a `color` mark, an `href` attr).
2. The renderer never emits raw HTML: rendering a doc with a text node `<script>` shows the literal text.
3. Conversion of the old markup → doc keeps paragraphs, headings, bold and fields.
4. A field tag resolves to the value; a missing value blocks issue as today; an unknown field is refused at save.
5. Each new field's resolver (email/phone primary pick, length of service months maths, the store city/province source).
6. The `{{` suggestion lists all fields and filters by prefix (a component test).
7. Print view: A4 @page rule present, header/footer rendered, page break node → CSS page break.
8. The square-bracket warning appears and does not block.

Run census:write (touch targets, t450, row links, live-check, editable-record guards). Invoke `impeccable` for the editor and the preview. Do a browser check at desktop and 390px if RAM allows.

## Addition (Ian, 25 Nov 2026): document kinds are a list Ian edits

Ian's words: "lets add another template kind which is Explanation Letter or Incident Report actually i suggest kind can be added by me."

Today `DOCUMENT_KINDS = ['coe','memo','nte','contract','other']` is a hard-coded enum (schema/documents.ts:24). It is used as a label, the list filter on /documents, the template form select, the letterhead snapshot `templateKind`, and the domain check templates.ts:73. Check whether the document NUMBER or anything else branches on the kind, and keep that behaviour.

**Rule, folded into MIGRATION 0281:**
- New org table `document_kinds`: name (1-40, unique per org case-insensitively), optional short code for numbering if numbering uses the kind, sort, status active/retired, audit.
- Edited on screen in a "Document kinds" section on /documents/templates: add / rename / retire. Retire is refused while an ACTIVE template uses the kind; issued documents keep the name they were issued with (the letterhead snapshot already copies it).
- Capability: the same one that manages templates; authorize first.
- Seeded for every org, replacing the enum values with readable names: Certificate of employment, Memo, Notice to explain, Contract, Other, **Explanation letter**, **Incident report**.
- `document_templates.kind` becomes `kind_id` (same-org FK, NOT NULL), backfilled from the old enum value.
- The /documents filter and the template form read the list.
- Tests (each with a mutant): backfill maps every old kind; a new kind is usable in a template; retire is refused while a template uses it; a cashier is refused editing kinds.
- No hard-coded kind names may remain in code paths (STANDING: no hard-coded business settings).
