# src/lib/qr contract

## Overview

QR image decoding, EMVCo TLV/CRC parsing, deterministic initials and online-wallet QR selection.

## Interface

- [decode-image.ts](./decode-image.ts) — `QrDecodeResult`, `decodeQrFromFrame`, `decodeQrFromImage`.
- [emvco.ts](./emvco.ts) — `EmvTlv`, `EmvWarning`, `EmvMerchantAccount`, `EmvQrInfo`, `PHP_CURRENCY`, `PH_COUNTRY`, `crc16Ccitt`, `formatCrc`, `verifyEmvCrc`, `parseTlv`, `parseEmvQr`, `maskAccountTail`.
- [initials.ts](./initials.ts) — `INITIALS_PALETTE`, `initialsFor`, `colorFor`, `initialsBadge`.
- [online-qr.ts](./online-qr.ts) — `pickOnlineQr`, `planFlagChange`.

## Invariants

- Malformed TLV headers/lengths are refused.
- Online QR selection is deterministic even when more than one document is flagged.
- Initials artwork remains available without a fetched brand logo.

## Side Effects

- Image decoding allocates image/canvas resources and runs barcode decoders; EMV/initials/selection functions are pure.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (20794 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
