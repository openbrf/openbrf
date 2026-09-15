import { describe, expect, it } from "vitest";

import {
  PROCESSOR_KEYS,
  connectedAppProcessorKey,
  externalProcessorKey,
  parseProcessorKey,
  pluginProcessorKey,
  processorKeySchema,
} from "./processor-key";

describe("processor keys", () => {
  it("names the four recipients every instance has one of", () => {
    expect(PROCESSOR_KEYS).toEqual(["smtp", "sms", "storage", "hosting"]);
  });

  it("round trips a plugin key", () => {
    const key = pluginProcessorKey("occupancy-board");

    expect(key).toBe("plugin:occupancy-board");
    expect(parseProcessorKey(key)).toEqual({
      kind: "PLUGIN",
      pluginId: "occupancy-board",
    });
  });

  it("round trips a board-recorded recipient", () => {
    const key = externalProcessorKey("clx123abc");

    expect(key).toBe("external:clx123abc");
    expect(parseProcessorKey(key)).toEqual({
      kind: "EXTERNAL",
      id: "clx123abc",
    });
  });

  it("round trips a connected app, whatever generated its row id", () => {
    /*
     * The row id rather than the client id, because a client registering
     * through its metadata document presents a URL as its client id and a URL
     * is not a path segment. The key is addressed on the route that records a
     * classification, which is the only thing a key is for.
     */
    const key = connectedAppProcessorKey("Xk3-9_aZ");

    expect(key).toBe("connectedApp:Xk3-9_aZ");
    expect(parseProcessorKey(key)).toEqual({
      // A recipient outside the instance that the association never engaged,
      // which is what EXTERNAL names.
      kind: "EXTERNAL",
      id: "Xk3-9_aZ",
    });
  });

  it.each(["smtp", "sms", "storage", "hosting"])(
    "reads the fixed key %s back as its kind",
    (key) => {
      expect(parseProcessorKey(key)).toEqual({
        kind: key.toUpperCase(),
      });
    },
  );

  it.each([
    ["a key naming nothing", "postal"],
    ["a plugin key with no id", "plugin:"],
    ["a plugin id starting with a digit", "plugin:1password"],
    ["a plugin id with an underscore", "plugin:my_plugin"],
    ["a plugin id ending in a hyphen", "plugin:occupancy-"],
    ["an uppercase plugin id", "plugin:Occupancy"],
    ["an external key with no id", "external:"],
    ["a connected app key with no id", "connectedApp:"],
    ["a connected app key holding a URL", "connectedApp:https://app.test/x"],
    ["a path traversal", "storage/../smtp"],
    ["an empty key", ""],
  ])("refuses %s", (_label, key) => {
    expect(processorKeySchema.safeParse(key).success).toBe(false);
    expect(parseProcessorKey(key)).toBeNull();
  });

  it("returns null rather than throwing, because a bad key is a 404", () => {
    // The key arrives from a URL. A request for a recipient that cannot exist
    // is an answer the controller gives, not an error the server logs.
    expect(parseProcessorKey("plugin:NOT VALID")).toBeNull();
  });
});
