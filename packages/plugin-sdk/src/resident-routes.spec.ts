import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS,
  PluginResidentRouteError,
} from "./resident-routes.ts";

describe("PluginResidentRouteError", () => {
  it("names the plugin and the member, so a plugin's test can tell which", () => {
    const error = new PluginResidentRouteError(
      "parking-share",
      "addressBook.residents",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginResidentRouteError");
    expect(error.pluginId).toBe("parking-share");
    expect(error.member).toBe("addressBook.residents");
  });

  it.each([
    "addressBook.residents",
    "addressBook.apartments",
    "addressBook.summary",
  ] as const)("says that %s reads the register", (member) => {
    expect(new PluginResidentRouteError("parking-share", member).message).toBe(
      `Plugin "parking-share" called ${member} on a resident route, where the register is not read.`,
    );
  });

  it.each([
    "addressBook.caller",
    "actions.list",
    "actions.invoke",
    "actions.propose",
  ] as const)("says that %s was passed another request", (member) => {
    expect(new PluginResidentRouteError("parking-share", member).message).toBe(
      `Plugin "parking-share" called ${member} on a resident route with another request than the one the route is serving.`,
    );
  });

  it("lists the members of ADR 0051's table that it is raised for", () => {
    expect(PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS).toEqual([
      "addressBook.residents",
      "addressBook.apartments",
      "addressBook.summary",
      "addressBook.caller",
      "actions.list",
      "actions.invoke",
      "actions.propose",
    ]);
  });
});
