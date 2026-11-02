import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { nonResidentCallerLines } from "./non-resident-caller-lines";

/**
 * What `openbrf plugin add` prints about the people a plugin's resident routes
 * serve who do not live here (ADR 0053): the consent screen's own sentences,
 * in the fallback locale, naming each declared class and only those.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

describe("nonResidentCallerLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints nothing for a plugin that declares no class", () => {
    expect(nonResidentCallerLines([], ["addressBook:read"], t())).toEqual([]);
  });

  it("names each declared class, in the declared order, and what holds for them", () => {
    const lines = nonResidentCallerLines(
      ["pluginAccess", "board"],
      ["addressBook:read"],
      t(),
    );

    expect(lines).toEqual([
      "  It also serves people who do not live here",
      "  On the same addresses, and held to the same rules:",
      "    people the board gives access to this plugin on their page in the address book",
      "    board members who do not live in the house",
      `  ${t()("plugins.consent.nonResidentCallers.refused")}`,
      "  The plugin can read who these people are. Outside the addresses residents use, it can read their names.",
      `  ${t()("plugins.consent.nonResidentCallers.see")}`,
    ]);
    // Translated, not the key: a missing key would print itself.
    expect(lines.join("\n")).not.toContain("plugins.consent");
    // Only the declared classes, and no word for the property manager.
    expect(lines.join("\n")).not.toContain("administrator");
    expect(lines.join("\n")).not.toContain("property manager");
  });

  it("says the plugin reads their contact details when it holds addressBook:readContact", () => {
    const lines = nonResidentCallerLines(
      ["administrator"],
      ["addressBook:readContact"],
      t(),
    );

    expect(lines).toContain(
      "  The plugin can read who these people are. Outside the addresses residents use, it can read their names, and their email addresses and phone numbers.",
    );
  });

  it("adds what the processor agreement has to say only when the property manager is declared", () => {
    const lines = nonResidentCallerLines(
      ["propertyManager"],
      ["addressBook:read"],
      t(),
    );

    expect(lines).toContain("    the property manager, an external party");
    expect(lines.at(-1)).toBe(
      `  ${t()("plugins.consent.nonResidentCallers.propertyManager")}`,
    );
    expect(lines.at(-1)).toContain("processor agreement");
  });
});
