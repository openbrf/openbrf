import { PLUGIN_ROUTE_CAPABILITIES } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import { CAPABILITIES } from "./capabilities";

describe("the capabilities a plugin route may require", () => {
  it("are the capabilities this instance has, so the SDK's list cannot drift", () => {
    expect([...PLUGIN_ROUTE_CAPABILITIES].sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });
});
