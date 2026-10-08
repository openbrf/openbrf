import { z } from "zod";

import { IntegrityError, parseSha512 } from "./integrity.ts";
import {
  declaredActionsSchema,
  pluginActionSchema,
  pluginIdSchema,
  pluginManifestSchema,
} from "./manifest.ts";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
} from "./permissions.ts";

/**
 * The catalog index.
 *
 * One file listing everything an instance may install: plugins and themes
 * alike, since both are distributed the same way and the board browses one
 * screen per kind rather than one source per kind. Delisting is a commit
 * against the index, which is why an instance re-reads it rather than caching
 * it across installs.
 *
 * Exported so the index is checked by the same schema wherever it is read: by
 * the instance before it offers an entry to a board, and by the catalog's own
 * check before a listing is merged.
 *
 * Entries are parsed strictly. The index arrives over the network, and an
 * entry the instance does not fully understand is an entry it must not offer
 * to a board for consent - the consent screen's whole job is to say precisely
 * what is being agreed to.
 *
 * Every object in it is strict as well: a field this version of the index does
 * not define is refused, never dropped. Dropped, a misspelled field of the
 * declaration would be replaced by its default before the consent screen or
 * any check of the manifest saw it. The index carries its version for exactly
 * this, so a new field is a new index version rather than a key an older
 * instance ignores.
 */

/** Whether `declared` is a digest `parseSha512` can read. */
function isReadableSha512(declared: string): boolean {
  try {
    parseSha512(declared);
    return true;
  } catch (error) {
    if (error instanceof IntegrityError) {
      return false;
    }
    throw error;
  }
}

/** A tarball and the digest its bytes must hash to. */
export const catalogArtifactSchema = z.strictObject({
  /**
   * Direct URL.
   *
   * https on a curated instance, and nothing else: the shape is checked here
   * but the destination is decided at fetch time, where http: and file: are
   * refused unless the instance has opted out of curation. That is what keeps
   * an entry - which is data fetched from elsewhere - from naming a `file:`
   * path and having the instance read its own disk, or a plain-http address
   * inside the network the instance sits in.
   */
  url: z.string().min(1).max(2000),
  /**
   * "sha512-<base64>" or 128 hex characters.
   *
   * Read through the same `parseSha512` the instance verifies a download with,
   * so an entry the catalog's check lets through is one the instance can read,
   * and an index with a badly spelled digest is refused by `parseCatalogIndex`
   * alone.
   */
  sha512: z.string().min(1).max(200).refine(isReadableSha512, {
    error:
      'Expected a digest written as "sha512-<base64>" or 128 hex characters.',
  }),
  bytes: z.int().min(1).optional(),
});

export type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;

