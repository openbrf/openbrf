import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
  pluginIdSchema,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

/**
 * The curated catalog.
 *
 * One index file listing everything an instance may install: plugins and
 * themes alike, since both are distributed the same way and the board browses
 * one screen per kind rather than one source per kind (plan section 5).
 * Delisting is a commit against the catalog, which is why an instance re-reads
 * the index rather than caching it across installs.
 *
 * Entries are parsed strictly. The index arrives over the network, and an
 * entry the instance does not fully understand is an entry it must not offer
 * to a board for consent - the consent screen's whole job is to say precisely
 * what is being agreed to.
 */

/** A tarball and the digest its bytes must hash to. */
export const catalogArtifactSchema = z.object({
  /**
   * Direct URL. https in production; file: is accepted so the end-to-end
   * harness can point at tarballs baked into the test image and exercise this
   * same verification code with no network.
   */
  url: z.string().min(1).max(2000),
  /** "sha512-<base64>" or 128 hex characters. */
  sha512: z.string().min(1).max(200),
  bytes: z.int().min(1).optional(),
});

export type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;

const localizedTextSchema = z.object({
  sv: z.string().min(1).max(500),
  en: z.string().min(1).max(500),
});

const baseEntrySchema = z.object({
  id: pluginIdSchema,
  /**
   * The npm package name the tarball unpacks as. Needed because the installer
   * writes a dependency set for npm, which keys on the package name and not on
   * the catalog id.
   */
  packageName: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  name: localizedTextSchema,
  description: localizedTextSchema,
  artifact: catalogArtifactSchema,
  homepage: z.string().max(2000).optional(),
  /** Set on an entry that is still listed but should not be installed anew. */
  deprecated: z.boolean().default(false),
});

export const catalogPluginEntrySchema = baseEntrySchema.extend({
  type: z.literal("plugin"),
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
});

/**
 * A theme entry. Themes install through the same download-and-verify path and
 * are listed in the same index; what happens after the bytes are verified is
 * the theme installer's business, not this schema's.
 */
export const catalogThemeEntrySchema = baseEntrySchema.extend({
  type: z.literal("theme"),
  /** The token contract range the theme was authored against. */
  contract: z.string().min(1).max(64).optional(),
  extends: z.string().min(1).max(64).optional(),
});

export const catalogEntrySchema = z.discriminatedUnion("type", [
  catalogPluginEntrySchema,
  catalogThemeEntrySchema,
]);

export type CatalogPluginEntry = z.infer<typeof catalogPluginEntrySchema>;
export type CatalogThemeEntry = z.infer<typeof catalogThemeEntrySchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSchema = z.object({
  /** Index format version, so a future shape can be recognised and refused. */
  version: z.literal(1),
  entries: z.array(catalogEntrySchema).max(500),
});

export type Catalog = z.infer<typeof catalogSchema>;

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "catalog-not-configured"
      | "catalog-unreachable"
      | "catalog-malformed"
      | "catalog-source-not-permitted",
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/**
 * Parses a fetched index.
 *
 * A single malformed entry rejects the whole index rather than being dropped
 * quietly. A board that installs from a catalog which silently lost an entry
 * has no way to tell that from an entry that was delisted on purpose, and the
 * two mean opposite things.
 */
export function parseCatalog(input: unknown): Catalog {
  const result = catalogSchema.safeParse(input);
  if (!result.success) {
    throw new CatalogError(
      `The catalog index is not readable:\n  ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n  ")}`,
      "catalog-malformed",
    );
  }
  return result.data;
}
