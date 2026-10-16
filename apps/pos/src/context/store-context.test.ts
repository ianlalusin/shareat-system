import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the inherited-add-on-photo join in store-context.tsx.
 *
 * store-context.tsx is a "use client" provider; its heavy imports (the firebase
 * client + firestore, the auth context) are mocked purely so the module can be
 * imported under vitest's node environment. Same approach as
 * OnlineOrdersClient.test.ts — the tests themselves only call the exported
 * helpers, no rendering. This repo has no jsdom/@testing-library/react and
 * vitest.config.ts only collects `src/**\/*.test.ts`, so a render test of the
 * provider is not a clean fit here.
 */

const mockGetDocs = vi.fn();

vi.mock("@/lib/firebase/client", () => ({ db: {} }));

vi.mock("@/context/auth-context", () => ({ useAuthContext: () => ({ appUser: null }) }));

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...path: string[]) => ({ __collection: path.join("/") }),
  // Capture the constraints so the tests can assert on the `in` chunk.
  query: (base: any, ...constraints: any[]) => ({ ...base, constraints }),
  where: (field: any, op: string, value: any) => ({ field, op, value }),
  documentId: () => "__name__",
  getDocs: (...args: any[]) => mockGetDocs(...args),
  doc: vi.fn(),
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
  onSnapshot: vi.fn(),
}));

import {
  applyInheritedImages,
  chunkIds,
  collectMissingImageProductIds,
  resolveProductImages,
} from "./store-context";

/**
 * Shapes a fake products/{id} snapshot the way getDocs returns it.
 *
 * `metadata.fromCache` is load-bearing, not decoration: getDocs does NOT reject
 * when the client is offline (only getDocsFromServer does), it resolves from
 * the local cache — normally EMPTY on a till, since the cashier path never
 * otherwise reads `products`. `fromCache` is the only signal that separates
 * "the server says this product does not exist" from "we could not check".
 */
function productDocs(entries: Record<string, unknown>, fromCache = false) {
  return {
    metadata: { fromCache },
    docs: Object.entries(entries).map(([id, data]) => ({ id, data: () => data })),
  };
}

beforeEach(() => {
  mockGetDocs.mockReset();
});

describe("collectMissingImageProductIds", () => {
  it("returns the distinct productIds of rows with no local photo", () => {
    const missing = collectMissingImageProductIds(
      [
        { id: "a", productId: "p1", imageUrl: null },
        { id: "b", productId: "p1", imageUrl: null }, // same product, one query
        { id: "c", productId: "p2" }, // absent, not just null
        { id: "d", productId: "p3", imageUrl: "https://example.com/local.webp" },
      ],
      new Map()
    );
    expect(missing).toEqual(["p1", "p2"]);
  });

  it("treats an empty-string imageUrl as no local photo", () => {
    // Consumers render `{addon.imageUrl && <Image/>}`, so "" already shows a
    // blank tile — it must still inherit rather than block the fallback.
    expect(collectMissingImageProductIds([{ id: "a", productId: "p1", imageUrl: "" }], new Map())).toEqual(["p1"]);
  });

  it("falls back to the doc id when productId is absent", () => {
    expect(collectMissingImageProductIds([{ id: "p9", imageUrl: null }], new Map())).toEqual(["p9"]);
  });

  it("skips products already resolved this session, including resolved-to-null", () => {
    const cache = new Map<string, string | null>([
      ["p1", "https://example.com/global.webp"],
      ["p2", null], // the product has no photo either — must not be re-queried
    ]);
    const missing = collectMissingImageProductIds(
      [
        { id: "a", productId: "p1", imageUrl: null },
        { id: "b", productId: "p2", imageUrl: null },
        { id: "c", productId: "p3", imageUrl: null },
      ],
      cache
    );
    expect(missing).toEqual(["p3"]);
  });
});

