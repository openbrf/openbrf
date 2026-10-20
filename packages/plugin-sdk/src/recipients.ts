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

/**
 * An `https` origin: the scheme, the host and a port only where it is not 443.
 *
 * Written as the WHATWG URL parser writes an origin, so one place has one
 * spelling: `https://API.example.com:443/` and `https://api.example.com` are the
 * same recipient, and only the second is accepted. No path, because the board
 * consents to a party and not to one of its endpoints; no credentials, because
 * a manifest is published; and nothing but `https`, because what crosses the
 * connection is the association's data.
 */
export const recipientOriginSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isCanonicalHttpsOrigin, {
    error:
      'must be an https origin as a browser writes it, such as "https://api.example.com": lowercase, with no path, no trailing slash and no port 443',
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
    parsed.origin === value
  );
}

/** The host a recipient's origin names, which is what a board recognises. */
export function recipientHost(origin: string): string {
  return new WhatwgUrl(origin).host;
}

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
    .max(8)
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

/** Whether two declarations name the same recipients, as multisets. */
export function sameRecipientDeclaration(
  left: readonly Pick<PluginRecipient, "id" | "origin" | "personalData">[],
  right: readonly Pick<PluginRecipient, "id" | "origin" | "personalData">[],
): boolean {
  const a = left.map(canonicalRecipient).sort();
  const b = right.map(canonicalRecipient).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
