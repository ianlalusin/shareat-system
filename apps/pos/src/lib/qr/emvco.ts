/**
 * EMVCo merchant-presented QR (QR Ph / QRPH) parsing.
 *
 * Pure, dependency-free, no DOM, no Firebase — unit-testable under vitest.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LOAD-BEARING RULE: store and re-render the payload VERBATIM.
 * ─────────────────────────────────────────────────────────────────────────────
 * Tag order is not canonical in EMVCo, and the CRC in tag 63 is computed over
 * the EXACT byte sequence including the literal "6304". Re-emitting the tags in
 * "clean" order produces a different string with a different (also valid) CRC.
 * Some bank apps validate against the issuer's expected layout and reject it,
 * and you would have no way to tell which saved QRs broke.
 *
 * This module therefore has NO serializer. Not "a serializer we don't call" —
 * none exists. You cannot misuse what isn't there. `EmvQrInfo.raw` is the only
 * field callers may persist as the scannable payload; everything else is
 * display metadata.
 *
 * ENCODING NOTE (measured, not assumed): EMVCo TLV lengths count CHARACTERS,
 * not bytes — in the spec's own sample, tag 64 declares length 20 for a value
 * that is 20 characters but 32 UTF-8 bytes. So TLV is sliced by string index,
 * while the CRC runs over UTF-8 bytes. For real QR Ph payloads (pure ASCII)
 * the two are identical; this only matters for the language template (tag 64).
 */

export type EmvTlv = {
  tag: string;
  length: number;
  value: string;
  /** Index in the source string where this TLV's tag begins. */
  start: number;
};

export type EmvWarning =
  | "crc_mismatch"
  | "crc_missing"
  | "malformed_tlv"
  | "not_emv"
  | "has_amount"
  | "dynamic_initiation"
  | "no_merchant_account"
  | "unexpected_currency"
  | "unexpected_country";

export type EmvMerchantAccount = {
  /** The template tag, "26".."51". */
  tag: string;
  /** Sub-tag 00 — the globally unique identifier, e.g. "ph.ppmi.p2p". */
  guid: string | null;
  /** Remaining sub-tags, keyed by sub-tag. */
  fields: Record<string, string>;
};

export type EmvQrInfo = {
  /** VERBATIM. The only field callers may persist as the scannable payload. */
  raw: string;
  isEmv: boolean;
  crcValid: boolean;
  /** Tag 00 — payload format indicator, expected "01". */
  formatIndicator: string | null;
  /** Tag 01 — "11" = static (reusable), "12" = dynamic (one-time). */
  initiationMethod: "static" | "dynamic" | null;
  /** Tags 26–51. */
  merchantAccounts: EmvMerchantAccount[];
  /** Tag 52 — merchant category code. */
  mcc: string | null;
  /** Tag 53 — ISO 4217 numeric. PHP = "608". */
  currency: string | null;
  /** Tag 54 — transaction amount. Present on a reusable QR is a WARNING. */
  amount: string | null;
  /** Tag 58 — ISO 3166-1 alpha-2. "PH". */
  countryCode: string | null;
  /** Tag 59. */
  merchantName: string | null;
  /** Tag 60. */
  merchantCity: string | null;
  /** Tag 62 — additional data field template, flattened by sub-tag. */
  additionalData: Record<string, string>;
  warnings: EmvWarning[];
};

/** ISO 4217 numeric for the Philippine peso. */
export const PHP_CURRENCY = "608";
/** ISO 3166-1 alpha-2 for the Philippines. */
export const PH_COUNTRY = "PH";

/** Templates that carry merchant account information. */
const MERCHANT_ACCOUNT_MIN = 26;
const MERCHANT_ACCOUNT_MAX = 51;

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no input reflection, no output
 * reflection, no final XOR. Verified against the standard check value —
 * crc16Ccitt("123456789") === 0x29B1.
 *
 * Computed over UTF-8 bytes (see the encoding note at the top of the file).
 */