describe("chunkIds", () => {
  it("never exceeds Firestore's 30-value `in` limit", () => {
    const ids = Array.from({ length: 71 }, (_, i) => `p${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([30, 30, 11]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns nothing for an empty list", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("applyInheritedImages", () => {
  const cache = new Map<string, string | null>([
    ["p1", "https://example.com/global-1.webp"],
    ["p2", null],
  ]);

  it("fills in the global photo for a row with no local one", () => {
    const [row] = applyInheritedImages([{ id: "a", productId: "p1", imageUrl: null }], cache);
    expect(row.imageUrl).toBe("https://example.com/global-1.webp");
  });

  it("never overwrites a row's own local photo", () => {
    const local = { id: "a", productId: "p1", imageUrl: "https://example.com/local.webp" };
    const [row] = applyInheritedImages([local], cache);
    expect(row.imageUrl).toBe("https://example.com/local.webp");
    expect(row).toBe(local); // unchanged rows keep their identity
  });

  it("leaves a row alone when the product has no photo either", () => {
    const [row] = applyInheritedImages([{ id: "a", productId: "p2", imageUrl: null }], cache);
    expect(row.imageUrl).toBeNull();
  });

  it("does not mutate its input — the enrichment is a new object", () => {
    const input = [{ id: "a", productId: "p1", imageUrl: null }];
    const out = applyInheritedImages(input, cache);
    expect(input[0].imageUrl).toBeNull();
    expect(out[0]).not.toBe(input[0]);
  });

  it("preserves the other fields the picker renders", () => {
    const [row] = applyInheritedImages(
      [{ id: "a", productId: "p1", imageUrl: null, displayName: "Coke (500ml)", sellingPrice: 25, groupKey: "g1" }],
      cache
    );
    expect(row).toMatchObject({ displayName: "Coke (500ml)", sellingPrice: 25, groupKey: "g1" });
  });
});

describe("resolveProductImages", () => {
  it("queries products by document id in chunks of at most 30", async () => {
    mockGetDocs.mockResolvedValue(productDocs({}));
    const ids = Array.from({ length: 45 }, (_, i) => `p${i}`);

    await resolveProductImages(new Map(), ids);

    expect(mockGetDocs).toHaveBeenCalledTimes(2);
    const chunkSizes = mockGetDocs.mock.calls.map((call) => {
      const inConstraint = call[0].constraints.find((c: any) => c.op === "in");
      expect(inConstraint.field).toBe("__name__");
      return inConstraint.value.length;
    });
    expect(chunkSizes).toEqual([30, 15]);
  });

  it("caches the global photo, and null for a product that has none", async () => {
    mockGetDocs.mockResolvedValue(
      productDocs({
        p1: { imageUrl: "https://example.com/global-1.webp" },
        p2: { imageUrl: null },
        p3: { imageUrl: "" },
      })
    );
    const cache = new Map<string, string | null>();

    await resolveProductImages(cache, ["p1", "p2", "p3"]);

    expect(cache.get("p1")).toBe("https://example.com/global-1.webp");
    expect(cache.get("p2")).toBeNull();
    expect(cache.get("p3")).toBeNull();
  });

  it("caches null for a SERVER-CONFIRMED missing product, so it is not re-queried", async () => {
    mockGetDocs.mockResolvedValue(
      productDocs({ p1: { imageUrl: "https://example.com/global-1.webp" } }, /* fromCache */ false)
    );
    const cache = new Map<string, string | null>();

    await resolveProductImages(cache, ["p1", "ghost"]);

    expect(cache.has("ghost")).toBe(true);
    expect(cache.get("ghost")).toBeNull();
    expect(collectMissingImageProductIds([{ id: "x", productId: "ghost", imageUrl: null }], cache)).toEqual([]);
  });

  describe("offline / cache-only results", () => {
    it("does not cache an absence it could not confirm, so the ids stay retryable", async () => {
      // The offline shape on a real till: getDocs RESOLVES from an empty local
      // cache. Caching null here would permanently blank those add-ons for the
      // rest of the session, silently and with no error anywhere.
      mockGetDocs.mockResolvedValue(productDocs({}, /* fromCache */ true));
      const cache = new Map<string, string | null>();

      await resolveProductImages(cache, ["p1", "p2"]);

      expect(cache.size).toBe(0);
      const rows = [
        { id: "a", productId: "p1", imageUrl: null },
        { id: "b", productId: "p2", imageUrl: null },
      ];
      expect(collectMissingImageProductIds(rows, cache)).toEqual(["p1", "p2"]);
    });

    it("still caches documents the local cache did return, but not the missing ones", async () => {
      mockGetDocs.mockResolvedValue(
        productDocs({ p1: { imageUrl: "https://example.com/global-1.webp" }, p2: { imageUrl: null } }, true)
      );
      const cache = new Map<string, string | null>();

      await resolveProductImages(cache, ["p1", "p2", "p3"]);

      // Real documents — a possibly-stale photo beats a blank tile.
      expect(cache.get("p1")).toBe("https://example.com/global-1.webp");
      expect(cache.get("p2")).toBeNull();
      // Never seen; absence is unconfirmed, so it must remain retryable.
      expect(cache.has("p3")).toBe(false);
    });

    it("resolves the same ids properly once a server-confirmed result arrives", async () => {
      const cache = new Map<string, string | null>();
      mockGetDocs.mockResolvedValueOnce(productDocs({}, true));
      await resolveProductImages(cache, ["p1"]);
      expect(cache.size).toBe(0);

      mockGetDocs.mockResolvedValueOnce(productDocs({ p1: { imageUrl: "https://example.com/g.webp" } }, false));
      await resolveProductImages(cache, collectMissingImageProductIds([{ id: "a", productId: "p1" }], cache));

      expect(cache.get("p1")).toBe("https://example.com/g.webp");
    });
  });

  it("rejects when the query fails, and caches nothing for that chunk so it retries", async () => {
    mockGetDocs.mockRejectedValue(new Error("Failed to get documents from server (client is offline)."));
    const cache = new Map<string, string | null>();

    await expect(resolveProductImages(cache, ["p1"])).rejects.toThrow(/offline/);

    expect(cache.size).toBe(0);
    expect(collectMissingImageProductIds([{ id: "x", productId: "p1", imageUrl: null }], cache)).toEqual(["p1"]);
  });

  it("makes no query at all when nothing is missing", async () => {
    await resolveProductImages(new Map(), []);
    expect(mockGetDocs).not.toHaveBeenCalled();
  });
});
