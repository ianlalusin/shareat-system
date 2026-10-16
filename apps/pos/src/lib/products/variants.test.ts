import { describe, it, expect } from "vitest";
import { groupIntoFamilies } from "@/lib/products/variants";

describe("groupIntoFamilies", () => {
  it("groups variants sharing a groupId into one family row, labeled by groupName", () => {
    const items = [
      { id: "v1", kind: "variant" as const, groupId: "grp1", groupName: "Kimbap", name: "Kimbap", variantLabel: "Original" },
      { id: "v2", kind: "variant" as const, groupId: "grp1", groupName: "Kimbap", name: "Kimbap", variantLabel: "Spicy" },
    ];
    const rows = groupIntoFamilies(items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "family", groupId: "grp1", groupName: "Kimbap" });
    expect((rows[0] as any).variants.map((v: any) => v.id)).toEqual(["v1", "v2"]);
  });

  it("keeps a single (non-variant) item standing alone", () => {
    const items = [{ id: "p1", kind: "single" as const, name: "Coke" }];
    const rows = groupIntoFamilies(items);
    expect(rows).toEqual([{ kind: "single", item: items[0] }]);
  });

  it("never groups a variant-kind item that has no groupId", () => {
    const items = [{ id: "v1", kind: "variant" as const, name: "Loose Variant" }];
    const rows = groupIntoFamilies(items);
    expect(rows).toEqual([{ kind: "single", item: items[0] }]);
  });

  it("joins later-appearing variants of the same family into the row created by the first one", () => {
    const items = [
      { id: "v1", kind: "variant" as const, groupId: "grp1", groupName: "Sharebox", name: "Sharebox", variantLabel: "Beef" },
      { id: "single", kind: "single" as const, name: "Water" },
      { id: "v2", kind: "variant" as const, groupId: "grp1", groupName: "Sharebox", name: "Sharebox", variantLabel: "Pork" },
    ];
    const rows = groupIntoFamilies(items);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "family", groupId: "grp1" });
    expect((rows[0] as any).variants.map((v: any) => v.id)).toEqual(["v1", "v2"]);
    expect(rows[1]).toEqual({ kind: "single", item: items[1] });
  });

  it("treats different groupIds as different families", () => {
    const items = [
      { id: "v1", kind: "variant" as const, groupId: "grp1", groupName: "Kimbap", name: "Kimbap" },
      { id: "v2", kind: "variant" as const, groupId: "grp2", groupName: "Sharebox", name: "Sharebox" },
    ];
    const rows = groupIntoFamilies(items);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.kind === "family" ? r.groupId : null))).toEqual(["grp1", "grp2"]);
  });
});