export function crc16Ccitt(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Formats a CRC as the 4 uppercase hex chars EMVCo puts in tag 63. */
export function formatCrc(crc: number): string {
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Verifies the tag-63 checksum.
 *
 * Deliberately does NOT use parseTlv: a corrupt payload may not tokenize at
 * all, and we still want a usable verdict. Locates the LAST "6304" — tag 63 is
 * always final in EMVCo, and an earlier "6304" can occur inside another value.
 */
export function verifyEmvCrc(payload: string): {
  ok: boolean;
  expected: string;
  actual: string;
  found: boolean;
} {
  const idx = payload.lastIndexOf("6304");
  if (idx < 0 || idx + 8 !== payload.length) {
    return { ok: false, expected: "", actual: "", found: false };
  }
  // The CRC covers everything up to and including the literal "6304".
  const expected = formatCrc(crc16Ccitt(payload.slice(0, idx + 4)));
  const actual = payload.slice(idx + 4).toUpperCase();
  return { ok: expected === actual, expected, actual, found: true };
}

/**
 * Tokenizes an EMVCo TLV string.
 *
 * Throws on malformed input — callers that must not fail (parseEmvQr) catch it.
 */
export function parseTlv(input: string): EmvTlv[] {
  const out: EmvTlv[] = [];
  let i = 0;
  while (i < input.length) {
    if (i + 4 > input.length) {
      throw new Error(`Truncated TLV header at ${i}`);
    }
    const tag = input.slice(i, i + 2);
    const lengthText = input.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) {
      throw new Error(`Non-numeric tag/length at ${i}`);
    }
    const length = Number(lengthText);
    if (!Number.isInteger(length) || length < 0 || i + 4 + length > input.length) {
      throw new Error(`Declared length ${length} overruns input at ${i}`);
    }
    out.push({ tag, length, value: input.slice(i + 4, i + 4 + length), start: i });
    i += 4 + length;
  }
  return out;
}

/** Tokenizes a nested template, returning {} rather than throwing. */
function parseNested(value: string): Record<string, string> {
  try {
    const map: Record<string, string> = {};
    for (const tlv of parseTlv(value)) map[tlv.tag] = tlv.value;
    return map;
  } catch {
    return {};
  }
}

function isMerchantAccountTag(tag: string): boolean {
  const n = Number(tag);
  return Number.isInteger(n) && n >= MERCHANT_ACCOUNT_MIN && n <= MERCHANT_ACCOUNT_MAX;
}

/**
 * Parses an EMVCo payload. NEVER throws.
 *
 * Garbage in degrades to `{ isEmv: false, warnings: ['not_emv'] }` so the
 * caller's Add flow can still save the captured photo — a failed decode must
 * never lose the capture.
 */
export function parseEmvQr(payload: string): EmvQrInfo {
  const raw = payload ?? "";
  const warnings: EmvWarning[] = [];
  const info: EmvQrInfo = {
    raw,
    isEmv: false,
    crcValid: false,
    formatIndicator: null,
    initiationMethod: null,
    merchantAccounts: [],
    mcc: null,
    currency: null,
    amount: null,
    countryCode: null,
    merchantName: null,
    merchantCity: null,
    additionalData: {},
    warnings,
  };

  if (!raw.trim()) {
    warnings.push("not_emv");
    return info;
  }

  const crc = verifyEmvCrc(raw);
  info.crcValid = crc.ok;
  if (!crc.found) warnings.push("crc_missing");
  else if (!crc.ok) warnings.push("crc_mismatch");

  let tlvs: EmvTlv[];
  try {
    tlvs = parseTlv(raw);
  } catch {
    warnings.push("malformed_tlv");
    // A payload that will not tokenize is still not EMV, but we keep whatever
    // CRC verdict we managed to reach above.
    if (!raw.startsWith("000201")) warnings.push("not_emv");
    return info;
  }

  for (const tlv of tlvs) {
    switch (tlv.tag) {
      case "00":
        info.formatIndicator = tlv.value;
        break;
      case "01":
        info.initiationMethod =
          tlv.value === "11" ? "static" : tlv.value === "12" ? "dynamic" : null;
        break;
      case "52":
        info.mcc = tlv.value;
        break;
      case "53":
        info.currency = tlv.value;
        break;
      case "54":
        info.amount = tlv.value;
        break;
      case "58":
        // Some issuers emit tag 58 twice; the first occurrence wins.
        if (info.countryCode === null) info.countryCode = tlv.value;
        break;
      case "59":
        info.merchantName = tlv.value;
        break;
      case "60":
        info.merchantCity = tlv.value;
        break;
      case "62":
        info.additionalData = { ...info.additionalData, ...parseNested(tlv.value) };
        break;
      case "63":
        break; // CRC — handled by verifyEmvCrc.
      default:
        if (isMerchantAccountTag(tlv.tag)) {
          const fields = parseNested(tlv.value);
          const { "00": guid, ...rest } = fields;
          info.merchantAccounts.push({ tag: tlv.tag, guid: guid ?? null, fields: rest });
        }
        break;
    }
  }

  info.isEmv = info.formatIndicator === "01";
  if (!info.isEmv) warnings.push("not_emv");
  if (info.amount !== null) warnings.push("has_amount");
  if (info.initiationMethod === "dynamic") warnings.push("dynamic_initiation");
  if (info.merchantAccounts.length === 0) warnings.push("no_merchant_account");
  if (info.currency !== null && info.currency !== PHP_CURRENCY) {
    warnings.push("unexpected_currency");
  }
  if (info.countryCode !== null && info.countryCode !== PH_COUNTRY) {
    warnings.push("unexpected_country");
  }

  return info;
}

/**
 * Last 4 of the longest numeric sub-field across merchant accounts, for a
 * "••••1234" display. Returns null when nothing account-shaped is present.
 */
export function maskAccountTail(info: EmvQrInfo): string | null {
  let best = "";
  for (const account of info.merchantAccounts) {
    for (const value of Object.values(account.fields)) {
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 4 && digits.length > best.length) best = digits;
    }
  }
  return best ? `••••${best.slice(-4)}` : null;
}

