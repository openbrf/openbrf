import { Injectable } from "@nestjs/common";
import {
  defaultSettings,
  type PluginSettingsField,
  type PluginSettingsSchema,
  type PluginSettingsValues,
  secretValueValidator,
  settingsValidator,
  withoutSecretFields,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/** What the admin screen is given: no secret, only whether each is set. */
export interface PluginSettingsForAdmin {
  values: PluginSettingsValues;
  /** The keys of the declared secret fields that hold a value. */
  secretsSet: string[];
}

/**
 * The secret fields an admin save changes: a key with a string is replaced,
 * one with null is cleared, and one left out is kept as it is.
 */
export type SecretSubmission = Record<string, string | null>;

type SecretField = Extract<PluginSettingsField, { type: "secret" }>;

/**
 * A plugin's settings, the secret fields included (ADR 0037).
 *
 * The plain values are a JSON column on the installation and the secrets are
 * rows of their own, encrypted with the plugin id and the key as their
 * context. This is the one place that reads or writes either, so the rule that
 * a secret reaches the plugin and nobody else is held here: the admin screen
 * is told whether a secret is set and never what it is, the audit log is told
 * which field changed and never to what.
 *
 * Encryption at rest protects against a database dump or a backup read
 * without the instance's key (ADR 0004). It does not protect a secret from the
 * plugin it belongs to, which receives it in clear and runs in this process.
 */
@Injectable()
export class PluginSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The values `host.settings.read()` hands the plugin: the plain ones and
   * the secrets in clear, validated against the declaration with its defaults
   * applied.
   *
   * A value stored in the JSON under a key the declaration now marks secret is
   * left out, so a field an upgrade turned from `text` into `secret` is read as
   * unset until the board enters it again rather than from its plain copy.
   */
  async forPlugin(
    pluginId: string,
    schema: PluginSettingsSchema,
  ): Promise<PluginSettingsValues> {
    const row = await this.prisma.installedPlugin.findUnique({
      where: { id: pluginId },
      select: { settings: true, secretSettings: true },
    });
    const secrets = secretFields(schema);
    const values: Record<string, unknown> = {
      ...withoutKeys(storedObject(row?.settings ?? null), secrets),
    };
    for (const secret of row?.secretSettings ?? []) {
      if (secrets.has(secret.key)) {
        values[secret.key] = await this.encryption.decrypt(
          "pluginSecretSetting.value",
          secret.valueCipher,
          secretContext(pluginId, secret.key),
        );
      }
    }

    const parsed = settingsValidator(schema).safeParse(values);
    return parsed.success ? parsed.data : defaultSettings(schema);
  }

  /**
   * Removes the plain copy of every field the declaration now marks secret.
   *
   * An upgrade can turn a `text` field into a `secret` one. The value the
   * board saved before stays in the settings JSON, unencrypted, until the next
   * save of the form rewrites it. It never reaches the plugin or the admin
   * screen (see {@link forPlugin}), but it would stay in a dump or a backup
   * read without the instance's key, which the secret rows are there to
   * prevent. Run for each plugin whose manifest has loaded.
   *
   * The row is read under a lock and written in the same transaction as the
   * entry, so the removal and its record stand or fall together. A save of the
   * form racing it writes no secret key, so either order ends without one. The
   * entry names the keys removed and never a value. Only a key the stored JSON
   * holds itself counts: a field named `constructor` or `toString` is valid in
   * a declaration, and the object's inherited members are no stored value.
   *
   * @returns The keys removed from the plugin's settings, sorted.
   */
  async stripNowSecret(
    pluginId: string,
    schema: PluginSettingsSchema,
  ): Promise<string[]> {
    const keys = [...secretFields(schema).keys()];
    if (keys.length === 0) {
      return [];
    }
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue }[]>`
        SELECT settings FROM installed_plugin
        WHERE id = ${pluginId} AND jsonb_typeof(settings) = 'object'
        FOR UPDATE`;
      const stored = storedObject(rows[0]?.settings ?? null);
      const removed = keys.filter((key) => Object.hasOwn(stored, key)).sort();
      if (removed.length === 0) {
        return [];
      }
      await tx.installedPlugin.updateMany({
        where: { id: pluginId },
        data: {
          settings: withoutKeys(
            stored,
            new Map(removed.map((key) => [key, true])),
          ) as Prisma.InputJsonObject,
        },
      });
      await this.audit.record(
        {
          action: "PLUGIN_SETTINGS_CHANGED",
          channel: "SYSTEM",
          actorPersonId: null,
          targetKind: "plugin",
          targetId: pluginId,
          context: { fields: removed },
        },
        tx,
      );
      return removed;
    });
  }

  /** What the admin screen draws the form from. */
  async forAdmin(
    pluginId: string,
    schema: PluginSettingsSchema,
  ): Promise<PluginSettingsForAdmin> {
    const row = await this.prisma.installedPlugin.findUnique({
      where: { id: pluginId },
      select: { settings: true, secretSettings: { select: { key: true } } },
    });
    const secrets = secretFields(schema);
    const parsed = settingsValidator(withoutSecretFields(schema)).safeParse(
      withoutKeys(storedObject(row?.settings ?? null), secrets),
    );
    return {
      values: parsed.success ? parsed.data : {},
      secretsSet: setSecretKeys(row?.secretSettings ?? [], secrets),
    };
  }

  /**
   * The board's save.
   *
   * Throws a ZodError, which the domain exception filter answers as a 400
   * listing the failing fields, for a plain value the declaration refuses, a
   * secret it refuses, a key that is not a secret field, and a required secret
   * the save would leave unset.
   *
   * The values, the secrets and the audit entry commit together. The entry
   * names the fields written - every plain one, and each secret replaced or
   * cleared - and never a value: a setting can hold a key, and the log
   * outlives the plugin.
   */
  async writeFromAdmin(
    pluginId: string,
    schema: PluginSettingsSchema,
    submission: { values: unknown; secrets: SecretSubmission },
    actorPersonId: string,
  ): Promise<PluginSettingsForAdmin> {
    const values = settingsValidator(withoutSecretFields(schema)).parse(
      submission.values,
    );
    const secrets = secretSubmissionValidator(schema).parse(submission.secrets);
    const declared = secretFields(schema);

    return await this.prisma.$transaction(async (tx) => {
      const held = await tx.pluginSecretSetting.findMany({
        where: { pluginId },
        select: { key: true },
      });
      const setAfter = new Set(setSecretKeys(held, declared));
      for (const [key, value] of Object.entries(secrets)) {
        if (value === null) {
          setAfter.delete(key);
        } else {
          setAfter.add(key);
        }
      }
      const unset = [...declared.values()]
        .filter((field) => field.required && !setAfter.has(field.key))
        .map((field) => field.key);
      if (unset.length > 0) {
        throw new z.ZodError(
          unset.map((key) => ({
            code: "custom" as const,
            path: ["secrets", key],
            message: "a required secret has to be set",
            input: undefined,
          })),
        );
      }

      await tx.installedPlugin.updateMany({
        where: { id: pluginId },
        // Cast at the persistence boundary: the values are already validated
        // against the plugin's settingsSchema, and Prisma types a JSON column
        // with its own recursive InputJsonValue that a plain Record does not
        // satisfy.
        data: { settings: values as Prisma.InputJsonObject },
      });
      for (const [key, value] of Object.entries(secrets)) {
        await this.writeSecret(tx, pluginId, key, value ?? null);
      }
      /*
       * A secret an upgrade no longer declares, or no longer declares as
       * secret, is nothing the plugin can be handed, so the save that follows
       * the upgrade lets it go rather than keeping a credential nobody uses.
       */
      await tx.pluginSecretSetting.deleteMany({
        where: { pluginId, key: { notIn: [...declared.keys()] } },
      });

      await this.audit.record(
        {
          action: "PLUGIN_SETTINGS_CHANGED",
          channel: "WEB",
          actorPersonId,
          targetKind: "plugin",
          targetId: pluginId,
          context: {
            fields: [...Object.keys(values), ...Object.keys(secrets)].sort(),
          },
        },
        tx,
      );

      return { values, secretsSet: [...setAfter].sort() };
    });
  }

  /**
   * The plugin's own write of one of its secrets, through
   * `host.settings.writeSecret`: for a credential the far end replaces, such
   * as an OAuth refresh token that is new after every use.
   *
   * Only a field the manifest declares as secret, so a plugin cannot use this
   * to change a setting the board chose. Recorded on the plugin channel with
   * nobody as its actor, and with the field's key and nothing else.
   */
  async writeFromPlugin(
    pluginId: string,
    schema: PluginSettingsSchema | undefined,
    key: string,
    value: string | null,
  ): Promise<void> {
    const field =
      schema === undefined ? undefined : secretFields(schema).get(key);
    if (field === undefined) {
      throw new PluginSecretFieldError(pluginId, key);
    }
    const checked =
      value === null ? null : secretValueValidator(field).parse(value);

    await this.prisma.$transaction(async (tx) => {
      await this.writeSecret(tx, pluginId, key, checked);
      await this.audit.record(
        {
          action: "PLUGIN_SETTINGS_CHANGED",
          channel: "PLUGIN",
          actorPersonId: null,
          targetKind: "plugin",
          targetId: pluginId,
          context: { fields: [key] },
        },
        tx,
      );
    });
  }

  private async writeSecret(
    tx: Prisma.TransactionClient,
    pluginId: string,
    key: string,
    value: string | null,
  ): Promise<void> {
    if (value === null) {
      await tx.pluginSecretSetting.deleteMany({ where: { pluginId, key } });
      return;
    }
    const { cipher } = await this.encryption.encrypt(
      "pluginSecretSetting.value",
      value,
      secretContext(pluginId, key),
    );
    await tx.pluginSecretSetting.upsert({
      where: { pluginId_key: { pluginId, key } },
      create: { pluginId, key, valueCipher: cipher },
      update: { valueCipher: cipher },
    });
  }
}

