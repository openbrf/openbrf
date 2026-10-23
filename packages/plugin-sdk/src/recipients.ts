import { z } from "zod";

import { localizedTextSchema } from "./localized-text.ts";
import { PLUGIN_PERSONAL_DATA_CATEGORIES } from "./permissions.ts";

/**
 * Where a plugin connects to outside the instance (ADR 0037).
 *
 * Declared in the manifest, and repeated in the catalog entry, for the reason
 * actions are: the board reads it on the install consent screen before anything
 * has been downloaded, and it is what the screen's question about where the
 * plugin sends personal data is answered from.
 *
 * A declaration rather than a fence. A backend plugin runs at full process
 * privilege (ADR 0003), so nothing here stops one opening a connection it did
 * not declare; the catalog's reading of the server bundle is what holds a
 * listed plugin to it.
 */

/** The longest origin a recipient may name. */
const RECIPIENT_ORIGIN_MAX_LENGTH = 200;

/** How many recipients a plugin may declare. */
const MAX_RECIPIENTS = 8;

/** What the joined hosts separate them with. */
const HOST_SEPARATOR = ", ";

/**
 * An `https` origin: the scheme, the host and a port only where it is not 443.
 *
 * Written as the WHATWG URL parser writes an origin, so one place has one
 * spelling: `https://API.example.com:443/` and `https://api.example.com` are the
 * same recipient, and only the second is accepted. No path, because the board
 * consents to a party and not to one of its endpoints; no credentials, because
 * a manifest is published; and nothing but `https`, because what crosses the
 * connection is the association's data. The host is a name: not an IP literal
 * or `localhost`, which name no party the board can recognise, and not a name
 * with a trailing dot, which is the same host under a second spelling.
 */
export const recipientOriginSchema = z
  .string()
  .min(1)
  .max(RECIPIENT_ORIGIN_MAX_LENGTH)
  .refine(isCanonicalHttpsOrigin, {
    error:
      'must be an https origin as a browser writes it, such as "https://api.example.com": lowercase, with no path, no trailing slash, no port 443, and a host name that is not an IP address, localhost or written with a trailing dot',
  });

/**
 * The parts of a WHATWG URL read here.
 *
 * Reached through `globalThis` rather than the DOM's or Node's types: this
 * package is compiled with neither, because it is bundled into the browser as
 * well as required by the server, and both have the same `URL`.
 */
interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  origin: string;
}

const WhatwgUrl = (
  globalThis as unknown as { URL: new (input: string) => ParsedUrl }
).URL;

function isCanonicalHttpsOrigin(value: string): boolean {
  let parsed: ParsedUrl;
  try {
    parsed = new WhatwgUrl(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.origin === value &&
    isNamedHost(parsed.hostname)
  );
}

/**
 * Whether a host is a registered-style name: not a trailing-dot spelling, an
 * IPv6 literal, a dotted IPv4 address or `localhost`. The parser has already
 * turned any other IPv4 spelling (`0x7f.1`, `2130706433`) into the dotted one.
 */
function isNamedHost(hostname: string): boolean {
  return !(
    hostname.endsWith(".") ||
    hostname.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  );
}

/** The host a recipient's origin names, which is what a board recognises. */
export function recipientHost(origin: string): string {
  return new WhatwgUrl(origin).host;
}

/**
 * The hosts of the declared recipients that receive personal data, joined.
 *
 * The answer a declaration gives to who receives the data (GDPR art.
 * 30(1)(d)): what the consent screen fills its recipient field with and what
 * the record of processing activities lists. A recipient receiving none is a
 * place the plugin connects to, not a recipient in the sense of art. 4(9), so
 * it is left out; an empty string when none receives any.
 */
export function receivingHosts(
  recipients: readonly Pick<PluginRecipient, "origin" | "personalData">[],
): string {
  return recipients
    .filter((recipient) => recipient.personalData.length > 0)
    .map((recipient) => recipientHost(recipient.origin))
    .join(HOST_SEPARATOR);
}

/**
 * The longest `receivingHosts` can be: every recipient the declaration may
 * hold, each at the longest origin less its `https://`. A field the answer is
 * written to has to take at least this, or a valid declaration fills in an
 * answer the field then refuses.
 */
export const RECEIVING_HOSTS_MAX_LENGTH =
  MAX_RECIPIENTS * (RECIPIENT_ORIGIN_MAX_LENGTH - "https://".length) +
  (MAX_RECIPIENTS - 1) * HOST_SEPARATOR.length;

export const pluginRecipientSchema = z.object({
  /** Unique in the manifest. Lowercase letters, digits and single hyphens. */
  id: z
    .string()
    .min(2)
    .max(32)
    .regex(
      /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
      "must be lowercase letters, digits and single hyphens, starting with a letter",
    ),
  origin: recipientOriginSchema,
  /** What the plugin connects there for, in Swedish and English. */
  purpose: localizedTextSchema,
  /**
   * The personal-data categories this recipient receives, from the plugin's
   * own `personalData`. Empty for a connection that carries none, such as
   * fetching a list of models or the day's exchange rates: it is declared all
   * the same, because the board is shown every place the plugin connects to.
   */
  personalData: z.array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES)).max(16),
});

