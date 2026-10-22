import {
  type PluginSettingsSchema,
  pluginSettingsSchema,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ZodError } from "zod";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import {
  PluginSecretFieldError,
  PluginSettingsService,
} from "./plugin-settings.service";

/**
 * A plugin's settings with a secret field among them (ADR 0037).
 *
 * The real encryption over an in-memory pair of tables, because what is under
 * test is where a secret goes: into the plugin's hands in clear, onto the row
 * as ciphertext, and nowhere else - not into what the admin screen is given
 * and not into the audit entry.
 */

const ENCRYPTION_ENV = {
  OPENBRF_ENCRYPTION_KEY: "a".repeat(64),
} as unknown as Env;

const SCHEMA: PluginSettingsSchema = pluginSettingsSchema.parse({
  fields: [
    {
      key: "model",
      labelKey: "settings.model",
      type: "text",
      default: "claude-sonnet-5-5",
    },
    {
      key: "apiKey",
      labelKey: "settings.apiKey",
      type: "secret",
      required: true,
      maxLength: 200,
    },
    { key: "refreshToken", labelKey: "settings.refreshToken", type: "secret" },
  ],
});

const PLUGIN = "assistant";
const KEY = "sk-ant-api03-hemlig";

interface SecretRow {
  pluginId: string;
  key: string;
  valueCipher: string;
}

/** The two tables the service reads and writes, and the audit entries. */
function store() {
  const rows = {
    settings: {} as Record<string, unknown>,
    secrets: [] as SecretRow[],
  };
  const record = vi.fn(async () => undefined);

  const secretTable = {
    findMany: async ({ where }: { where: { pluginId: string } }) =>
      rows.secrets.filter((row) => row.pluginId === where.pluginId),
    deleteMany: async ({
      where,
    }: {
      where: { pluginId: string; key: string | { notIn: string[] } };
    }) => {
      rows.secrets = rows.secrets.filter(
        (row) =>
          row.pluginId !== where.pluginId ||
          (typeof where.key === "string"
            ? row.key !== where.key
            : where.key.notIn.includes(row.key)),
      );
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { pluginId_key: { pluginId: string; key: string } };
      create: SecretRow;
      update: { valueCipher: string };
    }) => {
      const held = rows.secrets.find(
        (row) =>
          row.pluginId === where.pluginId_key.pluginId &&
          row.key === where.pluginId_key.key,
      );
      if (held === undefined) {
        rows.secrets.push(create);
      } else {
        held.valueCipher = update.valueCipher;
      }
    },
  };
  const tx = {
    pluginSecretSetting: secretTable,
    installedPlugin: {
      updateMany: async ({ data }: { data: { settings: object } }) => {
        rows.settings = { ...data.settings };
      },
    },
  };
  const prisma = {
    installedPlugin: {
      findUnique: async () => ({
        settings: rows.settings,
        secretSettings: rows.secrets,
      }),
    },
    $transaction: async (run: (client: unknown) => Promise<unknown>) =>
      await run(tx),
  };

  const service = new PluginSettingsService(
    prisma as never,
    new FieldEncryptionService(ENCRYPTION_ENV),
    { record } as never,
  );
  return { service, rows, record };
}

let built: ReturnType<typeof store>;

beforeEach(() => {
  built = store();
});

