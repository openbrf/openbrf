import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type PluginSettingsSchema,
  pluginSettingsSchema,
  settingsValidator,
} from "./settings-schema.ts";

function schema(fields: unknown[]): PluginSettingsSchema {
  return pluginSettingsSchema.parse({ fields });
}

describe("settingsValidator", () => {
  it("applies a declared default when the value is absent", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          default: "Hej",
        },
      ]),
    );

    expect(validator.parse({})).toEqual({ greeting: "Hej" });
  });

  it("rejects an empty string for a required text field", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          required: true,
        },
      ]),
    );

    expect(validator.safeParse({ greeting: "" }).success).toBe(false);
    expect(validator.safeParse({ greeting: "Hej" }).success).toBe(true);
  });

  it("leaves an optional field absent rather than inventing a value", () => {
    const validator = settingsValidator(
      schema([{ key: "note", labelKey: "settings.note", type: "text" }]),
    );

    expect(validator.parse({})).toEqual({});
  });

  it("enforces numeric bounds and integrality", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "limit",
          labelKey: "settings.limit",
          type: "number",
          min: 1,
          max: 10,
          integer: true,
        },
      ]),
    );

    expect(validator.safeParse({ limit: 5 }).success).toBe(true);
    expect(validator.safeParse({ limit: 0 }).success).toBe(false);
    expect(validator.safeParse({ limit: 11 }).success).toBe(false);
    expect(validator.safeParse({ limit: 5.5 }).success).toBe(false);
  });

  it("restricts a select to its declared options", () => {
    const validator = settingsValidator(
      schema([
        {
          key: "mode",
          labelKey: "settings.mode",
          type: "select",
          options: [
            { value: "compact", labelKey: "settings.mode.compact" },
            { value: "full", labelKey: "settings.mode.full" },
          ],
        },
      ]),
    );

    expect(validator.safeParse({ mode: "compact" }).success).toBe(true);
    expect(validator.safeParse({ mode: "everything" }).success).toBe(false);
  });

  /**
   * A plugin that drops a setting in a new version must not be handed the old
   * value back as something it no longer understands.
   */
  it("strips a value the schema no longer declares", () => {
    const validator = settingsValidator(
      schema([{ key: "kept", labelKey: "settings.kept", type: "boolean" }]),
    );

    expect(validator.parse({ kept: true, removed: "old" })).toEqual({
      kept: true,
    });
  });

  it("rejects a settings key that is not an identifier", () => {
    expect(
      pluginSettingsSchema.safeParse({
        fields: [{ key: "__proto__", labelKey: "a", type: "text" }],
      }).success,
    ).toBe(false);
  });
});

describe("defaultSettings", () => {
  it("returns only the fields that declare a default", () => {
    const values = defaultSettings(
      schema([
        {
          key: "greeting",
          labelKey: "settings.greeting",
          type: "text",
          default: "Hej",
        },
        { key: "note", labelKey: "settings.note", type: "text" },
        {
          key: "enabled",
          labelKey: "settings.enabled",
          type: "boolean",
          default: false,
        },
      ]),
    );

    expect(values).toEqual({ greeting: "Hej", enabled: false });
  });
});
