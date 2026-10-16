# @shareat/customer — Shareat Customer v2 (empty shell)

Port **9010** (dev and start). App id `net.shareat.order`. Spec: `docs/tasks/417-pos-customer-monorepo-setup.md`.

- `npm run dev:customer` (from the repo root) serves the shell.
- `npm run build -w @shareat/customer` is the server build; `npm run build:cap -w @shareat/customer` is the static export to `out/` for the Android app.
- One page, no API routes. It must never import from another app (`tests/unit/app-boundaries.test.ts`).
