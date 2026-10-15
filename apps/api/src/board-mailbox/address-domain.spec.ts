import { describe, expect, it } from "vite-plus/test";

import { addressDomainIdentity, SCRIPT_CODES } from "./address-domain";

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

  it("reads a decomposed Latin domain as the precomposed one", () => {
    // "u" followed by U+0308 COMBINING DIAERESIS, which Latin, Cyrillic, Greek
    // and others all use.
    expect(addressDomainIdentity("anna@mu\u0308nchen.de")).toEqual({
      ascii: "xn--mnchen-3ya.de",
      mixedScript: false,
    });
  });

  it("reads a decomposed Cyrillic domain as one script", () => {
    // "и" followed by U+0306 COMBINING BREVE, which IDNA maps to "й".
    expect(addressDomainIdentity("a@и\u0306ошкар.рф")).toEqual({
      ascii: addressDomainIdentity("a@йошкар.рф")?.ascii,
      mixedScript: false,
    });
  });

  it.each(["\u3002", "\uff0e", "\uff61"])(
    "takes %s for the dot it stands for",
    (dot) => {
      expect(addressDomainIdentity(`a@почта${dot}example.рф`)).toEqual({
        ascii: "xn--80a1acny.example.xn--p1ai",
        mixedScript: false,
      });
    },
  );

  it("still flags a mixed label beside an ideographic full stop", () => {
    expect(addressDomainIdentity("a@еxample\u3002test")).toEqual({
      ascii: "xn--xample-2of.test",
      mixedScript: true,
    });
  });

  it("flags a letter from any script among Latin ones", () => {
    // U+0BB2 TAMIL LETTER LA in place of the "l".
    expect(addressDomainIdentity("a@exampலe.test")).toEqual({
      ascii: "xn--exampe-mnq.test",
      mixedScript: true,
    });
  });

  it("accepts a legitimate domain in a script beyond the common ones", () => {
    expect(addressDomainIdentity("a@இந்தியா.இந்தியா")?.mixedScript).toBe(false);
  });

  it.each([
    "example.test/é",
    "example.test?é",
    "example.test#é",
    "example.test\\é",
    "example.test%41é",
    "example.test:80é",
    "exa mple.é",
    "é.test\u0000",
  ])("does not convert %j to a shorter domain", (domain) => {
    expect(addressDomainIdentity(`a@${domain}`)?.ascii).toBeNull();
  });

  it.each([
    ["a fullwidth comma", "é.test\uff0cevil.example"],
    ["a fullwidth left parenthesis", "é.test\uff08evil.example"],
    ["a parenthesised digit", "é.test\u2474evil.example"],
    ["a parenthesised letter", "é.test\u249cevil.example"],
    ["a small comma", "é.test\ufe50evil.example"],
    ["a fullwidth equals sign", "é.test\uff1devil.example"],
    ["a fullwidth plus sign", "é.test\uff0bevil.example"],
    ["a fullwidth semicolon", "é.test\uff1bevil.example"],
    ["a fullwidth quotation mark", "é.test\uff02evil.example"],
  ])(
    "does not convert a domain that turns %s into a delimiter",
    (_n, domain) => {
      expect(addressDomainIdentity(`a@${domain}`)?.ascii).toBeNull();
    },
  );

  it("still converts domains with an underscore, a hyphen or a trailing dot", () => {
    expect(addressDomainIdentity("a@é_x-y.test")?.ascii).toBe(
      "xn--_x-y-9oa.test",
    );
    expect(addressDomainIdentity("a@é.test.")?.ascii).toBe("xn--9ca.test.");
  });

  it("knows every script of the runtime's Unicode data", () => {
    const known = SCRIPT_CODES.map((code) => String.raw`\p{sc=${code}}`).join(
      "",
    );
    const unknown = new RegExp(
      String.raw`[^${known}\p{sc=Zyyy}\p{sc=Zinh}\p{sc=Zzzz}]`,
      "u",
    );
    const missing: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (unknown.test(String.fromCodePoint(codePoint))) {
        missing.push(codePoint.toString(16));
      }
    }

    expect(missing).toEqual([]);
  });
});
