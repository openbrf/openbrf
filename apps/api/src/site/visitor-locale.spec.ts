import { describe, expect, it } from "vitest";

import { visitorLocale } from "./visitor-locale";

/**
 * The public website is the one surface rendered for someone who has told us
 * nothing about themselves, so the language it chooses comes from a header a
 * browser sends and a value the association set. Both are untrusted input: the
 * header is arbitrary text off the network, and the default is a database
 * column. Neither may be able to produce anything but a locale this instance
 * has.
 */
describe("visitorLocale", () => {
  it("takes the first language the visitor asked for that we have", () => {
    expect(visitorLocale("en-GB,en;q=0.9", "sv")).toBe("en");
    expect(visitorLocale("sv-SE,sv;q=0.9,en;q=0.8", "en")).toBe("sv");
  });

  it("reads a full tag by its primary subtag", () => {
    expect(visitorLocale("sv-FI", "en")).toBe("sv");
    expect(visitorLocale("EN-US", "sv")).toBe("en");
  });

  it("skips languages this instance does not have", () => {
    // The first entry is the visitor's preference, but answering it is not an
    // option; the second one is.
    expect(visitorLocale("de-DE,de;q=0.9,sv;q=0.8", "en")).toBe("sv");
    expect(visitorLocale("*", "en")).toBe("en");
  });

  it("falls back to the association's own language", () => {
    expect(visitorLocale("de,fr", "en")).toBe("en");
    expect(visitorLocale(undefined, "en")).toBe("en");
    expect(visitorLocale("", "en")).toBe("en");
  });

  it("falls back to Swedish when the association's language is unusable", () => {
    expect(visitorLocale("de", "kl")).toBe("sv");
    expect(visitorLocale(undefined, null)).toBe("sv");
    expect(visitorLocale(undefined, undefined)).toBe("sv");
  });

  it("survives a header that is not a language list at all", () => {
    expect(visitorLocale(";;;", "sv")).toBe("sv");
    expect(visitorLocale("q=1", "en")).toBe("en");
    expect(visitorLocale(",,,", "en")).toBe("en");
    expect(visitorLocale(" ", "en")).toBe("en");
  });

  it("ignores quality values rather than sorting by them", () => {
    // With two supported languages a sort can only ever agree with the header's
    // own order, so the weight is parsed off and discarded. This pins that: the
    // lower-weighted Swedish entry comes first and wins.
    expect(visitorLocale("sv;q=0.2,en;q=0.9", "en")).toBe("sv");
  });
});
