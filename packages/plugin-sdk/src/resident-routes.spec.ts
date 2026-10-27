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
    expect(error.outside).toBe(false);
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
    "audit.record",
  ] as const)("says that %s was passed another request", (member) => {
    expect(new PluginResidentRouteError("parking-share", member).message).toBe(
      `Plugin "parking-share" called ${member} on a resident route with another request than the one the route is serving.`,
    );
  });

  it.each([
    "addressBook.residents",
    "personRecords.put",
    "recipients.fetch",
  ] as const)(
    "says that %s, called outside the resident routes, waited in vain",
    (member) => {
      const error = new PluginResidentRouteError("parking-share", member, true);

      expect(error.outside).toBe(true);
      expect(error.message).toBe(
        `Plugin "parking-share" called ${member} outside its resident routes while one of them had yet to answer, and it did not answer in time. A resident route's handler may not wait on such a call.`,
      );
    },
  );

  it("lists the members of ADR 0051's table that it is raised for", () => {
    expect(PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS).toEqual([
      "addressBook.residents",
      "addressBook.apartments",
      "addressBook.summary",
      "addressBook.caller",
      "actions.list",
      "actions.invoke",
      "actions.propose",
      "audit.record",
      "personRecords.put",
      "recipients.fetch",
    ]);
  });
});
