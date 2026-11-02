import { describe, expect, it } from "vite-plus/test";

import {
  nonResidentCallersBeyondConsent,
  residentRoutesBeyondConsent,
  sameResidentRoutes,
  servedNonResidentCallers,
} from "./resident-routes-consent";

describe("residentRoutesBeyondConsent", () => {
  it("consents to nothing where the install recorded none", () => {
    expect(
      residentRoutesBeyondConsent([{ path: "offers" }, { path: "claims" }], []),
    ).toEqual(["offers", "claims"]);
  });

  it("lets through the consented routes, and a route inside one", () => {
    expect(
      residentRoutesBeyondConsent(
        [{ path: "offers" }, { path: "claims/mine" }],
        ["offers", "claims"],
      ),
    ).toEqual([]);
  });

  it("lets through a version that drops a route", () => {
    expect(
      residentRoutesBeyondConsent([{ path: "offers" }], ["offers", "claims"]),
    ).toEqual([]);
  });

  it("refuses a route added, and one moved to cover a path it did not", () => {
    expect(
      residentRoutesBeyondConsent(
        [{ path: "offers" }, { path: "claims" }],
        ["offers/mine"],
      ),
    ).toEqual(["offers", "claims"]);
  });

  it("reads a path segment by segment, not as a prefix of characters", () => {
    expect(
      residentRoutesBeyondConsent([{ path: "offersall" }], ["offers"]),
    ).toEqual(["offersall"]);
  });
});

describe("sameResidentRoutes", () => {
  const offers = {
    path: "offers",
    title: { sv: "Erbjud din plats", en: "Offer your space" },
  };
  const claims = {
    path: "claims",
    title: { sv: "Boka en plats", en: "Claim a space" },
  };

  it("compares as sets, in any order", () => {
    expect(sameResidentRoutes([offers, claims], [claims, offers])).toBe(true);
    expect(sameResidentRoutes([], [])).toBe(true);
  });

  it("tells a route added, dropped or moved apart", () => {
    expect(sameResidentRoutes([offers], [offers, claims])).toBe(false);
    expect(sameResidentRoutes([offers, claims], [offers])).toBe(false);
    expect(
      sameResidentRoutes([offers], [{ ...offers, path: "offers/all" }]),
    ).toBe(false);
  });

  it("tells a title changed in either language apart", () => {
    expect(
      sameResidentRoutes(
        [offers],
        [{ ...offers, title: { ...offers.title, en: "Offer any space" } }],
      ),
    ).toBe(false);
    expect(
      sameResidentRoutes(
        [offers],
        [{ ...offers, title: { ...offers.title, sv: "Erbjud en plats" } }],
      ),
    ).toBe(false);
  });
});

describe("nonResidentCallersBeyondConsent (ADR 0053)", () => {
  it("approves nothing where the install recorded none", () => {
    expect(
      nonResidentCallersBeyondConsent(["board", "propertyManager"], []),
    ).toEqual(["board", "propertyManager"]);
  });

  it("lets through a manifest that declares none, the approved classes, or fewer", () => {
    expect(nonResidentCallersBeyondConsent(undefined, ["board"])).toEqual([]);
    expect(
      nonResidentCallersBeyondConsent(["board"], ["board", "administrator"]),
    ).toEqual([]);
  });

  it("refuses a class added beyond the approved set", () => {
    expect(
      nonResidentCallersBeyondConsent(
        ["board", "propertyManager", "pluginAccess"],
        ["board"],
      ),
    ).toEqual(["propertyManager", "pluginAccess"]);
  });
});

describe("servedNonResidentCallers (ADR 0053)", () => {
  it("serves the declared classes the install approved, and no other", () => {
    expect(
      servedNonResidentCallers(
        ["board", "propertyManager"],
        ["propertyManager", "administrator"],
      ),
    ).toEqual(["propertyManager"]);
  });

  it("serves none for a manifest that declares none, or an install that approved none", () => {
    expect(servedNonResidentCallers(undefined, ["board"])).toEqual([]);
    expect(servedNonResidentCallers(["board"], [])).toEqual([]);
  });
});
