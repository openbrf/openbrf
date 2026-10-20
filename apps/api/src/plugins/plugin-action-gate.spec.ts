import { describe, expect, it } from "vite-plus/test";

import { canonicalDeviceRoute, parseDeviceRoutes } from "./plugin-action-gate";

/**
 * The board's consent to a plugin's device routes is kept as canonical
 * strings, and read back as routes where nothing else says which paths are
 * device routes: a plugin switched off for the instance, or removed (ADR 0031).
 */
describe("reading consented device routes back", () => {
  it("gives back the routes the strings were made from", () => {
    const routes = [
      { id: "screen", path: "screen" },
      { id: "pictures", path: "media/pictures" },
    ];

    expect(parseDeviceRoutes(routes.map(canonicalDeviceRoute))).toEqual(routes);
  });

  it("skips a string that names no route and no path", () => {
    expect(parseDeviceRoutes(["screen", ":screen", "screen:"])).toEqual([]);
  });
});
