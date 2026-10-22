import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  deviceRouteOf,
  deviceRouteOfRequest,
  patternReaches,
  resolveDeviceRoutes,
  retiredDeviceRouteOfRequest,
  setDeviceRoutes,
} from "./device-routes";

const ROUTES = resolveDeviceRoutes([
  {
    id: "signage",
    deviceRoutes: [
      { id: "screen", path: "screen" },
      { id: "pictures", path: "media/pictures" },
    ],
  },
  { id: "occupancy", deviceRoutes: [] },
]);

describe("the device routes of the loaded plugins", () => {
  it("are mounted under each plugin's own path", () => {
    expect(ROUTES).toEqual([
      {
        pluginId: "signage",
        routeId: "screen",
        path: "/api/plugin/signage/screen",
      },
      {
        pluginId: "signage",
        routeId: "pictures",
        path: "/api/plugin/signage/media/pictures",
      },
    ]);
  });

  it("cover the path and everything below it, and nothing beside it", () => {
    expect(deviceRouteOf(ROUTES, "/api/plugin/signage/screen")?.routeId).toBe(
      "screen",
    );
    expect(
      deviceRouteOf(ROUTES, "/api/plugin/signage/screen/content")?.routeId,
    ).toBe("screen");
    expect(deviceRouteOf(ROUTES, "/api/plugin/signage/screens")).toBeNull();
    expect(deviceRouteOf(ROUTES, "/api/plugin/signage/media")).toBeNull();
    expect(deviceRouteOf(ROUTES, "/api/plugin/signage")).toBeNull();
    // Another plugin's path is never this plugin's device route.
    expect(deviceRouteOf(ROUTES, "/api/plugin/occupancy/screen")).toBeNull();
  });
});

describe("the device route a request reaches", () => {
  it("reads the path as the router does, escapes decoded and the query dropped", () => {
    expect(
      deviceRouteOfRequest(ROUTES, {
        url: "/api/plugin/signage/%73creen/content?token=x",
      })?.routeId,
    ).toBe("screen");
  });

  it("keeps an escaped slash within its segment, as the router does", () => {
    for (const url of [
      "/api/plugin/signage/media%2Fpictures",
      "/api/plugin/signage/media%2fpictures",
    ]) {
      expect(deviceRouteOfRequest(ROUTES, { url }), url).toBeNull();
      // The ordinary route the router hands it to is no device route either.
      expect(
        deviceRouteOfRequest(ROUTES, {
          url,
          routeOptions: { url: "/api/plugin/signage/:id" },
        }),
        url,
      ).toBeNull();
    }
  });

  it("is none where the route the router matched could not reach it", () => {
    expect(
      deviceRouteOfRequest(ROUTES, {
        url: "/api/plugin/signage/media/pictures",
        routeOptions: { url: "/api/plugin/signage/:id" },
      }),
    ).toBeNull();
    expect(
      deviceRouteOfRequest(ROUTES, {
        url: "/api/plugin/signage/media/pictures",
        routeOptions: { url: "/api/plugin/signage/:kind/:id" },
      })?.routeId,
    ).toBe("pictures");
  });

  it("also reads the route the router matched", () => {
    expect(
      deviceRouteOfRequest(ROUTES, {
        url: "/somewhere/else",
        routeOptions: { url: "/api/plugin/signage/screen/:part" },
      })?.routeId,
    ).toBe("screen");
  });

  it("finds none on an instance with no device routes", () => {
    expect(
      deviceRouteOfRequest([], { url: "/api/plugin/signage/screen" }),
    ).toBeNull();
  });
});

describe("a path a device may still ask that takes no token", () => {
  afterEach(() => {
    setDeviceRoutes({ current: [], asked: [] });
  });

  // `screen` is declared now; `menu` was consented to and dropped since.
  const current = ROUTES.filter((route) => route.routeId === "screen");
  const asked = [
    ...current,
    ...resolveDeviceRoutes([
      { id: "signage", deviceRoutes: [{ id: "menu", path: "menu" }] },
    ]),
  ];

  it("is the dropped route's, with or without a handler there", () => {
    setDeviceRoutes({ current, asked });

    expect(
      retiredDeviceRouteOfRequest({ url: "/api/plugin/signage/menu/today" }),
    ).toMatchObject({ pluginId: "signage", routeId: "menu" });
    expect(
      retiredDeviceRouteOfRequest({
        url: "/api/plugin/signage/menu/today",
        routeOptions: { url: "/api/plugin/signage/menu/today" },
      }),
    ).toMatchObject({ routeId: "menu" });
  });

  it("is none on a current device route and on any other path", () => {
    setDeviceRoutes({ current, asked });

    expect(
      retiredDeviceRouteOfRequest({ url: "/api/plugin/signage/screen/a" }),
    ).toBeNull();
    expect(
      retiredDeviceRouteOfRequest({ url: "/api/plugin/signage/admin" }),
    ).toBeNull();
  });
});

describe("whether a mounted route could answer under a device route", () => {
  const base = "/api/plugin/signage/screen";

  it("reads plain paths segment by segment", () => {
    expect(patternReaches("/api/plugin/signage/screen", base)).toBe(true);
    expect(patternReaches("/api/plugin/signage/screen/content", base)).toBe(
      true,
    );
    expect(patternReaches("/api/plugin/signage/screens", base)).toBe(false);
    expect(patternReaches("/api/plugin/signage/admin", base)).toBe(false);
    expect(patternReaches("/api/plugin/signage", base)).toBe(false);
  });

  it("counts a parameter as any one segment and a wildcard as any rest", () => {
    expect(patternReaches("/api/plugin/signage/:id", base)).toBe(true);
    expect(patternReaches("/api/plugin/signage/:id/edit", base)).toBe(true);
    expect(patternReaches("/api/plugin/signage/*", base)).toBe(true);
    expect(patternReaches("/api/plugin/signage/admin/:id", base)).toBe(false);
  });
});
