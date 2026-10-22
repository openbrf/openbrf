import {
  PLUGIN_ROUTE_CAPABILITIES,
  type PluginRouteCapability,
} from "@openbrf/plugin-sdk";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { CAPABILITIES, type Capability } from "./capabilities";

describe("the capabilities a plugin route may require", () => {
  it("are the capabilities this instance has, so the SDK's list cannot drift", () => {
    expect([...PLUGIN_ROUTE_CAPABILITIES].sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });

  it("are the same type as the capabilities this instance has", () => {
    expectTypeOf<PluginRouteCapability>().toEqualTypeOf<Capability>();
  });
});
