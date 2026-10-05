import { describe, expect, it } from "vitest";

import { connectedAppHost, hostOf } from "./client-host";

describe("the host a connected app is named by", () => {
  it("is the client id's host for an app that registered itself", () => {
    // The discovery plugin's id is not a URL. Reading it as one named every
    // such app "unknown host".
    expect(
      connectedAppHost({
        clientId: "https://app.example/oauth/client.json",
        clientDiscoveryId: "cimd",
        uri: null,
      }),
    ).toBe("app.example");
  });

  it("is the declared address's host for an app an administrator registered", () => {
    expect(
      connectedAppHost({
        clientId: "k8d7fj3",
        clientDiscoveryId: null,
        uri: "https://egen-app.exempel.se/",
      }),
    ).toBe("egen-app.exempel.se");
  });

  it("is nothing for an address that will not parse", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(
      connectedAppHost({
        clientId: "k8d7fj3",
        clientDiscoveryId: null,
        uri: null,
      }),
    ).toBeNull();
  });
});
