# T-455: Customer app lobby (menu, self check-in, booking code, birthday request, discount ID)

**Status:** RESERVED 2026-10-22. Proposal given to Ian (research-evaluate-propose); spec waits on his answers.
**Asked by Ian, 2026-10-22:** a diner opens the customer app at the gate, sees the menu, checks in ("we are 5, pork and
chicken"), joins the waitlist and gets a booking code; the cashier enters the code, confirms the order, the session
starts and the diner's device is moved into it automatically. The printed join QR stays. Also a "request birthday song"
button (cashier picks a time, accepts or declines; POS plays it then) and a discount-ID photo that is read, parked, and
added only when the cashier approves, with a record kept.

## What already exists (22 Oct research)
- URL: bible row 349 = Customer v2 at `order.shareat.net`; `customer.shareat.net` is v1 (repointed later). No `customer2`.
- Menu: public on the Website (`/menu`); the customer apps need a session. v2 skeleton is sample data.
- Waitlist: POS v1 staff-only (`WaitlistCard.tsx`, `ParkWalkInModal.tsx`, Firestore `stores/{id}/waitlist`); no diner side, no code.
- Join: v1 QR/PIN -> `exchange-qr` -> participant slot keyed by hashed device id (`CUSTOMER/src/lib/server/customer-participants.ts`).
- Birthday song: POS v1, cashier-triggered only, offline MP3s, no schedule.
- SC/PWD ID: nothing captured anywhere (row 164); T-137 logbook spec; PC-6; row 330 local OCR only, row 251 no outside AI,
  row 353 IDs strictly guarded.

## Open questions for Ian
1. Keep `order.shareat.net` (row 349)?
2. ID reading on the phone or our server only, never an outside AI service (rows 251/353)? The cashier still sees the card.
3. When: after POS v2 core and the 1 Jan cutover work, or before?
