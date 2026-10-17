# @shareat/customer - Shareat Customer v2 (skeleton, sample data only)

Port **9010** (dev and start). App id `net.shareat.order`. Specs: `docs/tasks/417-pos-customer-monorepo-setup.md` (the shell), `docs/tasks/437-customer-v2-skeleton.md` (this skeleton).

**Fixtures only.** Every screen runs on made-up sample data held in the browser's memory. Nothing reads or writes any live system: no server, no API route, no Firebase, no Capacitor import in `src`. A reload forgets the visit (the app then says "Join a table first"). `tests/` guard files enforce this (`src/__tests__/skeleton-guards.test.ts`).

## Routes
| Route | Screen |
|---|---|
| `/` | Join a table: 6-digit PIN pad (5 wrong tries lock the phone for 5 minutes) |
| `/join?t=<qr token>` | QR landing, seats you and goes to the menu |
| `/menu` | Menu by category; refills show "Included" |
| `/cart` | Quantities, "Send order" (item ids and quantities only, never a price) |
| `/orders` | Order status; "Demo: advance" moves an order along |
| `/bill` | Running bill, read-only estimate (food counts once served) |
| `/feedback` | 1-5 stars and optional text |
| `/account` | Sign up (consent box starts unticked and is required) and sign in |

Demo PINs and QR links are listed on the join screen while the sample data is in use.

## How it is built
Screens only talk to the `CustomerData` interface (`src/data/customer-data.ts`) through hooks in `src/data/provider.tsx`. `src/data/fixture-data.ts` implements it with sample data and enforces the rules the real server must own in P3. Swapping in the real server later means a new `CustomerData`, not new screens.

## Run
- `npm run dev:customer` (from the repo root) serves on 9010.
- `npm test -w @shareat/customer` runs this app's own tests (the root `unit` project skips `apps/customer`).
- `npm run build -w @shareat/customer` is the server build; `npm run build:cap -w @shareat/customer` is the static export to `out/` for the Android app.
- It must never import from another app (`tests/unit/app-boundaries.test.ts`).
