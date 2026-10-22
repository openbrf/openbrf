import { PrismaPg } from "@prisma/adapter-pg";
import {
  type PluginManifest,
  type PluginSettingsSchema,
  pluginSettingsSchema,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import type { PluginBoot } from "./plugin-boot";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginSettingsService } from "./plugin-settings.service";

/**
 * A field that became secret on an upgrade, against a real database
 * (ADR 0037).
 *
 * The value the board saved while the field was `text` sits in the settings
 * JSON of the installation. What only the database shows is that it is gone
 * from the stored row once the new manifest has loaded, and that the plain
 * settings beside it, and the secrets already held, are not.
 */

const env = loadEnvForIntegrationTests();

const suffix = process.hrtime.bigint().toString(36);
const UPGRADED = `now-secret-${suffix}`;
const PAUSED = `now-secret-paused-${suffix}`;
const PLAIN = `now-secret-plain-${suffix}`;
const INHERITED = `now-secret-inherited-${suffix}`;
const OWN = `now-secret-own-${suffix}`;
const IDS = [UPGRADED, PAUSED, PLAIN, INHERITED, OWN];

const OLD_KEY = "sk-ant-api03-gammal";

/** What the upgraded version declares: `apiKey` was a `text` field before. */
const SCHEMA: PluginSettingsSchema = pluginSettingsSchema.parse({
  fields: [
    { key: "model", labelKey: "settings.model", type: "text", default: "m" },
    { key: "apiKey", labelKey: "settings.apiKey", type: "secret" },
    { key: "token", labelKey: "settings.token", type: "secret" },
  ],
});

/** Keys every object inherits, which a declaration may still use. */
const PROTOTYPE_SCHEMA: PluginSettingsSchema = pluginSettingsSchema.parse({
  fields: [
    { key: "model", labelKey: "settings.model", type: "text", default: "m" },
    { key: "constructor", labelKey: "settings.constructor", type: "secret" },
    { key: "toString", labelKey: "settings.toString", type: "secret" },
  ],
});

let prisma: PrismaClient;
let settings: PluginSettingsService;

function manifest(id: string, schema: PluginSettingsSchema): PluginManifest {
  return {
    id,
    deviceRoutes: [],
    settingsSchema: schema,
  } as unknown as PluginManifest;
}

/** A loader holding the given manifests as serving plugins. */
function loaderServing(manifests: PluginManifest[]): PluginLoaderService {
  const boot = {
    plugins: manifests.map((each) => ({ id: each.id, manifest: each })),
    dormant: new Map<string, PluginManifest>(),
  } as unknown as PluginBoot;
  return new PluginLoaderService(
    boot,
    {} as never,
    {} as never,
    {} as never,
    { revokeUndeclaredRoutes: async () => 0 } as never,
    settings,
  );
}

async function storedSettings(id: string): Promise<unknown> {
  const row = await prisma.installedPlugin.findUniqueOrThrow({
    where: { id },
    select: { settings: true },
  });
  return row.settings;
}

function entriesFor(id: string) {
  return prisma.auditLogEntry.findMany({
    where: { targetId: id, action: "PLUGIN_SETTINGS_CHANGED" },
  });
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  const client = prisma as unknown as PrismaService;
  settings = new PluginSettingsService(
    client,
    new FieldEncryptionService(env),
    new AuditLogService(client),
  );

  await prisma.installedPlugin.createMany({
    data: IDS.map((id) => ({
      id,
      packageName: `@example/${id}`,
      version: "2.0.0",
      checksum: "sha512-test",
      consentedPermissions: [],
      declaredPersonalData: [],
      settings: { model: "kept", apiKey: OLD_KEY, retired: "also kept" },
    })),
  });
  await prisma.installedPlugin.updateMany({
    where: { id: INHERITED },
    data: { settings: { model: "kept" } },
  });
  await prisma.installedPlugin.updateMany({
    where: { id: OWN },
    data: { settings: { model: "kept", constructor: OLD_KEY } },
  });
});

afterAll(async () => {
  // The entries stay: the audit log is append-only, and their target is a
  // plugin id no other run uses.
  await prisma.installedPlugin.deleteMany({ where: { id: { in: IDS } } });
  await prisma.$disconnect();
});

describe("a setting that an upgrade turned into a secret", () => {
  it("is removed from the stored settings when the new manifest loads", async () => {
    await loaderServing([manifest(UPGRADED, SCHEMA)]).onApplicationBootstrap();

    expect(await storedSettings(UPGRADED)).toEqual({
      model: "kept",
      retired: "also kept",
    });
  });

  it("is recorded by key and never by value", async () => {
    const entries = await entriesFor(UPGRADED);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      channel: "SYSTEM",
      actorPersonId: null,
      context: { fields: ["apiKey"] },
    });
    expect(JSON.stringify(entries[0]?.context)).not.toContain(OLD_KEY);
  });

  it("leaves nothing to remove, and no second entry, at the next boot", async () => {
    await loaderServing([manifest(UPGRADED, SCHEMA)]).onApplicationBootstrap();

    expect(await storedSettings(UPGRADED)).toEqual({
      model: "kept",
      retired: "also kept",
    });
    expect(await entriesFor(UPGRADED)).toHaveLength(1);
  });

  it("is kept for a plugin that is not serving", async () => {
    // Serving UPGRADED only, which is what the loader holds when PAUSED is
    // switched off or refused at boot.
    await loaderServing([manifest(UPGRADED, SCHEMA)]).onApplicationBootstrap();

    expect(await storedSettings(PAUSED)).toMatchObject({ apiKey: OLD_KEY });
    expect(await entriesFor(PAUSED)).toHaveLength(0);
  });

  it("is kept where the field is still a plain one", async () => {
    const unchanged = pluginSettingsSchema.parse({
      fields: [
        { key: "model", labelKey: "settings.model", type: "text" },
        { key: "apiKey", labelKey: "settings.apiKey", type: "text" },
      ],
    });

    expect(await settings.stripNowSecret(PLAIN, unchanged)).toEqual([]);
    expect(await storedSettings(PLAIN)).toMatchObject({ apiKey: OLD_KEY });
    expect(await entriesFor(PLAIN)).toHaveLength(0);
  });

  it("takes a key the object only inherits for no stored value", async () => {
    expect(await settings.stripNowSecret(INHERITED, PROTOTYPE_SCHEMA)).toEqual(
      [],
    );
    expect(await settings.stripNowSecret(INHERITED, PROTOTYPE_SCHEMA)).toEqual(
      [],
    );

    expect(await storedSettings(INHERITED)).toEqual({ model: "kept" });
    expect(await entriesFor(INHERITED)).toHaveLength(0);
  });

  it("removes a stored key named like an inherited one once, and records it once", async () => {
    expect(await settings.stripNowSecret(OWN, PROTOTYPE_SCHEMA)).toEqual([
      "constructor",
    ]);
    expect(await settings.stripNowSecret(OWN, PROTOTYPE_SCHEMA)).toEqual([]);

    expect(await storedSettings(OWN)).toEqual({ model: "kept" });
    const entries = await entriesFor(OWN);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ context: { fields: ["constructor"] } });
    expect(JSON.stringify(entries[0]?.context)).not.toContain(OLD_KEY);
  });
});
