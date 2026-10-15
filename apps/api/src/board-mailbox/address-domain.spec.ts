import { describe, expect, it } from "vitest";

import { addressDomainIdentity } from "./address-domain";

describe("addressDomainIdentity", () => {
  it("has nothing to say about an ASCII domain", () => {
    expect(addressDomainIdentity("kalle@example.test")).toBeNull();
  });

  it("shows the punycode of a Cyrillic lookalike and flags the mixed script", () => {
    // The first letter of the domain is Cyrillic U+0435, not Latin "e".
    const lookalike = addressDomainIdentity("kalle@еxample.test");

    expect(lookalike).toEqual({
      ascii: "xn--xample-2of.test",
      mixedScript: true,
    });
    expect(lookalike?.ascii).not.toBe("example.test");
  });

  it("flags a Greek letter among Latin ones", () => {
    expect(addressDomainIdentity("kalle@exαmple.test")?.mixedScript).toBe(true);
  });

  it("accepts a legitimate Latin-script international domain without a warning", () => {
    expect(addressDomainIdentity("anna@münchen.de")).toEqual({
      ascii: "xn--mnchen-3ya.de",
      mixedScript: false,
    });
  });

  it("accepts a legitimate single-script domain without a warning", () => {
    expect(addressDomainIdentity("anna@почта.рф")).toEqual({
      ascii: "xn--80a1acny.xn--p1ai",
      mixedScript: false,
    });
  });

  it("accepts scripts that are written together", () => {
    expect(addressDomainIdentity("a@例え-shop.jp")?.mixedScript).toBe(false);
  });

  it("does not take digits and hyphens for a second script", () => {
    expect(addressDomainIdentity("a@почта-2.рф")?.mixedScript).toBe(false);
  });

  it("judges each label on its own", () => {
    expect(addressDomainIdentity("a@почта.example.рф")?.mixedScript).toBe(
      false,
    );
  });
});
