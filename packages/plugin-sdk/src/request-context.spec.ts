import { describe, expect, it } from "vite-plus/test";

import {
  PLUGIN_REQUEST_MEMBERS,
  PluginRequestContextError,
} from "./request-context.ts";

describe("PluginRequestContextError", () => {
  it("names the plugin and the member, so a plugin's test can tell which", () => {
    const error = new PluginRequestContextError(
      "parking-share",
      "actions.invoke",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginRequestContextError");
    expect(error.pluginId).toBe("parking-share");
    expect(error.member).toBe("actions.invoke");
  });

  it.each(PLUGIN_REQUEST_MEMBERS)(
    "tells the plugin what to hand background work instead, for %s",
    (member) => {
      expect(
        new PluginRequestContextError("parking-share", member).message,
      ).toBe(
        `Plugin "parking-share" gave ${member} a request that the work making ` +
          "the call is not serving. A request is used only by the work that " +
          "serves it; hand background work what it needs from the request, " +
          "not the request.",
      );
    },
  );
});
