# Shared ERP screen defaults

Ian's standing UI rule, 2026-10-21: table, card and form styles are shared defaults for every
screen of the same kind. A page chooses meaningful fields and actions; it does not invent spacing,
breakpoints or card markup. This records the UI ruling without amending the planner-owned bible.

## Record lists
Use the existing Table / Th / Td / NumTd / LinkRow / RowLink kit. Existing native tables receive
the same global table style and phone adapter through AppShell. Tables remain tables at >=768px
and in print; phone rows use compact summary cards below 768px.

Cards: circular existing image or initials at the left, one title and one subtitle, at most two
key values on the right. Secondary read-only fields collapse under Details. Editors and actions
remain usable. No repeated title labels, copied forms or a vertical dump of every column.
Set `Table card={{ title: 'Item', subtitle: 'Kind', keys: ['Priced per'] }}` to choose hierarchy;
native tables use equivalent data-card-title / data-card-subtitle / data-card-keys attributes.
No pictures are invented; image availability does not change the layout contract.
Details uses a flat, borderless 52px button with a double-chevron SVG and no square background. Return navigation restores URL filters,
scroll positions and open sections in the same account/tab. Existing ancestor links beginning
with ←, or explicitly marked data-screen-return links, restore the last filtered list URL.

## Forms and detail screens
Reuse FormGrid, Field, FormSection, Input, Select, Textarea and the existing validation helpers.
FormGrid defaults to compact entry rows; semantic Field widths infer short units, dates and amounts,
with explicit width available for exceptions. Use layout="grid" for line items; existing wide spans
and grid-column overrides retain their grid. Names/kinds/units share a row where space permits;
buying/selling fields share a row. Long descriptions and reasons may span the available width.
Reuse SplitWorkspace / DetailLayout when a form and useful details fit side by side. Keep pages
white and simple; widths reflect content rather than stretching short values across the page.
The shared control CSS defines desktop density and touch sizing; pages must not duplicate it.
Use DisclosureCard for an optional creation form: a compact header with Add at the far right,
expanded through native details/summary. Keep the actual form mounted and validation intact.

## Reuse and checks
Extend the shared pattern when a common requirement appears. Per-page metadata is allowed;
per-page copies of responsive card/table/form CSS are not the default. Keep loading, empty,
error, focus, hover and disabled states, full money values, and all existing workflows.
Check a representative screen in each family, plus phone/tablet/desktop and print, before release.
