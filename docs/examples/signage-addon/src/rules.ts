import type {
  ExtensionContext,
  ExtensionContributionDefinition,
  ExtensionTarget,
  PluginHost,
} from "@openbrf/plugin-sdk";
import en from "../locales/en.json";
import sv from "../locales/sv.json";

/**
 * The addon's contribution to digital signage's `source` extension point,
 * version 1: one slide with the laundry room's rules and one with its hours,
 * for every screen inside the building the board switched the addon on for.
 *
 * Digital signage defines the point's schemas and the host holds the answer
 * to them, so the two types below are this addon's own copy of what
 * docs/digital-signage.md documents, not something it imports: the module's
 * source is not public, and an addon needs nothing from it.
 */

export const SOURCE_TARGET: ExtensionTarget = {
  plugin: "signage",
  point: "source",
};

type Locale = "sv" | "en";

/** What the module sends, as far as this addon reads it. */
export interface SourceInput {
  screen: {
    /** Opaque: a key, and nothing else. */
    id: string;
    /** The address the board says the screen hangs at. */
    addressId: string | null;
    placement: "inside" | "outside";
    locale: Locale;
  };
}

export type Slide =
  | { kind: "text"; heading: string; body: string[] }
  | { kind: "table"; heading: string; columns: string[]; rows: string[][] };

export interface SourceOutput {
  slides: Slide[];
}

type Key = keyof typeof en;

const MESSAGES: Record<Locale, Record<Key, string>> = { sv, en };

/**
 * The addon's own copy, in the screen's language.
 *
 * The host gives a handler no translator: it merges the locale files into the
 * addon's namespace for the board's screens, where `titleKey` and
 * `descriptionKey` are read, and a handler reads the same files itself.
 */
function translate(
  locale: Locale,
  key: Key,
  values: Record<string, string> = {},
): string {
  return MESSAGES[locale][key].replaceAll(
    /\{\{(\w+)\}\}/g,
    (whole, name: string) => values[name] ?? whole,
  );
}

/**
 * The address the screen hangs at, as the residents write it, or null when
 * the board gave none or it is no longer one of the association's.
 *
 * Read with the addon's own permission, `addresses:read`, which the board
 * consented to when it installed the addon. That digital signage holds the
 * same permission gives the addon nothing: each plugin acts under its own.
 */
async function addressOf(
  host: PluginHost,
  addressId: string | null,
): Promise<string | null> {
  if (addressId === null) {
    return null;
  }
  const address = (await host.addresses.list()).find(
    (candidate) => candidate.id === addressId,
  );
  return address === undefined ? null : `${address.street} ${address.number}`;
}

export function rulesContribution(
  host: PluginHost,
): ExtensionContributionDefinition<SourceInput, SourceOutput> {
  return {
    titleKey: "source.title",
    descriptionKey: "source.description",
    handler: async (input: SourceInput, context: ExtensionContext) => {
      // The rules are for the residents: a screen visible from outside the
      // building gets no slides, rather than a slide saying so.
      if (input.screen.placement !== "inside") {
        return { slides: [] };
      }
      const { locale } = input.screen;
      const address = await addressOf(host, input.screen.addressId);
      // The module has stopped waiting, and a late answer is dropped anyway.
      context.signal.throwIfAborted();

      const t = (key: Key, values?: Record<string, string>): string =>
        translate(locale, key, values);
      return {
        slides: [
          {
            kind: "text",
            heading:
              address === null
                ? t("rules.heading")
                : t("rules.headingAt", { address }),
            body: [
              t("rules.book"),
              t("rules.clean"),
              t("rules.lint"),
              t("rules.late"),
            ],
          },
          {
            kind: "table",
            heading: t("hours.heading"),
            columns: [t("hours.days"), t("hours.time")],
            rows: [
              [t("hours.weekdays"), "07:00–22:00"],
              [t("hours.weekend"), "09:00–20:00"],
            ],
          },
        ],
      };
    },
  };
}
