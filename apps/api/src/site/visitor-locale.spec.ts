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

  it("answers the language asked for most, not the one written first", () => {
    // A browser normally writes its languages in descending weight, so order
    // usually agrees - but nothing requires it to, and this header asks for
    // English however it was written down.
    expect(visitorLocale("sv;q=0.2,en;q=0.9", "en")).toBe("en");
    expect(visitorLocale("en;q=0.3,sv;q=0.8", "en")).toBe("sv");
  });

  it("leaves equal weights to the order they were written in", () => {
    // Nothing separates them but the order, so that is what decides.
    expect(visitorLocale("sv;q=0.5,en;q=0.5", "en")).toBe("sv");
    expect(visitorLocale("en,sv", "sv")).toBe("en");
  });

  it("reads an entry with no weight as the strongest preference", () => {
    // An absent q is 1, so a bare tag outranks a weighted one after it.
    expect(visitorLocale("en,sv;q=0.9", "sv")).toBe("en");
    expect(visitorLocale("sv;q=0.9,en", "sv")).toBe("en");
  });

  it("reads an unparseable weight as no weight rather than as a refusal", () => {
    // The header comes from whatever software the visitor is using; answering
    // nothing because a parameter is malformed would be the worse failure.
    expect(visitorLocale("sv;q=high", "en")).toBe("sv");
  });

  it("does not fall back onto a language the header refused", () => {
    // The instance's own default is the refused one, which is the case the
    // fallback would otherwise walk straight into.
    expect(visitorLocale("sv;q=0", "sv")).toBe("en");
    expect(visitorLocale("sv;q=0,en;q=1", "sv")).toBe("en");
    expect(visitorLocale("sv;q=0.0", "sv")).toBe("en");
  });

  it("still answers in something when every language is refused", () => {
    // Nothing is left to prefer, and a page cannot be rendered in no language.
    expect(visitorLocale("sv;q=0,en;q=0", "sv")).toBe("sv");
  });
});
