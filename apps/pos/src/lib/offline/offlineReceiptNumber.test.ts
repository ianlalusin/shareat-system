import { describe, it, expect } from "vitest";
import {
  formatOfflineReceiptNumber,
  nextDailySeq,
  allocateOfflineReceiptNumber,
} from "@/lib/offline/offlineReceiptNumber";
import type { KVStore } from "@/lib/offline/device";

function memStore(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("formatOfflineReceiptNumber", () => {
  it("formats <storeCode>-OL-<deviceTag>-<HHMM>-<NNN> with zero-padding", () => {
    const date = new Date(2026, 6, 1, 3, 20, 0); // 03:20 local
    expect(
      formatOfflineReceiptNumber({ storeCode: "SHT", deviceTag: "AB12", date, seq: 1 }),
    ).toBe("SHT-OL-AB12-0320-001");
  });

  it("pads hours, minutes and sequence correctly", () => {
    const date = new Date(2026, 6, 1, 9, 5, 0); // 09:05 local
    expect(
      formatOfflineReceiptNumber({ storeCode: "MNL", deviceTag: "CD34", date, seq: 42 }),
    ).toBe("MNL-OL-CD34-0905-042");
  });
});

describe("nextDailySeq", () => {
  it("starts at 1 and increments within the same day", () => {
    const store = memStore();
    const d = new Date(2026, 6, 1, 10, 0, 0);
    expect(nextDailySeq(store, d)).toBe(1);
    expect(nextDailySeq(store, d)).toBe(2);
    expect(nextDailySeq(store, d)).toBe(3);
  });

  it("resets to 1 when the local calendar day changes", () => {
    const store = memStore();
    expect(nextDailySeq(store, new Date(2026, 6, 1, 23, 59, 0))).toBe(1);
    expect(nextDailySeq(store, new Date(2026, 6, 1, 23, 59, 30))).toBe(2);
    expect(nextDailySeq(store, new Date(2026, 6, 2, 0, 1, 0))).toBe(1);
  });

  it("throws on unparseable persisted state rather than silently reissuing", () => {
    const store = memStore();
    store.setItem("pos_offline_seq", "{not json"); // pos_offline_seq is the module's storage key
    expect(() => nextDailySeq(store, new Date(2026, 6, 1, 10, 0, 0))).toThrow();
  });

  it("throws on parseable-but-malformed persisted state (missing seq)", () => {
    const store = memStore();
    store.setItem("pos_offline_seq", JSON.stringify({ ymd: "2026-07-01" }));
    expect(() => nextDailySeq(store, new Date(2026, 6, 1, 10, 0, 0))).toThrow();
  });
});

describe("allocateOfflineReceiptNumber", () => {
  it("allocates a sequence and formats it in one call", () => {
    const store = memStore();
    const d = new Date(2026, 6, 1, 3, 20, 0);
    expect(allocateOfflineReceiptNumber(store, "SHT", "AB12", d)).toBe("SHT-OL-AB12-0320-001");
    expect(allocateOfflineReceiptNumber(store, "SHT", "AB12", d)).toBe("SHT-OL-AB12-0320-002");
  });
});
