# ERP phone tables — bounded assessment, 2026-10-21

**Verdict: build one shared progressive enhancement of the existing semantic tables.** Ian approved
cards below 768px and tables at 768px and above; the missing phone presentation is observable in
106 native table definitions (AST-counted, excluding comments), plus six shared-table call sites,
across 83 ERP source files. Visit counts are unavailable; no production data read is needed to change
presentation. Keeping horizontal tables alone does not meet his request.

The existing Table kit and raw route tables already own correct links, money formatting and forms.
Two existing card/table pairs (access defaults and unpaid liabilities) use 640px; align them to 768px.
Read-only searches of ERP-rebuild, POS, CUSTOMER and Shareat Website found no reusable table stacking
implementation in their table components. Their business logic and data remain outside this change.

[WAI table guidance](https://www.w3.org/WAI/tutorials/tables/) requires retained header relationships;
the design keeps the original table, row and cell nodes and adds explicit native roles where needed.
[Tablesaw](https://github.com/filamentgroup/tablesaw) (MIT, archived) demonstrates stacked labeled cells;
do not adopt its runtime or duplicate rows. A small DOM adapter handles streamed and client-updated rows.
Use [Happy DOM](https://github.com/capricorn86/happy-dom) (MIT) only as a development test dependency
for actual DOM identity, form values and mutation tests; it cannot prove browser layout.

Scope: one shell adapter, one CSS card presentation, explicit labels for five headerless tables,
two breakpoint corrections, an inventory and affected tests. Zero database changes or runtime packages.
No mounted copies of controls, additional requests, hidden money, row removal or payment logic. Print remains tabular.
Before hydration or with JavaScript disabled, the original scrollable table remains the usable fallback.
