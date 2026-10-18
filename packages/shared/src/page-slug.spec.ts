import { describe, expect, it } from "vite-plus/test";

import {
  numberedSlug,
  PAGE_SLUG_FALLBACK,
  PAGE_SLUG_MAX_LENGTH,
  slugFromTitle,
} from "./page-slug.ts";

/**
 * The address a title gives a page. The board's screen shows it while the
 * title is typed and the API stores it, so both read it from here.
 */
describe("slugFromTitle", () => {
  it.each([
    ["Om föreningen", "om-foreningen"],
    ["Årsstämma 2027", "arsstamma-2027"],
    ["Tvättstugan", "tvattstugan"],
    ["ÅÄÖ åäö", "aao-aao"],
    ["Café & bastu", "cafe-bastu"],
    ["Nøkler og ærender", "nokler-og-aerender"],
    ["  Styrelsen  ", "styrelsen"],
    ["Frågor?!", "fragor"],
    ["Parkering -- regler", "parkering-regler"],
  ])("reads %j as %j", (title, slug) => {
    expect(slugFromTitle(title)).toBe(slug);
  });

  it("gives a title with no letters or digits the fallback address", () => {
    expect(slugFromTitle("!!! ???")).toBe(PAGE_SLUG_FALLBACK);
    expect(slugFromTitle("")).toBe(PAGE_SLUG_FALLBACK);
  });

  it("cuts a long title to an address's length, at no hyphen", () => {
    const slug = slugFromTitle(`${"a".repeat(79)} b`);
    expect(slug.length).toBeLessThanOrEqual(PAGE_SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("always gives the shape the API accepts", () => {
    for (const title of ["Om oss", "Ö", "1:a maj", "x".repeat(300), "—"]) {
      expect(slugFromTitle(title)).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);
    }
  });
});

describe("numberedSlug", () => {
  it("leaves the first one as it is and numbers the rest from two", () => {
    expect(numberedSlug("styrelsen", 1)).toBe("styrelsen");
    expect(numberedSlug("styrelsen", 2)).toBe("styrelsen-2");
    expect(numberedSlug("api", 3)).toBe("api-3");
  });

  it("keeps the number when the address is already as long as it may be", () => {
    const slug = numberedSlug("a".repeat(PAGE_SLUG_MAX_LENGTH), 12);
    expect(slug).toHaveLength(PAGE_SLUG_MAX_LENGTH);
    expect(slug.endsWith("-12")).toBe(true);
  });
});
