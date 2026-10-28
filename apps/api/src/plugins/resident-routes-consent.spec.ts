import { describe, expect, it } from "vite-plus/test";

import type { PluginRecord } from "./plugin-registry.service";
import { residentRoutesConsented } from "./resident-routes-consent";

// The resident-routes integration suite replaces this helper with a mock, so
// this is the one place the real gate is exercised.
describe("residentRoutesConsented", () => {
  it("consents to nothing until the install records resident routes", () => {
    expect(residentRoutesConsented({ id: "any-plugin" } as PluginRecord)).toBe(
      false,
    );
  });
});