/**
 * Bank Identifier Codes (BIC/SWIFT) → provider key.
 *
 * IMPORTANT: in QR Ph the merchant-account GUID is "ph.ppmi.p2m" / "ph.ppmi.p2p"
 * for EVERY participant — it identifies the SCHEME, not the wallet. The actual
 * institution is carried as a BIC in one of the template's sub-tags. So the BIC
 * is what we match on; matching the GUID would resolve every PH QR to the same
 * provider, which is exactly the bug this comment exists to prevent.
 */
const BIC_PROVIDERS: Array<[RegExp, string]> = [
  [/^GXCHPH/i, "gcash"], // GCash (G-Xchange)
  [/^PAPHPH/i, "maya"], // Maya / PayMaya
  [/^UBPHPH/i, "unionbank"],
  [/^BOPIPH/i, "bpi"],
  [/^BNORPH/i, "bdo"],
  [/^MBTCPH/i, "metrobank"],
  [/^TLBPPH/i, "landbank"],
  [/^RCBCPH/i, "rcbc"],
  [/^SETCPH/i, "securitybank"],
  [/^CHBKPH/i, "chinabank"],
  [/^SEBAPH/i, "seabank"],
  [/^GOTYPH/i, "gotyme"],
  [/^TONIPH/i, "tonik"],
];

/**
 * Free-text fragments → provider key. Used against the merchant name carried in
 * the QR and against the name the manager types.
 */
const NAME_PROVIDERS: Array<[RegExp, string]> = [
  [/gcash|g-cash|mynt|g-xchange/i, "gcash"],
  [/paymaya|maya/i, "maya"],
  [/grab\s*pay|grabpay|grab/i, "grabpay"],
  [/shopee\s*pay|shopeepay|shopee/i, "shopeepay"],
  [/union\s*bank|unionbank|ubp/i, "unionbank"],
  [/\bbpi\b/i, "bpi"],
  [/\bbdo\b/i, "bdo"],
  [/metro\s*bank|metrobank/i, "metrobank"],
  [/land\s*bank|landbank/i, "landbank"],
  [/sea\s*bank|seabank/i, "seabank"],
  [/gotyme|go\s*tyme/i, "gotyme"],
  [/tonik/i, "tonik"],
  [/\bcoins(\.ph)?\b/i, "coins"],
  [/palawan/i, "palawanpay"],
  [/cebuana/i, "cebuana"],
  [/security\s*bank/i, "securitybank"],
  [/china\s*bank/i, "chinabank"],
  [/\brcbc\b/i, "rcbc"],
  [/netbank/i, "netbank"],
];

/**
 * Resolves the stable `provider` key used for icon lookup — kept separate from
 * the free-text display name so "GCash — Ate Malou" still resolves to "gcash".
 * (Pattern borrowed from the Bills Reminder app's WalletQr.provider.)
 *
 * Order: BIC in any merchant-account sub-field (most reliable) → merchant name
 * carried in the QR → the name the manager typed → "generic".
 */
export function guessProvider(info: EmvQrInfo | null, name: string): string {
  for (const account of info?.merchantAccounts ?? []) {
    for (const value of Object.values(account.fields)) {
      for (const [pattern, provider] of BIC_PROVIDERS) {
        if (pattern.test(value)) return provider;
      }
    }
  }
  for (const haystack of [info?.merchantName ?? "", name ?? ""]) {
    if (!haystack) continue;
    for (const [pattern, provider] of NAME_PROVIDERS) {
      if (pattern.test(haystack)) return provider;
    }
  }
  return "generic";
}
