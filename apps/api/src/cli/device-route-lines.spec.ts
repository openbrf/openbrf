import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { deviceRouteLines } from "./device-route-lines";

/**
 * What `openbrf plugin add` prints about a plugin's device routes: the
 * consent screen's own sentences, in the fallback locale, with the catalog's
 * paths made safe for the terminal.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

describe("deviceRouteLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints nothing for a plugin that declares no device route", () => {
    expect(deviceRouteLines([], t())).toEqual([]);
  });

  it("prints what the consent screen says, with every path", () => {
    const lines = deviceRouteLines(
      [
        { id: "screen", path: "screen" },
        { id: "pictures", path: "media/pictures" },
      ],
      t(),
    );

    expect(lines).toEqual([
      `  ${t()("plugins.consent.deviceRoutes.reach")}`,
      `  ${t()("plugins.consent.deviceRoutes.readOnly")}`,
      "  Addresses: screen, media/pictures",
    ]);
    // Translated, not the key: a missing key would print itself.
    expect(lines[0]).not.toContain("plugins.consent");
  });

  it("shows a control character in a path rather than sending it", () => {
    const [, , paths] = deviceRouteLines(
      [{ id: "screen", path: "screen\u001b[2J" }],
      t(),
    );

    expect(paths).not.toContain("\u001b");
  });
});
