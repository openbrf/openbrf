import { describe, expect, it } from "vite-plus/test";

import { createTestEntitlements } from "./entitlements.ts";

describe("createTestEntitlements", () => {
  const audience = "https://themes.example.org";

  it("answers with the state it holds, and follows a change to it", async () => {
    const entitlements = createTestEntitlements({
      state: { status: "absent" },
    });
    await expect(entitlements.get()).resolves.toEqual({ status: "absent" });

    entitlements.state = { status: "tampered" };
    await expect(entitlements.get()).resolves.toEqual({ status: "tampered" });
  });

  it("presents only while active, and only to a declared audience", async () => {
    const entitlements = createTestEntitlements({
      state: {
        status: "active",
        licenceId: "9b0c7c5e-2f4e-4d8a-9a51-3a3f0a5f1c2d",
        validUntil: null,
        updatesUntil: null,
      },
      audiences: [audience],
    });

    await expect(entitlements.present(audience)).resolves.toBe(
      `test-presentation:${audience}`,
    );
    await expect(
      entitlements.present("https://elsewhere.example.org"),
    ).rejects.toBeInstanceOf(RangeError);

    entitlements.state = {
      status: "expired",
      licenceId: "9b0c7c5e-2f4e-4d8a-9a51-3a3f0a5f1c2d",
      validUntil: "2026-01-31",
    };
    await expect(entitlements.present(audience)).resolves.toBeNull();
  });
});