export type PluginRecipient = z.infer<typeof pluginRecipientSchema>;

/**
 * The declared recipients over a given reading of one recipient.
 *
 * The manifest reads a recipient as `pluginRecipientSchema` does and the
 * catalog index reads the same fields strictly, as it reads everything. Both
 * keep the rules below, which is why the list is built here rather than
 * written twice.
 *
 * An id appears once and an origin appears once. Two declarations of one id
 * would leave the consent snapshot and the board's screen naming different
 * things by it; two of one origin would let a plugin state a narrow purpose
 * and a wide one for the same party, and a board reading the first would have
 * consented to the second.
 *
 * Undefaulted, on the terms of `declaredActionsSchema`: a manifest and a
 * catalog entry add `.default([])`, and the install request does not, so an
 * echo that left the field out is not read as consent to none.
 */
export function declaredRecipientsSchema<
  T extends z.ZodType<{ id: string; origin: string }>,
>(recipient: T) {
  return z
    .array(recipient)
    .max(MAX_RECIPIENTS)
    .superRefine((recipients, ctx) => {
      const ids = new Set<string>();
      const origins = new Set<string>();
      for (const [index, declared] of recipients.entries()) {
        if (ids.has(declared.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `two recipients are declared with the id "${declared.id}"`,
          });
        }
        if (origins.has(declared.origin)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "origin"],
            message: `two recipients are declared with the origin "${declared.origin}"`,
          });
        }
        ids.add(declared.id);
        origins.add(declared.origin);
      }
    });
}

export const pluginRecipientsSchema = declaredRecipientsSchema(
  pluginRecipientSchema,
);

/**
 * The canonical string a recipient is consented to and compared by.
 *
 * The id, the origin and the categories: what the plugin may reach and what
 * goes there. The purpose is the plugin's words for it and is shown, not
 * compared, so a republished version that rewords one is not refused for it.
 */
export function canonicalRecipient(
  recipient: Pick<PluginRecipient, "id" | "origin" | "personalData">,
): string {
  return [
    recipient.id,
    recipient.origin,
    [...recipient.personalData].sort().join("|"),
  ].join(" ");
}

/**
 * The declared recipients a consent given to `consented`, as
 * `canonicalRecipient` wrote it, does not cover.
 *
 * A recipient is covered by a consented one with the same id and origin that
 * received every category it now receives. Fewer categories are covered: the
 * plugin's data reaching that party narrowed, and the board agreed to more.
 * One more, a new id or an id moved to another origin is not.
 */
export function recipientsBeyondConsent<
  T extends Pick<PluginRecipient, "id" | "origin" | "personalData">,
>(declared: readonly T[], consented: readonly string[]): T[] {
  const agreed = new Map<string, ReadonlySet<string>>();
  for (const canonical of consented) {
    // Neither an id nor a canonical origin has a space in it.
    const [id, origin, categories = ""] = canonical.split(" ");
    agreed.set(
      `${id} ${origin}`,
      new Set(categories === "" ? [] : categories.split("|")),
    );
  }
  return declared.filter((recipient) => {
    const categories = agreed.get(`${recipient.id} ${recipient.origin}`);
    return (
      categories === undefined ||
      recipient.personalData.some((category) => !categories.has(category))
    );
  });
}

/** Whether two declarations name the same recipients, as multisets. */
export function sameRecipientDeclaration(
  left: readonly Pick<PluginRecipient, "id" | "origin" | "personalData">[],
  right: readonly Pick<PluginRecipient, "id" | "origin" | "personalData">[],
): boolean {
  const a = left.map(canonicalRecipient).sort();
  const b = right.map(canonicalRecipient).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The recipients' categories that are not among the ones the plugin declares
 * it handles, as issues at the path of each.
 *
 * What a recipient receives is part of what the plugin handles. One naming a
 * category the plugin does not declare would put it on the consent screen, and
 * into the record of who receives what, without the record of processing
 * activities hearing of it. The manifest and the catalog entry repeat the same
 * two fields, so both refuse it with this rule.
 */
export function recipientCategoryIssues(
  recipients: readonly Pick<PluginRecipient, "personalData">[],
  handled: readonly string[],
): { path: (string | number)[]; message: string }[] {
  const declared = new Set<string>(handled);
  return recipients.flatMap((recipient, index) =>
    recipient.personalData.flatMap((category, at) =>
      declared.has(category)
        ? []
        : [
            {
              path: ["recipients", index, "personalData", at],
              message: `"${category}" is not among the plugin's own personalData; a recipient receives only what the plugin declares it handles`,
            },
          ],
    ),
  );
}
