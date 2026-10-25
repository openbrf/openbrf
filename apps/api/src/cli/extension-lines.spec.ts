import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { extensionLines } from "./extension-lines";

/**
 * What `openbrf plugin add` prints about a plugin's extension points: the
 * consent screen's own sentences, in the fallback locale, with the catalog's
 * text made safe for the terminal.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const text = (en: string) => ({ en, sv: en });
const categories = (values: readonly string[]) => values.join("; ");

describe("extensionLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints nothing for a plugin that offers and extends nothing", () => {
    expect(
      extensionLines(
        { extensionPoints: [], extends: [], holdsToBoard: [] },
        t(),
        categories,
      ),
    ).toEqual([]);
  });

  it("prints what a host plugin's points accept", () => {
    const lines = extensionLines(
      {
        extensionPoints: [
          {
            id: "tiles",
            version: 1,
            personalData: ["name"],
            title: text("Tiles"),
            description: text("A tile on the screen."),
          },
          {
            id: "notes",
            version: 1,
            personalData: [],
            title: text("Notes"),
            description: text("A note."),
          },
        ],
        extends: [],
        holdsToBoard: [],
      },
      t(),
      categories,
    );

    expect(lines).toEqual([
      "  Tiles: A tile on the screen. Accepts name.",
      "  Notes: A note. Accepts no personal data.",
    ]);
    // Translated, not the key: a missing key would print itself.
    expect(lines.join("\n")).not.toContain("plugins.consent");
  });

  it("prints what an addon extends, and that it needs every host plugin", () => {
    const lines = extensionLines(
      {
        extensionPoints: [],
        extends: [
          {
            plugin: "host",
            point: "tiles",
            version: 1,
            personalData: ["name"],
            pluginName: text("Host"),
            pointTitle: text("Tiles"),
          },
          {
            plugin: "other-host",
            point: "notes",
            version: 1,
            personalData: [],
            pluginName: null,
            pointTitle: null,
          },
        ],
        holdsToBoard: [],
      },
      t(),
      categories,
    );

    expect(lines).toEqual([
      "  Host at Tiles, and hands it name.",
      "  other-host at notes, and hands it no personal data.",
      `  ${t()("plugins.consent.extensions.addonNote")}`,
    ]);
    expect(lines[2]).toContain("every plugin it extends");
  });

  it("names the installed plugins the install would hold to the board", () => {
    const lines = extensionLines(
      {
        extensionPoints: [],
        extends: [],
        holdsToBoard: [
          { id: "signage", name: text("Digital signage") },
          { id: "signage-weather", name: null },
        ],
      },
      t(),
      categories,
    );

    expect(lines).toEqual([
      `  ${t()("plugins.consent.extensions.holdsToBoard", {
        count: 2,
        plugins: "Digital signage, signage-weather",
      })}`,
    ]);
    expect(lines[0]).toContain("Digital signage, signage-weather");
    expect(lines[0]).toContain("only the board and the administrator");
    expect(lines[0]).not.toContain("plugins.consent");
  });

  it("says a receipt-only addon holds the plugins by recording deliveries, not by reading", () => {
    const [line] = extensionLines(
      {
        extensionPoints: [],
        extends: [],
        holdsToBoard: [{ id: "signage", name: text("Digital signage") }],
      },
      t(),
      categories,
    );

    expect(line).toContain(
      "records a delivery against a fee notice or a charge",
    );
  });

  it("words the sentence for one plugin", () => {
    const [line] = extensionLines(
      {
        extensionPoints: [],
        extends: [],
        holdsToBoard: [{ id: "signage", name: text("Digital signage") }],
      },
      t(),
      categories,
    );

    expect(line).toContain("routes of Digital signage that need");
    expect(line).toContain("joined to it ");
  });

  it("makes the catalog's text safe for the terminal", () => {
    const lines = extensionLines(
      {
        extensionPoints: [
          {
            id: "tiles",
            version: 1,
            personalData: [],
            title: text("Tiles\u001b]0;x\u0007"),
            description: text("one\ntwo"),
          },
        ],
        extends: [],
        holdsToBoard: [],
      },
      t(),
      categories,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\p{Cc}/u);
    expect(lines[0]).toContain("one\\ntwo");
  });
});