/** Text a curator writes in both languages the interface is offered in. */
const localizedTextSchema = z.strictObject({
  sv: z.string().min(1).max(500),
  en: z.string().min(1).max(500),
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;

/** Strict, and `.extend()` keeps it so for both kinds of entry. */
const baseEntrySchema = z.strictObject({
  /**
   * Unique across the whole index, whatever the entry's type: an install
   * looks an entry up by id alone.
   */
  id: pluginIdSchema,
  version: z.string().min(1).max(64),
  /** The curator's text, in both languages the interface is offered in. */
  name: localizedTextSchema,
  description: localizedTextSchema,
  artifact: catalogArtifactSchema,
  homepage: z.string().max(2000).optional(),
  /** Set on an entry that is still listed but should not be installed anew. */
  deprecated: z.boolean().default(false),
});

export const catalogPluginEntrySchema = baseEntrySchema.extend({
  type: z.literal("plugin"),
  /**
   * The npm package name the tarball unpacks as. Needed because the installer
   * writes a dependency set for npm, which keys on the package name and not on
   * the catalog id.
   */
  packageName: z.string().min(1).max(214),
  /** Gated against the host's own contract version before an install starts. */
  apiVersion: z.int().min(1),
  /**
   * Repeated from the plugin's manifest so the consent screen can be shown
   * before anything is downloaded. The installed manifest is authoritative:
   * the loader compares the two and refuses a plugin that asks for more than
   * the board consented to.
   */
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(16).default([]),
  personalData: z
    .array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES))
    .max(16)
    .default([]),
  /**
   * The actions the plugin proposes, on the same terms as the two above.
   *
   * The widest part of the declaration, and so the part the consent screen
   * most needs before anything is downloaded: an action names a capability and
   * offers it to callers the board decides on.
   *
   * The manifest's own action fields and its own uniqueness rule, not a
   * second array of the same thing: the rule on the ids has to hold at
   * whichever boundary is read first, and two copies is two places for it to
   * stop holding. Read strictly here, as everything in the index is.
   */
  actions: declaredActionsSchema(pluginActionSchema.strict()).default([]),
  /**
   * The route that serves MCP, repeated on the same terms as the three above.
   *
   * Both rules about it are decided before anything is downloaded - a second
   * plugin declaring it is refused, and the reserved id `mcp-connector` may be
   * taken only by a plugin that does declare it - so the index has to carry it.
   * The manifest's own field schema rather than a second spelling of it: the
   * value becomes a URL an unauthenticated caller is pointed at, and one
   * definition of what it may contain is the point of that schema.
   */
  oauthProtectedResource: pluginManifestSchema.shape.oauthProtectedResource,
});

/**
 * A theme entry. Themes install through the same download-and-verify path and
 * are listed in the same index; what happens after the bytes are verified is
 * the theme installer's business, not this schema's.
 *
 * No package name: a theme is data read out of its archive, never an npm
 * package, and nothing that installs one keys on a package name.
 */
export const catalogThemeEntrySchema = baseEntrySchema.extend({
  type: z.literal("theme"),
  /** The token contract range the theme was authored against. */
  contract: z.string().min(1).max(64).optional(),
  /** The theme it inherits from, as its manifest names it. */
  extends: z.string().min(1).max(64).optional(),
});

export const catalogEntrySchema = z.discriminatedUnion("type", [
  catalogPluginEntrySchema,
  catalogThemeEntrySchema,
]);

export type CatalogPluginEntry = z.infer<typeof catalogPluginEntrySchema>;
export type CatalogThemeEntry = z.infer<typeof catalogThemeEntrySchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSchema = z
  .strictObject({
    /** Index format version, so a future shape can be recognised and refused. */
    version: z.literal(1),
    entries: z.array(catalogEntrySchema).max(500),
  })
  .superRefine((catalog, ctx) => {
    /*
     * An id names one entry in the whole index, not one per type. An install
     * finds its entry by id and then refuses one of the wrong type, so a theme
     * sharing a plugin's id would leave that plugin impossible to install, and
     * which of the two a board got would depend on the order of the file.
     */
    const firstIndexById = new Map<string, number>();
    for (const [index, entry] of catalog.entries.entries()) {
      const first = firstIndexById.get(entry.id);
      if (first === undefined) {
        firstIndexById.set(entry.id, index);
        continue;
      }
      ctx.addIssue({
        code: "custom",
        path: ["entries", index, "id"],
        message: `"${entry.id}" is already the id of entry ${String(first)}; an id appears once in the index`,
      });
    }
  });

export type Catalog = z.infer<typeof catalogSchema>;

export type CatalogParseResult =
  { ok: true; value: Catalog } | { ok: false; issues: readonly string[] };

/**
 * Parses a catalog index.
 *
 * A single malformed entry rejects the whole index rather than being dropped
 * quietly. A board that installs from a catalog which silently lost an entry
 * has no way to tell that from an entry that was delisted on purpose, and the
 * two mean opposite things.
 *
 * Returns a result rather than throwing, as `parsePluginPackage` does, so a
 * catalog's own check can list every problem at once.
 */
export function parseCatalogIndex(input: unknown): CatalogParseResult {
  const result = catalogSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}
