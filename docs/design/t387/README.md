# T-387 design references

These are the boards Ian approved on 2026-10-09, copied out of the design canvases so builders can read them in the
repo. They are **mock-ups** in the canvas's `.dc.html` format: HTML plus a small `class Component` script for sample
data and interaction. Copy their geometry, tokens, copy and motion. Never copy their markup into the app.

- Image links of the form `/_blob/<id>` are the SharEat logo, which now lives at `apps/erp/public/brand/logo-icon.png`.
- The figures and names are sample data.
- Where a board and the spec disagree, `docs/tasks/387-warm-theme-and-grill-night-dark.md` wins.

| File | What it is | Used by |
|---|---|---|
| `brand-light-sharEat-warm.dc.html` | The light theme, SharEat Warm: palette, type, buttons in five states, form with an inline error, badges, banners, toast, table, KPI, empty state, void dialog. ⚠️ It draws **pill** buttons; the ruling is a **12px rounded rectangle** (see `Shapes`) | S1, S2, S3 |
| `brand-dark-grill-night.dc.html` | The dark theme, Grill Night. ⚠️ It draws a **gold** focus ring and **52px** controls; neither is adopted (`ring-ink`, one size) | S1 |
| `Shapes.dc.html` | Pill vs rounded rectangle, weighed. The ruling is B, the rounded rectangle | S2 |
| `Feedback.dc.html` | Toast, field error, stamp, delete, skeleton, offline pill, idle notice, the three empty states | S3, S4 |
| `OrderStatus.dc.html` | The 11 animated status icons, and option 3, "the big state" (chosen). Options 1 and 2 on the same board were not chosen | S3, S6 |
| `DashEditorial.dc.html` | The editorial dashboard (chosen) | S5 |
| `StaffCards.dc.html` | The ID card wall (chosen, the default view) | S7 |
| `StaffRoster.dc.html` | The roster with live state (chosen, the second view) | S7 |

Full canvases: brand sheet `https://claude.ai/artifact/L7hn691wjL76rSV2BgPa1A`, screen looks
`https://claude.ai/artifact/9cvfRibBSRuvBbZYe8DfjW`. They are private to Ian's account.
