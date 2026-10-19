import { describe, expect, it } from "vite-plus/test";

import { apiOrigin, webPort } from "./dev-server";

describe("apiOrigin", () => {
  it("defaults to the API's own port", () => {
    expect(apiOrigin({})).toBe("http://localhost:3000");
  });

  it("follows PORT", () => {
    expect(apiOrigin({ PORT: "4000" })).toBe("http://localhost:4000");
  });

  it("treats a blank PORT as not set, as the API does", () => {
    expect(apiOrigin({ PORT: "" })).toBe("http://localhost:3000");
    expect(apiOrigin({ PORT: "  " })).toBe("http://localhost:3000");
  });

  it("reads PORT as a number, as the API does", () => {
    expect(apiOrigin({ PORT: "3e3" })).toBe("http://localhost:3000");
  });

  it.each(["0", "-1", "65536", "abc", "51.5"])(
    "refuses a PORT of %j rather than proxy to it",
    (value) => {
      expect(() => apiOrigin({ PORT: value })).toThrow(/^PORT/);
    },
  );

  it("lets OPENBRF_API_ORIGIN win over PORT", () => {
    expect(
      apiOrigin({ OPENBRF_API_ORIGIN: "http://api.test:9000", PORT: "4000" }),
    ).toBe("http://api.test:9000");
  });

  it("ignores a blank OPENBRF_API_ORIGIN", () => {
    expect(apiOrigin({ OPENBRF_API_ORIGIN: "", PORT: "4000" })).toBe(
      "http://localhost:4000",
    );
  });
});

describe("webPort", () => {
  it("defaults to 5173", () => {
    expect(webPort({})).toBe(5173);
  });

  it("follows OPENBRF_WEB_PORT", () => {
    expect(webPort({ OPENBRF_WEB_PORT: "5200" })).toBe(5200);
  });

  it("treats a blank OPENBRF_WEB_PORT as not set", () => {
    expect(webPort({ OPENBRF_WEB_PORT: "" })).toBe(5173);
    expect(webPort({ OPENBRF_WEB_PORT: "  " })).toBe(5173);
  });

  it.each(["0", "-1", "65536", "abc", "51.5", "5173x"])(
    "refuses %j rather than let Vite pick a port",
    (value) => {
      expect(() => webPort({ OPENBRF_WEB_PORT: value })).toThrow(
        /OPENBRF_WEB_PORT/,
      );
    },
  );
});
