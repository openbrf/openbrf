import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { residentRouteLines } from "./resident-route-lines";

/**
 * What `openbrf plugin add` prints about a plugin's resident routes: the
 * consent screen's own sentences, in the fallback locale, with the catalog's
 * titles and each route's address made safe for the terminal.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const OFFERS = {
  path: "offers",
  title: {
    sv: "Erbjuda sin parkeringsplats några dagar",
    en: "Offer your parking space for some days",
  },
};
const CLAIMS = {
  path: "claims",
  title: {
    sv: "Boka en plats som en granne erbjuder",
    en: "Claim a space a neighbour offers",
  },
};

describe("residentRouteLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints nothing for a plugin that declares no resident route", () => {
    expect(residentRouteLines("parking-share", [], t())).toEqual([]);
  });

  it("prints what the consent screen says, with every title and its address", () => {
    const lines = residentRouteLines("parking-share", [OFFERS, CLAIMS], t());

    expect(lines).toEqual([
      "  Residents can use this plugin",
      "  Any resident the address book lists to it can, without a board seat:",
      "    Offer your parking space for some days (/api/plugin/parking-share/offers)",
      "    Claim a space a neighbour offers (/api/plugin/parking-share/claims)",
      `  ${t()("plugins.consent.residentRoutes.reach")}`,
      "  It cannot read the register there.",
      `  ${t()("plugins.consent.residentRoutes.choice")}`,
    ]);
    // Translated, not the key: a missing key would print itself.
    expect(lines.join("\n")).not.toContain("plugins.consent");
  });

  it("shows a control character in a title or a path rather than sending it", () => {
    const lines = residentRouteLines(
      "parking-share",
      [
        {
          path: "offers\u001b[2J",
          title: { ...OFFERS.title, en: "Offer\u001b]8;;https://x.test\u0007" },
        },
      ],
      t(),
    );

    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).not.toContain("\u0007");
  });
});
