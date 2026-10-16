import { describe, it, expect } from "vitest";
import { sessionOwnershipFields } from "@/lib/offline/sessionOwnership";

describe("sessionOwnershipFields", () => {
  it("stamps the owning terminal and initializes revision to 1 by default", () => {
    expect(sessionOwnershipFields("device-abc")).toEqual({
      ownerTerminalId: "device-abc",
      revision: 1,
    });
  });

  it("accepts an explicit starting revision", () => {
    expect(sessionOwnershipFields("device-abc", 5)).toEqual({
      ownerTerminalId: "device-abc",
      revision: 5,
    });
  });
});
