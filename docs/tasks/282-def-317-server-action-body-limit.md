# T-282 / DEF-317 — every file upload in the app dies above 1 MB

**Reported by Ian, 2026-09-12:** *"tried to log invoice not saving when an image is uploaded,
without image it saves."*

## The defect, verified in the installed source

`apps/erp/next.config.js` never sets `experimental.serverActions.bodySizeLimit`. In the installed
Next.js **16.3.2**, `node_modules/next/dist/server/app-render/action-handler.js:519` reads:

```js
const bodySizeLimitBytes = bodySizeLimit !== defaultBodySizeLimit
  ? require('next/dist/compiled/bytes').parse(bodySizeLimit)
  : 1024 * 1024 // 1 MB
```

and line 669 throws `ApiError(413, 'Body exceeded 1 MB limit.')` on the multipart branch — the
branch a `<input type="file">` submission takes. The action function never runs.

Meanwhile `PURPOSE_LIMITS.receipt_photo` (`packages/domain/src/files/index.ts:36`) accepts
**8 MB**, and the largest declared purpose accepts **25 MB**.

⭐ **The domain's per-purpose limits have been unreachable for their whole existence.** Any phone
photo over ~1 MB — which is most of them — is refused by the framework before `uploadFile` is
reached, so neither the size check, the content-type check, nor the EXIF strip ever ran on the
files people actually tried to send.

## ⛔ It is not one screen. It is every upload in the app.

Ian found it on `/ap`, but `uploadFile` has three callers and all three are affected:

| Surface | File | Purpose | Domain limit |
|---|---|---|---|
| Log a supplier invoice | `apps/erp/src/app/ap/actions.ts:131` | `receipt_photo` | 8 MB |
| AR collection proof | `apps/erp/src/app/customers/actions.ts:131` | `receipt_photo` | 8 MB |
| Delivery document | `apps/erp/src/app/inventory/deliveries/actions.ts:148` | `receipt_photo` | 8 MB |

⚠️ **Noted in passing, not fixed here** (RULES §13 row 164): `ar_collection_proof`,
`memo_document`, `wastage_dispute` and `onboarding_document` are declared in `PURPOSE_LIMITS` with
**zero callers anywhere** — all three live surfaces pass `receipt_photo`. That is the same
"built, registered, never called" shape as DEF-299, DEF-260 and DEF-314. Reported, unverified.

## The fix

1. `apps/erp/next.config.js` — add `experimental.serverActions.bodySizeLimit`.
2. A guard test asserting the framework bound is never tighter than the domain's.

### The invariant, stated once

> **The framework must never be the layer that refuses a file the domain would accept.**

So the config value is bounded by the *largest declared* `PURPOSE_LIMITS.maxBytes` (25 MB), not by
the largest one with a caller today (8 MB). Binding it to the reachable set would leave a trap for
whoever first wires `onboarding_document`: a green build and a 413 in production.

Value: **`'26mb'`** — 25 MB plus multipart field and boundary overhead.

⚠️ **The trade-off, stated rather than buried.** This raises the accepted body size for *every*
server action in the app, not only the three that take a file. The real per-purpose control stays
where it already is and is already tested — `uploadFile` refuses on size, type and purpose before
a byte reaches storage. Next's limit is a blunt outer bound, not the control. If Ian would rather
trade the unreachable purposes for a tighter bound, `'9mb'` covers every live surface and the
guard test below is what would then go red the day someone wires a 25 MB one.

### ⚠️ There is a SECOND limit, and it produces the identical symptom

Production runs behind **Caddy** on `159.223.46.224`. A reverse-proxy body cap would refuse the
same upload with the same user-visible result *after* this fix lands. `request_body max_size` must
be confirmed ≥ 26 MB on that host. **That is a production step, not a repo change**, and this task
is not complete-in-production until someone runs it. Flagged by system32-85.

## Guard — `tests/unit/server-action-body-limit.test.ts`

Reads the real `next.config.js` and the real `PURPOSE_LIMITS`, and asserts the relationship
between them. It is a **contract test**, in the shape of `tests/unit/storage-bucket-config-contract.test.ts`:
nothing is restated, both sides are imported from where they actually live, so the test cannot
drift from the thing it guards.

⛔ **The state that proves it works is the plant**: with the `bodySizeLimit` key removed, the test
must go RED. A test that only ever passed proves nothing (RULES §2). That state is executed below,
not reasoned about.

## Files this task may touch

- `apps/erp/next.config.js`
- `tests/unit/server-action-body-limit.test.ts` (new)
- `docs/tasks/282-def-315-server-action-body-limit.md` (this file)

## Definition of done

typecheck clean · the new guard passes · the plant makes it fail · unit suite green ·
⚠️ smoketest of a >1 MB upload on 9008 **still owed** — port coordination with system32-85.
