# @shareat/pos — Shareat POS v2 (empty shell)

Port **9009** (dev and start). App id `net.shareat.pos2`. Spec: `docs/tasks/417-pos-customer-monorepo-setup.md`.

- `npm run dev:pos` (from the repo root) serves the shell.
- `npm run build -w @shareat/pos` is the server build; `npm run build:cap -w @shareat/pos` is the static export to `out/` for the Android app.
- One page, no API routes. It must never import from another app (`tests/unit/app-boundaries.test.ts`).