describe("a secret the board enters", () => {
  it("reaches the plugin in clear and is stored only as ciphertext", async () => {
    await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: { model: "claude-opus-5-5" }, secrets: { apiKey: KEY } },
      "person-1",
    );

    await expect(built.service.forPlugin(PLUGIN, SCHEMA)).resolves.toEqual({
      model: "claude-opus-5-5",
      apiKey: KEY,
    });
    expect(JSON.stringify(built.rows)).not.toContain(KEY);
    expect(built.rows.settings).not.toHaveProperty("apiKey");
  });

  it("is never in what the admin screen is given, only that it is set", async () => {
    const saved = await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: {}, secrets: { apiKey: KEY } },
      "person-1",
    );
    const read = await built.service.forAdmin(PLUGIN, SCHEMA);

    for (const view of [saved, read]) {
      expect(view.secretsSet).toEqual(["apiKey"]);
      expect(JSON.stringify(view)).not.toContain(KEY);
    }
    expect(read.values).toEqual({ model: "claude-sonnet-5-5" });
  });

  it("is named in the audit entry and its value is not", async () => {
    await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: { model: "claude-opus-5-5" }, secrets: { apiKey: KEY } },
      "person-1",
    );

    expect(built.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PLUGIN_SETTINGS_CHANGED",
        channel: "WEB",
        actorPersonId: "person-1",
        context: { fields: ["apiKey", "model"] },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(built.record.mock.calls)).not.toContain(KEY);
  });

  // The form never holds the value, so a save that leaves the key out keeps
  // it rather than clearing it.
  it("is kept by a save that leaves it out, and cleared by null", async () => {
    await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: {}, secrets: { apiKey: KEY, refreshToken: "rt-1" } },
      "person-1",
    );
    await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: { model: "claude-opus-5-5" }, secrets: {} },
      "person-1",
    );
    expect((await built.service.forPlugin(PLUGIN, SCHEMA)).apiKey).toBe(KEY);

    const cleared = await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: {}, secrets: { refreshToken: null } },
      "person-1",
    );
    expect(cleared.secretsSet).toEqual(["apiKey"]);
    expect(await built.service.forPlugin(PLUGIN, SCHEMA)).not.toHaveProperty(
      "refreshToken",
    );
  });

  it.each([
    ["a required secret left unset", { apiKey: undefined }],
    ["a required secret cleared", { apiKey: null }],
    ["an empty string", { apiKey: "" }],
    ["a value over its maxLength", { apiKey: "x".repeat(201) }],
    ["a key that is no secret field", { apiKey: KEY, model: "x" }],
  ])("refuses %s and writes nothing", async (_label, secrets) => {
    const submitted = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => value !== undefined),
    ) as Record<string, string | null>;

    await expect(
      built.service.writeFromAdmin(
        PLUGIN,
        SCHEMA,
        { values: {}, secrets: submitted },
        "person-1",
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(built.rows.secrets).toEqual([]);
    expect(built.record).not.toHaveBeenCalled();
  });

  // A field an upgrade turned from text into secret is not read from the
  // plain copy the older version stored.
  it("is not read from a plain value stored under its key", async () => {
    built.rows.settings = { model: "claude-opus-5-5", apiKey: KEY };

    expect(await built.service.forAdmin(PLUGIN, SCHEMA)).toEqual({
      values: { model: "claude-opus-5-5" },
      secretsSet: [],
    });
  });

  it("is let go by the next save once the plugin no longer declares it", async () => {
    await built.service.writeFromAdmin(
      PLUGIN,
      SCHEMA,
      { values: {}, secrets: { apiKey: KEY, refreshToken: "rt-1" } },
      "person-1",
    );
    const upgraded = pluginSettingsSchema.parse({
      fields: SCHEMA.fields.filter((field) => field.key !== "refreshToken"),
    });

    await built.service.writeFromAdmin(
      PLUGIN,
      upgraded,
      { values: {}, secrets: {} },
      "person-1",
    );

    expect(built.rows.secrets.map((row) => row.key)).toEqual(["apiKey"]);
  });
});

describe("a secret the plugin writes itself", () => {
  it("replaces its own secret, recorded on the plugin channel by key", async () => {
    await built.service.writeFromPlugin(PLUGIN, SCHEMA, "apiKey", KEY);
    built.record.mockClear();
    await built.service.writeFromPlugin(PLUGIN, SCHEMA, "refreshToken", "rt-2");

    expect((await built.service.forPlugin(PLUGIN, SCHEMA)).refreshToken).toBe(
      "rt-2",
    );
    expect(built.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PLUGIN_SETTINGS_CHANGED",
        channel: "PLUGIN",
        actorPersonId: null,
        targetId: PLUGIN,
        context: { fields: ["refreshToken"] },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(built.record.mock.calls)).not.toContain("rt-2");
  });

  it("clears it with null", async () => {
    await built.service.writeFromPlugin(PLUGIN, SCHEMA, "refreshToken", "rt-2");
    await built.service.writeFromPlugin(PLUGIN, SCHEMA, "refreshToken", null);

    expect(built.rows.secrets).toEqual([]);
  });

  // A plugin may keep its own credential current, and may not use that to
  // change what the board chose.
  it.each([
    ["a plain field", "model"],
    ["an undeclared key", "somethingElse"],
  ])("is refused for %s", async (_label, key) => {
    await expect(
      built.service.writeFromPlugin(PLUGIN, SCHEMA, key, "x"),
    ).rejects.toBeInstanceOf(PluginSecretFieldError);
    expect(built.record).not.toHaveBeenCalled();
  });

  it("is refused for a plugin that declares no settings", async () => {
    await expect(
      built.service.writeFromPlugin(PLUGIN, undefined, "apiKey", KEY),
    ).rejects.toBeInstanceOf(PluginSecretFieldError);
  });

  it("is held to the field's bounds", async () => {
    await expect(
      built.service.writeFromPlugin(PLUGIN, SCHEMA, "apiKey", "x".repeat(201)),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