/**
 * A plugin asked to write a secret its manifest does not declare.
 *
 * Thrown to the plugin rather than answered to a caller: only a plugin's own
 * code reaches `writeSecret`.
 */
export class PluginSecretFieldError extends Error {
  constructor(
    readonly pluginId: string,
    readonly key: string,
  ) {
    super(
      `Plugin "${pluginId}" wrote the setting "${key}", which its manifest ` +
        `does not declare as a secret field.`,
    );
    this.name = "PluginSecretFieldError";
  }
}

/**
 * The context a secret is encrypted with. A plugin id has no slash in it, so
 * no other pair of id and key composes the same context.
 */
function secretContext(pluginId: string, key: string): string {
  return `${pluginId}/${key}`;
}

function secretFields(schema: PluginSettingsSchema): Map<string, SecretField> {
  const fields = new Map<string, SecretField>();
  for (const field of schema.fields) {
    if (field.type === "secret") {
      fields.set(field.key, field);
    }
  }
  return fields;
}

/** A strict reading of the secrets a save changes. */
function secretSubmissionValidator(schema: PluginSettingsSchema) {
  const shape: Record<string, z.ZodType<string | null | undefined>> = {};
  for (const [key, field] of secretFields(schema)) {
    shape[key] = secretValueValidator(field).nullable().optional();
  }
  return z.strictObject(shape) as unknown as z.ZodType<SecretSubmission>;
}

function setSecretKeys(
  rows: readonly { key: string }[],
  declared: ReadonlyMap<string, SecretField>,
): string[] {
  return rows
    .map((row) => row.key)
    .filter((key) => declared.has(key))
    .sort();
}

function storedObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withoutKeys(
  values: Record<string, unknown>,
  keys: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !keys.has(key)),
  );
}
