import "@nestjs/common";
import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_ROUTE_CAPABILITIES,
  REQUIRED_CAPABILITIES_KEY,
  RequireCapability,
} from "./require-capability.ts";

describe("RequireCapability", () => {
  it("writes the capabilities under the key the host reads, on a route", () => {
    class Controller {
      install(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Controller.prototype,
      "install",
    )!;
    RequireCapability("association:manage", "association:read")(
      Controller.prototype,
      "install",
      descriptor,
    );

    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, descriptor.value),
    ).toEqual(["association:manage", "association:read"]);
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, Controller),
    ).toBeUndefined();
  });

  it("writes them on the class when applied to a controller", () => {
    class Controller {}
    (RequireCapability("fees:manage") as ClassDecorator)(Controller);

    expect(Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, Controller)).toEqual([
      "fees:manage",
    ]);
  });

  it("uses the key the contract names", () => {
    expect(REQUIRED_CAPABILITIES_KEY).toBe("openbrf:required-capabilities");
  });

  it("lists each capability once", () => {
    expect(new Set(PLUGIN_ROUTE_CAPABILITIES).size).toBe(
      PLUGIN_ROUTE_CAPABILITIES.length,
    );
  });
});
